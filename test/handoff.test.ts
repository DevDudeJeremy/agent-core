import { describe, it, expect } from 'vitest';
import { MockModelClient, textDelta, toolUse, stop } from '../src/testing/mock-model.js';
import { createAgentHandler } from '../src/index.js';
import { buildAgent, collectTurn, readSSE } from './harness.js';

const REASON = 'Visitor asked to speak to a person about a refund.';

const handoffScript = (input: unknown): MockModelClient =>
  new MockModelClient([
    [toolUse('t1', 'request_human_handoff', input), stop('tool_use')],
    [textDelta('A team member will follow up.'), stop('end_turn')],
  ]);

// No `tools` override anywhere in this file: escalation has to work on the default tool set.
describe('human handoff (SPEC §9.15)', () => {
  it('logs handoff_requested, sets the conversation to handed_off, and streams a handoff frame', async () => {
    const { agent, sink, hookEvents, conversations } = buildAgent(
      handoffScript({ reason: REASON }),
    );

    const frames = await collectTurn(agent, 'I want to talk to a person');
    const cid = (frames[0]!.data as { conversationId: string }).conversationId;

    // (a) handoff_requested reached the sink AND the onEvent hook, carrying the reason.
    const requested = sink.events.filter((e) => e.type === 'handoff_requested');
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      conversationId: cid,
      payload: { reason: REASON, urgency: 'normal' },
    });
    expect(hookEvents.filter((e) => e.type === 'handoff_requested')).toEqual(requested);

    // (b) the conversation is now handed_off.
    expect((await conversations.get(cid))?.status).toBe('handed_off');

    // (c) exactly one SSE handoff frame, carrying the reason.
    expect(frames.filter((f) => f.event === 'handoff')).toEqual([
      { event: 'handoff', data: { reason: REASON } },
    ]);

    // (d) the turn carries on: the tool completes, the follow-up streams, done is terminal.
    expect(frames.filter((f) => f.event === 'tool').map((f) => f.data)).toEqual([
      { name: 'request_human_handoff', status: 'started' },
      { name: 'request_human_handoff', status: 'completed' },
    ]);
    expect(frames.at(-1)).toEqual({ event: 'done', data: { finishReason: 'end_turn' } });
  });

  it('puts the handoff frame on the wire between the tool frames, before the terminal done', async () => {
    const { agent, sink } = buildAgent(handoffScript({ reason: REASON, urgency: 'high' }));

    const res = await createAgentHandler(agent)(
      new Request('http://host/agent/chat', {
        method: 'POST',
        headers: { origin: 'https://ok.example', 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'I want to talk to a person' }),
      }),
    );
    const wire = await readSSE(res);

    expect(wire.map((f) => f.event)).toEqual(['meta', 'tool', 'handoff', 'tool', 'text', 'done']);
    expect(wire.find((f) => f.event === 'handoff')!.data).toEqual({ reason: REASON });
    // The urgency the model gave is logged for the team; it is not part of the wire frame.
    expect(sink.events.find((e) => e.type === 'handoff_requested')!.payload.urgency).toBe('high');
  });

  it('a turn with no handoff call leaves the conversation open and sends no handoff frame', async () => {
    const model = new MockModelClient([[textDelta('We open at nine.'), stop('end_turn')]]);
    const { agent, sink, conversations } = buildAgent(model);

    const frames = await collectTurn(agent, 'what are your hours?');
    const cid = (frames[0]!.data as { conversationId: string }).conversationId;

    expect((await conversations.get(cid))?.status).toBe('open');
    expect(frames.some((f) => f.event === 'handoff')).toBe(false);
    expect(sink.events.some((e) => e.type === 'handoff_requested')).toBe(false);
  });

  it('a different tool running does not hand off', async () => {
    const model = new MockModelClient([
      [toolUse('t1', 'capture_lead', { email: 'ada@x.com' }), stop('tool_use')],
      [textDelta('Thanks, we will be in touch.'), stop('end_turn')],
    ]);
    const { agent, sink, conversations } = buildAgent(model);

    const frames = await collectTurn(agent, 'email me at ada@x.com');
    const cid = (frames[0]!.data as { conversationId: string }).conversationId;

    expect(sink.events.some((e) => e.type === 'lead_captured')).toBe(true); // the tool did run
    expect((await conversations.get(cid))?.status).toBe('open');
    expect(frames.some((f) => f.event === 'handoff')).toBe(false);
    expect(sink.events.some((e) => e.type === 'handoff_requested')).toBe(false);
  });

  it('a handoff call with invalid input does not hand off', async () => {
    // `reason` is required and must be non-empty.
    const { agent, sink, conversations } = buildAgent(handoffScript({ reason: '' }));

    const frames = await collectTurn(agent, 'hello?');
    const cid = (frames[0]!.data as { conversationId: string }).conversationId;

    // The decision first: nothing was escalated.
    expect((await conversations.get(cid))?.status).toBe('open');
    expect(frames.some((f) => f.event === 'handoff')).toBe(false);
    expect(sink.events.some((e) => e.type === 'handoff_requested')).toBe(false);
    // Then how the turn went: the tool call failed and the stream still closed cleanly.
    expect(frames.filter((f) => f.event === 'tool').map((f) => f.data)).toContainEqual({
      name: 'request_human_handoff',
      status: 'failed',
    });
    expect(frames.at(-1)).toEqual({ event: 'done', data: { finishReason: 'end_turn' } });
  });
});
