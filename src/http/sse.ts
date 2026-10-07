/**
 * SSE frame encoding + the response headers mandated by the contract
 * (docs/http-contract.md §2/§3). The frame union is the wire vocabulary:
 * meta first → any mix of text/tool/handoff → exactly one terminal done|error.
 */

export type SseFrame =
  | { event: 'meta'; data: { protocolVersion: 1; conversationId: string } }
  | { event: 'text'; data: { delta: string } }
  | {
      event: 'tool';
      data: { name: string; status: 'started' | 'completed' | 'failed' | 'pending_approval' };
    }
  | { event: 'handoff'; data: { reason: string } }
  | { event: 'done'; data: { finishReason: 'end_turn' | 'max_turns' } }
  | { event: 'error'; data: { code: string; message: string } };

export function encodeFrame(frame: SseFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/** Keepalive comment; EventSource parsers ignore comment lines natively. */
export const SSE_KEEPALIVE = ': ping\n\n';

/** Emitted at 15 s intervals while the model or a tool is working. */
export const SSE_KEEPALIVE_MS = 15_000;

export const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
};
