/**
 * runTurn(): the bounded conversation loop (SPEC §4.1, steps 2–6). Streams SSE frames via
 * the injected `sse` callback and logs every step to the EventSink + `onEvent`.
 *
 * Two structural guarantees live here:
 *  - GATE ENFORCEMENT: a `human-approval` tool's `run()` is never called. Its input is
 *    recorded as an `approval_required` event and the model is told it is queued.
 *  - PRIVILEGED EFFECTS STAY IN THE LOOP: tools express intent through the fixed
 *    ToolContext (emit an AgentEvent only). The loop's dispatcher enacts side effects it
 *    is authorised for — e.g. a `handoff_requested` event flips the conversation to
 *    `handed_off` and emits the SSE `handoff` frame.
 */
import type { ResolvedAgentConfig } from '../config.js';
import type { ChatMessage, ContentBlock, ToolResultBlock } from './model.js';
import type { AgentEvent } from './events.js';
import { makeEvent } from './events.js';
import type { VisitorInfo } from '../stores/types.js';
import type { SseFrame } from '../http/sse.js';
import type { ToolResult } from '../tools/types.js';
import { toJsonSchemaTool } from '../tools/types.js';
import { retrieve } from '../rag/retrieve.js';
import { buildSystemPrompt, formatContextBlock } from '../prompts/system.js';

export interface RunTurnParams {
  agent: ResolvedAgentConfig;
  message: string;
  conversationId?: string;
  page?: string;
  visitor?: VisitorInfo;
  sse: (frame: SseFrame) => void;
}

export async function runTurn(params: RunTurnParams): Promise<void> {
  const { agent, message, sse } = params;
  const { conversations, vectorStore, embeddings, modelClient, events } = agent.runtime;
  const onEvent = agent.onEvent;
  let conversationId = '';

  // Single event dispatcher: sink + hook + the loop's authorised side effects.
  const dispatch = async (e: AgentEvent): Promise<void> => {
    await events.write(e);
    if (onEvent) await onEvent(e);
    if (e.type === 'handoff_requested') {
      await conversations.setStatus(e.conversationId, 'handed_off');
      const reason = typeof e.payload.reason === 'string' ? e.payload.reason : '';
      sse({ event: 'handoff', data: { reason } });
    }
  };

  try {
    // Step 2: load or create the conversation.
    let convo = params.conversationId ? await conversations.get(params.conversationId) : null;
    const isNew = !convo;
    if (!convo) convo = await conversations.create({ visitor: params.visitor, page: params.page });
    conversationId = convo.id;

    // meta is ALWAYS the first frame.
    sse({ event: 'meta', data: { protocolVersion: 1, conversationId } });
    if (isNew) {
      await dispatch(
        makeEvent('conversation_started', conversationId, {
          visitor: params.visitor,
          page: params.page,
        }),
      );
    }

    await conversations.appendMessage(conversationId, { role: 'user', content: message });
    await dispatch(makeEvent('user_message', conversationId, { message }));

    // Step 3: RAG. Context is ephemeral — attached to the outgoing message, never persisted.
    let contextBlock = '';
    if (agent.rag.enabled) {
      const chunks = await retrieve({
        query: message,
        embeddings,
        store: vectorStore,
        topK: agent.rag.topK,
        reranker: agent.rag.reranker,
      });
      await dispatch(
        makeEvent('retrieval_performed', conversationId, {
          query: message,
          chunkIds: chunks.map((c) => c.id),
          scores: chunks.map((c) => c.score),
        }),
      );
      contextBlock = formatContextBlock(chunks);
    }

    // Step 4: compose system prompt + history window (+ ephemeral context on the last user msg).
    const system = buildSystemPrompt(agent);
    const history = await conversations.listMessages(conversationId, agent.limits.historyWindow);
    // The window is cut by count, so it can open on an assistant turn. A request should open
    // on the user's turn: drop any leading assistant messages. The newest message is always
    // the user's, so at least that one is kept.
    const opensAt = history.findIndex((m) => m.role === 'user');
    const messages: ChatMessage[] = history
      .slice(Math.max(opensAt, 0))
      .map((m) => ({ role: m.role, content: m.content }));
    if (contextBlock && messages.length > 0) {
      const last = messages[messages.length - 1]!;
      if (last.role === 'user' && typeof last.content === 'string') {
        last.content = `${contextBlock}\n\n${last.content}`;
      }
    }

    const toolSchemas = agent.tools.map(toJsonSchemaTool);

    // Step 5: the bounded loop.
    let finishReason: 'end_turn' | 'max_turns' = 'end_turn';
    let assistantText = '';
    let turn = 0;

    for (;;) {
      if (turn >= agent.limits.maxTurns) {
        finishReason = 'max_turns';
        break;
      }
      turn++;

      let turnText = '';
      let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';
      const toolUses: Array<{ id: string; name: string; input: unknown }> = [];

      for await (const ev of modelClient.stream({
        model: agent.model,
        system,
        messages,
        tools: toolSchemas,
        maxTokens: agent.maxTokens,
      })) {
        if (ev.type === 'text_delta') {
          turnText += ev.delta;
          assistantText += ev.delta;
          sse({ event: 'text', data: { delta: ev.delta } });
        } else if (ev.type === 'tool_use') {
          toolUses.push({ id: ev.id, name: ev.name, input: ev.input });
        } else if (ev.type === 'stop') {
          stopReason = ev.reason;
        }
      }

      await dispatch(
        makeEvent('model_call', conversationId, {
          model: agent.model,
          stopReason,
          usage: undefined,
        }),
      );

      // Record the assistant turn (text + any tool_use) into the working message list.
      const assistantContent: ContentBlock[] = [];
      if (turnText) assistantContent.push({ type: 'text', text: turnText });
      for (const tu of toolUses) {
        assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
      }
      messages.push({
        role: 'assistant',
        content: assistantContent.length > 0 ? assistantContent : turnText,
      });

      if (stopReason !== 'tool_use' || toolUses.length === 0) {
        finishReason = 'end_turn';
        break;
      }

      // Run (or gate) each requested tool, collecting tool_result blocks for the next turn.
      const toolResults: ToolResultBlock[] = [];
      for (const tu of toolUses) {
        const tool = agent.tools.find((t) => t.name === tu.name);

        if (!tool) {
          sse({ event: 'tool', data: { name: tu.name, status: 'failed' } });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `Unknown tool: ${tu.name}`,
            is_error: true,
          });
          continue;
        }

        // GATE: human-approval tools are never executed. Log + inform the model.
        if (tool.gate === 'human-approval') {
          await dispatch(
            makeEvent('approval_required', conversationId, { tool: tool.name, input: tu.input }),
          );
          sse({ event: 'tool', data: { name: tool.name, status: 'pending_approval' } });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content:
              'This request has been queued for human approval. A team member will confirm and follow up.',
            is_error: false,
          });
          continue;
        }

        // gate: none — validate then execute.
        sse({ event: 'tool', data: { name: tool.name, status: 'started' } });
        const parsed = tool.inputSchema.safeParse(tu.input);
        if (!parsed.success) {
          const detail = parsed.error.issues.map((i) => i.message).join('; ');
          await dispatch(
            makeEvent('tool_executed', conversationId, {
              name: tool.name,
              input: tu.input,
              result: { ok: false, error: `invalid_input: ${detail}` },
              durationMs: 0,
            }),
          );
          sse({ event: 'tool', data: { name: tool.name, status: 'failed' } });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `Invalid input: ${detail}`,
            is_error: true,
          });
          continue;
        }

        const startedAt = Date.now();
        let result: ToolResult;
        try {
          result = await tool.run(parsed.data, { conversationId, emit: dispatch });
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        const durationMs = Date.now() - startedAt;

        await dispatch(
          makeEvent('tool_executed', conversationId, {
            name: tool.name,
            input: parsed.data,
            result,
            durationMs,
          }),
        );
        sse({
          event: 'tool',
          data: { name: tool.name, status: result.ok ? 'completed' : 'failed' },
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result.ok ? result.summary : result.error,
          is_error: !result.ok,
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }

    // Step 6: persist the assistant reply, log, terminate the stream.
    if (assistantText) {
      await conversations.appendMessage(conversationId, {
        role: 'assistant',
        content: assistantText,
      });
    }
    await dispatch(makeEvent('assistant_message', conversationId, { message: assistantText }));
    sse({ event: 'done', data: { finishReason } });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // `conversationId` is still '' when the turn failed before a conversation was loaded or
    // created. That is what gets logged: the Supabase sink stores '' as NULL, where any
    // other placeholder would be refused by the uuid column.
    const failure = makeEvent('error', conversationId, { message: detail });
    // The sink and the hook are told separately, not through dispatch(). A sink that is down
    // is a likely reason to be here, and it must not keep the hook from hearing about it.
    // Neither failure may mask the original error or the terminal frame.
    try {
      await events.write(failure);
    } catch {
      // The hook is still told, below.
    }
    try {
      if (onEvent) await onEvent(failure);
    } catch {
      // The terminal frame is still sent, below.
    }
    sse({
      event: 'error',
      data: { code: 'server_error', message: 'Something went wrong handling this message.' },
    });
  }
}
