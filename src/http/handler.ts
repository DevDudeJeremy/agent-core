/**
 * createAgentHandler(): the entire HTTP surface as one `(Request) => Promise<Response>`.
 * Routing, CORS, rate limiting, body validation, SSE orchestration, and error JSON all
 * conform to docs/http-contract.md. No server, no platform binding — it is meant to mount
 * on Node/Workers/Vercel/Deno/Bun behind a thin adapter. Only the Node adapter
 * (examples/node-server.ts) is written and has been run.
 */
import { z } from 'zod';
import type { ResolvedAgentConfig } from '../config.js';
import { runTurn } from '../engine/conversation.js';
import { corsHeaders, isOriginAllowed } from './cors.js';
import { SlidingWindowRateLimiter, type RateLimiter } from './rate-limit.js';
import { encodeFrame, SSE_HEADERS, SSE_KEEPALIVE, SSE_KEEPALIVE_MS, type SseFrame } from './sse.js';

/**
 * Text Postgres cannot store: U+0000, and a surrogate that is not half of a pair. The `u`
 * flag makes the class read whole characters, so a well-formed pair, which is one character
 * above U+FFFF, does not match. Without the flag every such character would be refused.
 */
const UNSTORABLE = /[\u0000\uD800-\uDFFF]/u;

/** A string of the request body, refused when it holds text Postgres cannot store. */
const storable = (field: string, base: z.ZodString = z.string()): z.ZodString =>
  base.refine((s) => !UNSTORABLE.test(s), {
    message: `The ${field} field holds a character that cannot be stored as text: U+0000 or an unpaired surrogate.`,
  });

export function createAgentHandler(
  agent: ResolvedAgentConfig,
): (req: Request) => Promise<Response> {
  const limiter: RateLimiter = new SlidingWindowRateLimiter(
    agent.http.rateLimit.windowMs,
    agent.http.rateLimit.max,
  );
  const base = agent.http.basePath;

  // Every string a store writes is checked (SPEC §9.41), and the stores write all four. The
  // length checks come first, so a body they refuse keeps the answer it always had.
  const bodySchema = z.object({
    message: storable('message', z.string().min(1).max(agent.limits.maxMessageChars)),
    conversationId: z.uuid().optional(),
    page: storable('page').optional(),
    visitor: z
      .object({
        name: storable('visitor.name').optional(),
        email: storable('visitor.email').optional(),
      })
      .optional(),
  });

  const errorJson = (
    status: number,
    code: string,
    message: string,
    origin: string | null,
    extra: Record<string, string> = {},
  ): Response =>
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: {
        'content-type': 'application/json',
        ...extra,
        ...corsHeaders(origin, agent.http.allowedOrigins),
      },
    });

  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get('origin');
    try {
      return await route(req, origin);
    } catch {
      // Backstop for an unexpected pre-stream failure (contract §4: 500 server_error).
      return errorJson(500, 'server_error', 'Unexpected server error.', origin);
    }
  };

  async function route(req: Request, origin: string | null): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // GET {base}/health — no auth, no env, no CORS restriction: it is public and carries no
    // secret, so any page may read it, whatever the chat allowlist says.
    if (path === `${base}/health`) {
      if (req.method !== 'GET') {
        return errorJson(405, 'method_not_allowed', 'Use GET for the health endpoint.', origin);
      }
      return new Response(
        JSON.stringify({
          ok: true,
          version: agent.version,
          protocolVersion: agent.protocolVersion,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        },
      );
    }

    // POST {base}/chat — the conversation endpoint.
    if (path === `${base}/chat`) {
      if (req.method === 'OPTIONS') {
        if (!isOriginAllowed(origin, agent.http.allowedOrigins)) {
          return errorJson(403, 'origin_forbidden', 'Origin is not allowed.', origin);
        }
        return new Response(null, {
          status: 204,
          headers: corsHeaders(origin, agent.http.allowedOrigins),
        });
      }

      if (req.method !== 'POST') {
        return errorJson(405, 'method_not_allowed', 'Use POST to send a message.', origin);
      }

      if (!isOriginAllowed(origin, agent.http.allowedOrigins)) {
        return errorJson(403, 'origin_forbidden', 'Origin is not allowed.', origin);
      }

      const rl = limiter.check(agent.http.clientKey(req));
      if (!rl.allowed) {
        const retryAfter = Math.max(1, Math.ceil(rl.retryAfterMs / 1000)).toString();
        return errorJson(429, 'rate_limited', 'Too many requests. Please slow down.', origin, {
          'retry-after': retryAfter,
        });
      }

      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return errorJson(400, 'bad_request', 'Request body must be valid JSON.', origin);
      }

      const parsed = bodySchema.safeParse(raw);
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message ?? 'Invalid request body.';
        return errorJson(400, 'bad_request', detail, origin);
      }

      return streamResponse(agent, parsed.data, origin);
    }

    return errorJson(404, 'not_found', 'Unknown path.', origin);
  }
}

function streamResponse(
  agent: ResolvedAgentConfig,
  body: {
    message: string;
    conversationId?: string;
    page?: string;
    visitor?: { name?: string; email?: string };
  },
  origin: string | null,
): Response {
  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const enqueue = (s: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true;
        }
      };
      const sse = (frame: SseFrame): void => enqueue(encodeFrame(frame));

      keepalive = setInterval(() => enqueue(SSE_KEEPALIVE), SSE_KEEPALIVE_MS);

      runTurn({
        agent,
        message: body.message,
        conversationId: body.conversationId,
        page: body.page,
        visitor: body.visitor,
        sse,
      })
        .catch(() => {
          // Backstop only — runTurn emits its own terminal error frame on failure.
          try {
            sse({
              event: 'error',
              data: { code: 'server_error', message: 'Something went wrong.' },
            });
          } catch {
            /* stream already closed */
          }
        })
        .finally(() => {
          if (keepalive) clearInterval(keepalive);
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
    },
    cancel() {
      if (keepalive) clearInterval(keepalive);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { ...SSE_HEADERS, ...corsHeaders(origin, agent.http.allowedOrigins) },
  });
}
