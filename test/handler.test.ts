import { describe, it, expect } from 'vitest';
import {
  createAgentHandler,
  defineAgent,
  createMemoryStores,
  MemoryEventSink,
  FeatureHashEmbeddings,
} from '../src/index.js';
import type { ConversationStore, ModelClient, ModelEvent } from '../src/index.js';
import { MockModelClient, textDelta, stop } from '../src/testing/mock-model.js';
import { readSSE } from './harness.js';

const ORIGIN = 'https://ok.example';

function makeHandler(
  model: ModelClient,
  opts: {
    rateMax?: number;
    clientKey?: (req: Request) => string;
    conversations?: ConversationStore;
  } = {},
): (req: Request) => Promise<Response> {
  const { vectorStore, conversations } = createMemoryStores();
  const agent = defineAgent({
    business: { name: 'Test Co', description: 'desc' },
    persona: { name: 'Testy', tone: 'calm' },
    rag: { enabled: false },
    http: {
      allowedOrigins: [ORIGIN],
      rateLimit: { windowMs: 60_000, max: opts.rateMax ?? 100 },
      clientKey: opts.clientKey,
    },
    runtime: {
      modelClient: model,
      embeddings: new FeatureHashEmbeddings(),
      vectorStore,
      conversations: opts.conversations ?? conversations,
      events: new MemoryEventSink(),
    },
  });
  return createAgentHandler(agent);
}

const errBody = async (res: Response): Promise<{ error: { code: string; message: string } }> =>
  (await res.json()) as { error: { code: string; message: string } };

const chatReq = (body: unknown, headers: Record<string, string> = {}): Request =>
  new Request('http://host/agent/chat', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('HTTP contract fidelity (SPEC §9.9, docs/http-contract.md)', () => {
  it('GET {base}/health → 200 {ok, version, protocolVersion}, no auth', async () => {
    const handler = makeHandler(new MockModelClient([]));
    const res = await handler(new Request('http://host/agent/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '0.1.0', protocolVersion: 1 });
  });

  it('POST {base}/chat → SSE with meta first, text, terminal done + correct headers', async () => {
    const handler = makeHandler(new MockModelClient([[textDelta('hello'), stop('end_turn')]]));
    const res = await handler(chatReq({ message: 'hi' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const frames = await readSSE(res);
    expect(frames[0]!.event).toBe('meta');
    expect(frames[0]!.data).toMatchObject({ protocolVersion: 1 });
    expect((frames[0]!.data as { conversationId: string }).conversationId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(frames.some((f) => f.event === 'text')).toBe(true);
    expect(frames.at(-1)).toEqual({ event: 'done', data: { finishReason: 'end_turn' } });
  });

  it('disallowed Origin → 403 origin_forbidden', async () => {
    const handler = makeHandler(new MockModelClient([]));
    const res = await handler(chatReq({ message: 'hi' }, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'origin_forbidden', message: expect.any(String) },
    });
  });

  it('OPTIONS preflight (allowed Origin) → 204 with CORS headers', async () => {
    const handler = makeHandler(new MockModelClient([]));
    const res = await handler(
      new Request('http://host/agent/chat', { method: 'OPTIONS', headers: { origin: ORIGIN } }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('malformed JSON → 400 bad_request', async () => {
    const handler = makeHandler(new MockModelClient([]));
    const res = await handler(chatReq('{not json'));
    expect(res.status).toBe(400);
    expect((await errBody(res)).error.code).toBe('bad_request');
  });

  it('message over 2000 chars → 400 bad_request', async () => {
    const handler = makeHandler(new MockModelClient([]));
    const res = await handler(chatReq({ message: 'x'.repeat(2001) }));
    expect(res.status).toBe(400);
    expect((await errBody(res)).error.code).toBe('bad_request');
  });

  it('GET on /chat → 405', async () => {
    const handler = makeHandler(new MockModelClient([]));
    const res = await handler(
      new Request('http://host/agent/chat', { method: 'GET', headers: { origin: ORIGIN } }),
    );
    expect(res.status).toBe(405);
  });

  it('unknown path under base → 404', async () => {
    const handler = makeHandler(new MockModelClient([]));
    const res = await handler(
      new Request('http://host/agent/nope', { headers: { origin: ORIGIN } }),
    );
    expect(res.status).toBe(404);
  });

  it('rate limit exceeded → 429 with Retry-After', async () => {
    const handler = makeHandler(new MockModelClient([[textDelta('a'), stop('end_turn')]]), {
      rateMax: 1,
    });
    const headers = { 'x-forwarded-for': '9.9.9.9' };
    const first = await handler(chatReq({ message: 'hi' }, headers));
    await first.text(); // drain
    const second = await handler(chatReq({ message: 'hi' }, headers));
    expect(second.status).toBe(429);
    expect((await errBody(second)).error.code).toBe('rate_limited');
    expect(second.headers.get('retry-after')).toBeTruthy();
  });

  it('engine throw mid-stream → SSE error frame then clean close', async () => {
    const throwing: ModelClient = {
      async *stream(): AsyncIterable<ModelEvent> {
        yield { type: 'text_delta', delta: 'partial' };
        throw new Error('boom');
      },
    };
    const handler = makeHandler(throwing);
    const res = await handler(chatReq({ message: 'hi' }));
    expect(res.status).toBe(200); // stream had already opened 200
    const frames = await readSSE(res);
    expect(frames[0]!.event).toBe('meta');
    expect(frames.at(-1)!.event).toBe('error');
    expect((frames.at(-1)!.data as { code: string }).code).toBe('server_error');
  });

  it('unexpected failure before the stream opens → 500 server_error', async () => {
    // The client key is read before any stream exists; make that step throw.
    const handler = makeHandler(new MockModelClient([]), {
      clientKey: () => {
        throw new Error('boom');
      },
    });
    const res = await handler(chatReq({ message: 'hi' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'server_error', message: expect.any(String) },
    });
  });

  it('store down before a conversation exists → 200 stream whose only frame is error', async () => {
    // The one exception to "meta first": there is no conversation id to announce.
    const down = async (): Promise<never> => {
      throw new Error('store down');
    };
    const handler = makeHandler(new MockModelClient([]), {
      conversations: {
        create: down,
        get: down,
        appendMessage: down,
        listMessages: down,
        setStatus: down,
      },
    });
    const res = await handler(chatReq({ message: 'hi' }));
    expect(res.status).toBe(200);
    const frames = await readSSE(res);
    expect(frames.map((f) => f.event)).toEqual(['error']);
    expect((frames[0]!.data as { code: string }).code).toBe('server_error');
  });
});
