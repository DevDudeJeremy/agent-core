/**
 * book_appointment — the GATED exemplar (`gate: 'human-approval'`). The engine loop NEVER
 * invokes `run()` for a gated tool; instead it records an `approval_required` event (with
 * the input, for the human-in-the-loop record) and tells the model the request is queued.
 * Real booking wiring (e.g. Cal.com) is per-client work on top of this interface. `run()`
 * here is intentionally a no-op guard that should never be reached.
 */
import { z } from 'zod';
import { defineTool } from './types.js';

export const bookAppointment = defineTool({
  name: 'book_appointment',
  description:
    'Request an appointment booking. Every booking is confirmed by a human before it is finalized — use this to collect the visitor’s name, email, and preferred times.',
  gate: 'human-approval',
  inputSchema: z.object({
    name: z.string().min(1),
    email: z.email(),
    preferredTimes: z.array(z.string().min(1)).min(1),
  }),
  async run() {
    // Unreachable at runtime: gated tools are structurally never executed by the loop.
    return {
      ok: false,
      error: 'book_appointment is gated for human approval and is not executed automatically.',
    };
  },
});
