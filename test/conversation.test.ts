import { describe, it, expect } from 'vitest';
import { MockModelClient, textDelta, toolUse, stop } from '../src/testing/mock-model.js';
import { captureLead, FeatureHashEmbeddings } from '../src/index.js';
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
