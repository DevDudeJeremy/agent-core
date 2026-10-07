/**
 * capture_lead — the SAFE-ACTION pattern. Ungated: validates input, records a
 * `lead_captured` event (which fires the client `onEvent` hook), returns a confirmation.
 * The zod refine requires at least one real contact channel (email or phone).
 */
import { z } from 'zod';
import { defineTool } from './types.js';
import { makeEvent } from '../engine/events.js';

export const captureLead = defineTool({
  name: 'capture_lead',
  description:
    "Record a visitor's contact details so the team can follow up. Use when the visitor asks to be contacted, shares an email or phone number, or wants a quote or callback.",
  gate: 'none',
  inputSchema: z
    .object({
      name: z.string().optional(),
      email: z.email().optional(),
      phone: z.string().optional(),
      message: z.string().optional(),
    })
    .refine((v) => Boolean(v.email || v.phone), {
      message: 'Provide at least one contact field: email or phone.',
    }),
  async run(input, ctx) {
    await ctx.emit(makeEvent('lead_captured', ctx.conversationId, { ...input }));
    const who = input.name ?? input.email ?? input.phone ?? 'the visitor';
    return {
      ok: true,
      summary: `Thanks — I've noted contact details for ${who}. Someone from the team will follow up soon.`,
    };
  },
});
