import { describe, it, expect, vi } from 'vitest';
import { MockModelClient, textDelta, toolUse, stop } from '../src/testing/mock-model.js';
import { bookAppointment, defineTool } from '../src/index.js';
import { z } from 'zod';
import { buildAgent, collectTurn } from './harness.js';

describe('gated tools (SPEC §9.5)', () => {
  it('never executes a human-approval tool, logs approval_required, and informs the model', async () => {
    const runSpy = vi.fn(async () => ({ ok: false as const, error: 'should not run' }));
    const gated = defineTool({
      name: 'book_appointment',
      description: 'gated exemplar',
      gate: 'human-approval',
      inputSchema: z.object({
        name: z.string().min(1),
        email: z.email(),
        preferredTimes: z.array(z.string()).min(1),
      }),
      run: runSpy,
    });

    const model = new MockModelClient([
      [
        toolUse('t1', 'book_appointment', {
          name: 'Ada',
          email: 'ada@x.com',
          preferredTimes: ['Tue 3pm'],
        }),
        stop('tool_use'),
      ],
      [textDelta('A team member will confirm your booking.'), stop('end_turn')],
    ]);
    const { agent, sink, hookEvents } = buildAgent(model, { tools: [gated] });

    const frames = await collectTurn(agent, 'book me for Tuesday');

    // run() was never invoked.
    expect(runSpy).not.toHaveBeenCalled();

    // approval_required reached the sink AND the onEvent hook, carrying the input.
    const approval = sink.events.find((e) => e.type === 'approval_required');
    expect(approval).toBeDefined();
    expect(approval!.payload).toMatchObject({
      tool: 'book_appointment',
      input: { email: 'ada@x.com' },
    });
    expect(hookEvents.some((e) => e.type === 'approval_required')).toBe(true);

    // SSE stream contains tool { status: 'pending_approval' }.
    expect(frames.filter((f) => f.event === 'tool')).toContainEqual({
      event: 'tool',
      data: { name: 'book_appointment', status: 'pending_approval' },
    });

    // The model's second call received the "queued for human approval" tool_result.
    expect(JSON.stringify(model.calls[1]!.messages)).toContain('queued for human approval');
  });

  it('the shipped bookAppointment exemplar is gated', () => {
    expect(bookAppointment.gate).toBe('human-approval');
  });
});
