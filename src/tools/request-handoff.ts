/**
 * request_human_handoff — the ESCALATION pattern. Ungated: emits a `handoff_requested`
 * event. The engine loop reacts to that event by setting the conversation to `handed_off`
 * and emitting an SSE `handoff` frame (privileged side effects stay in the loop; the tool
 * only expresses intent through the fixed ToolContext).
 */
import { z } from 'zod';
import { defineTool } from './types.js';
import { makeEvent } from '../engine/events.js';

export const requestHandoff = defineTool({
  name: 'request_human_handoff',
  description:
    'Escalate the conversation to a human team member. Use when the visitor asks to speak to a person, is upset, or raises something you cannot answer from the business knowledge.',
  gate: 'none',
  inputSchema: z.object({
    reason: z.string().min(1),
    urgency: z.enum(['low', 'normal', 'high']).optional(),
  }),
  async run(input, ctx) {
    await ctx.emit(
      makeEvent('handoff_requested', ctx.conversationId, {
        reason: input.reason,
        urgency: input.urgency ?? 'normal',
      }),
    );
    return {
      ok: true,
      summary: "I've flagged this for a team member — a human will follow up with you.",
    };
  },
});
