import { describe, it, expect, vi } from 'vitest';
import { MockModelClient, textDelta, toolUse, stop } from '../src/testing/mock-model.js';
import { captureLead, FeatureHashEmbeddings } from '../src/index.js';
import type { AgentEvent, ConversationStore, EventSink } from '../src/index.js';
import { buildAgent, collectTurn } from './harness.js';

describe('conversation loop (SPEC §9.4)', () => {
  it('(a) streams text deltas in order and persists the assistant message', async () => {
    const model = new MockModelClient([
      [textDelta('Hello '), textDelta('there!'), stop('end_turn')],
    ]);
    const { agent, conversations } = buildAgent(model);

    const frames = await collectTurn(agent, 'hi');

    expect(frames[0]).toEqual({
      event: 'meta',
      data: expect.objectContaining({ protocolVersion: 1 }),
    });
    const texts = frames
      .filter((f) => f.event === 'text')
      .map((f) => (f.data as { delta: string }).delta);
    expect(texts).toEqual(['Hello ', 'there!']);
    expect(frames.at(-1)).toEqual({ event: 'done', data: { finishReason: 'end_turn' } });

    const meta = frames[0]!.data as { conversationId: string };
    const stored = await conversations.listMessages(meta.conversationId, 10);
    expect(stored.at(-1)).toMatchObject({ role: 'assistant', content: 'Hello there!' });
  });

  it('(b) validates and executes a tool, then streams the follow-up text', async () => {
    const model = new MockModelClient([
      [toolUse('t1', 'capture_lead', { email: 'a@b.com', name: 'Ada' }), stop('tool_use')],
      [textDelta('Thanks, Ada!'), stop('end_turn')],
    ]);
    const { agent, sink } = buildAgent(model, { tools: [captureLead] });

    const frames = await collectTurn(agent, 'contact me at a@b.com');

    const toolFrames = frames.filter((f) => f.event === 'tool').map((f) => f.data);
    expect(toolFrames).toContainEqual({ name: 'capture_lead', status: 'started' });
    expect(toolFrames).toContainEqual({ name: 'capture_lead', status: 'completed' });
    expect(
      frames.some(
        (f) => f.event === 'text' && (f.data as { delta: string }).delta === 'Thanks, Ada!',
      ),
    ).toBe(true);
    expect(sink.events.some((e) => e.type === 'lead_captured')).toBe(true);

    // The model's second call must have received the tool_result.
    expect(JSON.stringify(model.calls[1]!.messages)).toContain('tool_result');
  });

  it('(c) invalid tool input yields ok:false without throwing and the loop continues', async () => {
    const model = new MockModelClient([
      // name only — the capture_lead refine requires email or phone.
      [toolUse('t1', 'capture_lead', { name: 'NoContact' }), stop('tool_use')],
      [textDelta('ok'), stop('end_turn')],
    ]);
    const { agent, sink } = buildAgent(model, { tools: [captureLead] });

    const frames = await collectTurn(agent, 'hi');

    expect(frames.filter((f) => f.event === 'tool')).toContainEqual({
      event: 'tool',
      data: { name: 'capture_lead', status: 'failed' },
    });
    const exec = sink.events.find((e) => e.type === 'tool_executed');
    expect(exec?.payload.result).toMatchObject({ ok: false });
    expect(
      frames.some((f) => f.event === 'text' && (f.data as { delta: string }).delta === 'ok'),
    ).toBe(true);
    expect(frames.at(-1)).toEqual({ event: 'done', data: { finishReason: 'end_turn' } });
    // run() must not have fired: no lead_captured event.
    expect(sink.events.some((e) => e.type === 'lead_captured')).toBe(false);
  });

  it('(d) a never-stopping tool script terminates at maxTurns', async () => {
    const model = new MockModelClient(
      [[toolUse('t', 'capture_lead', { email: 'a@b.com' }), stop('tool_use')]],
      { repeatLast: true },
    );
    const { agent } = buildAgent(model, { tools: [captureLead], limits: { maxTurns: 6 } });

    const frames = await collectTurn(agent, 'loop');

    expect(frames.at(-1)).toEqual({ event: 'done', data: { finishReason: 'max_turns' } });
    expect(model.calls.length).toBe(6);
  });

  it('(e) only the last historyWindow messages reach the model', async () => {
    const model = new MockModelClient([[textDelta('hi'), stop('end_turn')]]);
    const { agent, conversations } = buildAgent(model, { limits: { historyWindow: 6 } });

    const convo = await conversations.create({});
    for (let i = 0; i < 25; i++) {
      await conversations.appendMessage(convo.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${i}`,
      });
    }

    await collectTurn(agent, 'newest', convo.id);

    // The six most recent, oldest first, ending with the message just sent.
    expect(model.calls[0]!.messages.map((m) => m.content)).toEqual([
      'm20',
      'm21',
      'm22',
      'm23',
      'm24',
      'newest',
    ]);
  });

  it('(f) the window never opens on an assistant turn', async () => {
    const model = new MockModelClient([[textDelta('hi'), stop('end_turn')]]);
    const { agent, conversations } = buildAgent(model, { limits: { historyWindow: 6 } });

    // 24 stored messages ending on an assistant turn, so the last six (with the new one)
    // would be m19 (assistant), m20 … m23, newest.
    const convo = await conversations.create({});
    for (let i = 0; i < 24; i++) {
      await conversations.appendMessage(convo.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${i}`,
      });
    }

    await collectTurn(agent, 'newest', convo.id);

    const sent = model.calls[0]!.messages;
    expect(sent[0]!.role).toBe('user');
    expect(sent.map((m) => m.content)).toEqual(['m20', 'm21', 'm22', 'm23', 'newest']);
  });
});

describe('a tool the agent was not given (SPEC §9.23)', () => {
  it('is never run: nothing executes, the model is told, and the loop carries on', async () => {
    // The agent has exactly one tool. The model asks for a different one.
    const runSpy = vi.spyOn(captureLead, 'run');
    const model = new MockModelClient([
      [toolUse('t1', 'issue_refund', { amount: 500, to: 'ada@x.com' }), stop('tool_use')],
      [textDelta('I cannot do that here.'), stop('end_turn')],
    ]);
    const { agent, sink, hookEvents } = buildAgent(model, { tools: [captureLead] });

    const frames = await collectTurn(agent, 'refund me 500');
    runSpy.mockRestore();

    // The decision first: nothing ran and nothing was recorded as done, queued or escalated.
    expect(runSpy).not.toHaveBeenCalled();
    expect(sink.events.map((e) => e.type)).toEqual([
      'conversation_started',
      'user_message',
      'model_call',
      'model_call',
      'assistant_message',
    ]);
    expect(hookEvents.map((e) => e.type)).toEqual(sink.events.map((e) => e.type));

    // The model is told, in the message the next request opens its tool results with.
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: 'Unknown tool: issue_refund',
          is_error: true,
        },
      ],
    });

    // The wire says the call failed, carries no input, and the turn still ends cleanly.
    expect(frames.filter((f) => f.event === 'tool').map((f) => f.data)).toEqual([
      { name: 'issue_refund', status: 'failed' },
    ]);
    expect(JSON.stringify(frames)).not.toContain('ada@x.com');
    expect(frames.map((f) => f.event)).toEqual(['meta', 'tool', 'text', 'done']);
    expect(frames.at(-1)).toEqual({ event: 'done', data: { finishReason: 'end_turn' } });
  });

  it('a known tool in the same turn still runs, and each call gets its own answer', async () => {
    const model = new MockModelClient([
      [
        toolUse('t1', 'issue_refund', { amount: 500 }),
        toolUse('t2', 'capture_lead', { email: 'ada@x.com' }),
        stop('tool_use'),
      ],
      [textDelta('Noted.'), stop('end_turn')],
    ]);
    const { agent, sink } = buildAgent(model, { tools: [captureLead] });

    await collectTurn(agent, 'refund me, and email me at ada@x.com');

    expect(sink.events.filter((e) => e.type === 'lead_captured')).toHaveLength(1);
    const results = model.calls[1]!.messages.at(-1)!.content as Array<{
      tool_use_id: string;
      is_error?: boolean;
    }>;
    expect(results.map((r) => [r.tool_use_id, r.is_error])).toEqual([
      ['t1', true],
      ['t2', false],
    ]);
  });
});

describe('error events (SPEC §9.27)', () => {
  const down = async (): Promise<never> => {
    throw new Error('store down');
  };
  const deadStore: ConversationStore = {
    create: down,
    get: down,
    appendMessage: down,
    listMessages: down,
    setStatus: down,
  };

  it('a failure before a conversation exists is logged with no conversation id, and the hook hears it', async () => {
    const { agent, sink, hookEvents } = buildAgent(new MockModelClient([]));
    const broken = { ...agent, runtime: { ...agent.runtime, conversations: deadStore } };

    const frames = await collectTurn(broken, 'hi');

    expect(frames.map((f) => f.event)).toEqual(['error']);
    expect(sink.events).toHaveLength(1);
    // '' is what the Supabase sink turns into NULL; a made-up id would not fit a uuid column.
    expect(sink.events[0]).toMatchObject({
      type: 'error',
      conversationId: '',
      payload: { message: 'store down' },
    });
    expect(hookEvents).toEqual(sink.events);
  });

  it('the hook is told even when the sink is the thing that is down', async () => {
    const { agent, hookEvents } = buildAgent(new MockModelClient([[stop('end_turn')]]));
    const deadSink: EventSink = {
      write: async () => {
        throw new Error('sink down');
      },
    };
    const broken = { ...agent, runtime: { ...agent.runtime, events: deadSink } };

    const frames = await collectTurn(broken, 'hi');
    const cid = (frames[0]!.data as { conversationId: string }).conversationId;

    // The first event of the turn could not be written, so the turn failed...
    expect(frames.map((f) => f.event)).toEqual(['meta', 'error']);
    // ...and the hook got exactly one event: the failure, with the conversation it belongs to.
    expect(hookEvents).toHaveLength(1);
    expect(hookEvents[0]).toMatchObject({
      type: 'error',
      conversationId: cid,
      payload: { message: 'sink down' },
    });
  });

  it('a hook that throws on the error does not cost the visitor the error frame', async () => {
    const { agent, sink } = buildAgent(new MockModelClient([]));
    const seen: AgentEvent[] = [];
    const broken = {
      ...agent,
      runtime: { ...agent.runtime, conversations: deadStore },
      onEvent: (e: AgentEvent) => {
        seen.push(e);
        throw new Error('hook down');
      },
    };

    const frames = await collectTurn(broken, 'hi');

    expect(seen.map((e) => e.type)).toEqual(['error']);
    expect(sink.events.map((e) => e.type)).toEqual(['error']);
    expect(frames).toEqual([
      {
        event: 'error',
        data: { code: 'server_error', message: 'Something went wrong handling this message.' },
      },
    ]);
  });
});

describe('observability (SPEC §9.10)', () => {
  it('produces the expected AgentEvent sequence and keeps tool inputs off the wire', async () => {
    const model = new MockModelClient([
      [toolUse('t1', 'capture_lead', { email: 'secret@corp.com' }), stop('tool_use')],
      [textDelta('done'), stop('end_turn')],
    ]);
    const { agent, sink, hookEvents } = buildAgent(model, {
      tools: [captureLead],
      rag: { enabled: true },
    });

    // Seed a doc so retrieval produces a chunk.
    const [vec] = await new FeatureHashEmbeddings().embed(['contact us any time']);
    await agent.runtime.vectorStore.upsertDocument(
      { sourceId: 'faq.md', title: 'FAQ', contentHash: 'x' },
      [{ chunkIndex: 0, content: 'contact us any time', embedding: vec! }],
    );

    const frames = await collectTurn(agent, 'how do I contact you');

    expect(sink.events.map((e) => e.type)).toEqual([
      'conversation_started',
      'user_message',
      'retrieval_performed',
      'model_call',
      'lead_captured',
      'tool_executed',
      'model_call',
      'assistant_message',
    ]);
    // onEvent hook received the same events.
    expect(hookEvents.map((e) => e.type)).toEqual(sink.events.map((e) => e.type));
    // Every event carries the conversation id and an ISO timestamp.
    const cid = (frames[0]!.data as { conversationId: string }).conversationId;
    for (const e of sink.events) {
      expect(e.conversationId).toBe(cid);
      expect(new Date(e.at).toISOString()).toBe(e.at);
    }
    // SSE tool frames carry name/status only — never the raw input.
    for (const f of frames.filter((f) => f.event === 'tool')) {
      expect(Object.keys(f.data as object).sort()).toEqual(['name', 'status']);
    }
    expect(JSON.stringify(frames)).not.toContain('secret@corp.com');
  });
});
