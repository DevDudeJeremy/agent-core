/**
 * The Supabase store, driven offline. `fetch` is replaced by a stub that records each
 * request and answers with canned replies, then the network kill switch is put back.
 *
 * What this proves: the order and the bodies of the requests supabase-js sends for
 * `upsertDocument`, `appendMessage` and the event sink, that an error response becomes a
 * thrown Error, and that a store which is down is tried once and given up on by a deadline.
 * What it cannot prove: that PostgREST and Postgres accept any of them. test/postgres.test.ts
 * runs the SQL side (the vector cast, the conflict target, the uuid column, row-level
 * security); the hop between the two is on the README's list of live checks.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createSupabaseStores,
  DEFAULT_STORE_TIMEOUT_MS,
  FeatureHashEmbeddings,
  ingestDocuments,
  makeEvent,
} from '../src/index.js';

interface Recorded {
  method: string;
  table: string;
  query: string;
  body: unknown;
}
type Reply = { status: number; body?: unknown };

const killSwitch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = killSwitch;
  vi.useRealTimers();
});

/** Install a recording stub. `reply` decides each response; the default is a plain success. */
function stubSupabase(reply: (r: Recorded) => Reply | undefined = () => undefined): Recorded[] {
  const calls: Recorded[] = [];
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const req = new Request(...args);
    const url = new URL(req.url);
    const text = await req.text();
    const recorded: Recorded = {
      method: req.method,
      table: url.pathname.replace('/rest/v1/', ''),
      query: decodeURIComponent(url.search),
      body: text ? JSON.parse(text) : null,
    };
    calls.push(recorded);
    const { status, body } = reply(recorded) ?? { status: req.method === 'POST' ? 201 : 204 };
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

const stores = (): ReturnType<typeof createSupabaseStores> =>
  createSupabaseStores('http://supabase.test', 'test-service-role-key');

const DOC = { sourceId: 'faq.md', title: 'FAQ', contentHash: 'a'.repeat(64) };
const CHUNKS = [{ chunkIndex: 0, content: 'We open at nine.', embedding: [0.25, -0.5] }];
const documentRow: Reply = { status: 201, body: { id: 'doc-1' } };
const pgError = (message: string): Reply => ({
  status: 400,
  body: { code: '22000', message, details: null, hint: null },
});

const hashesWritten = (calls: Recorded[]): unknown[] =>
  calls
    .filter((c) => c.table === 'agent_documents' && c.method !== 'GET')
    .map((c) => (c.body as { content_hash: string }).content_hash);

describe('Supabase store write order (SPEC §9.19)', () => {
  it('upsertDocument writes a pending marker, replaces the chunks, then the real hash', async () => {
    const calls = stubSupabase((r) =>
      r.table === 'agent_documents' && r.method === 'POST' ? documentRow : undefined,
    );

    await stores().vectorStore.upsertDocument(DOC, CHUNKS);

    expect(calls.map((c) => `${c.method} ${c.table}`)).toEqual([
      'POST agent_documents',
      'DELETE agent_chunks',
      'POST agent_chunks',
      'PATCH agent_documents',
    ]);
    // The real hash appears once, in the last request; before that only the marker.
    expect(hashesWritten(calls)).toEqual([`pending:${DOC.contentHash}`, DOC.contentHash]);
    expect(calls[1]!.query).toContain('document_id=eq.doc-1');
    expect(calls[2]!.body).toEqual([
      {
        document_id: 'doc-1',
        chunk_index: 0,
        content: 'We open at nine.',
        embedding: '[0.25,-0.5]',
        metadata: {},
      },
    ]);
    expect(calls[3]!.query).toContain('id=eq.doc-1');
  });

  it('a failed chunk insert throws and the real hash is never written', async () => {
    const calls = stubSupabase((r) => {
      if (r.table === 'agent_documents' && r.method === 'POST') return documentRow;
      if (r.table === 'agent_chunks' && r.method === 'POST') {
        return pgError('expected 1024 dimensions, not 2');
      }
      return undefined;
    });

    await expect(stores().vectorStore.upsertDocument(DOC, CHUNKS)).rejects.toThrow(
      /insert chunks.*expected 1024 dimensions/,
    );

    expect(hashesWritten(calls)).toEqual([`pending:${DOC.contentHash}`]);
  });

  it('ingest runs a document again when its stored hash is still the pending marker', async () => {
    const text = '# Hours\nWe open at nine.';
    let storedHash = '';
    const calls = stubSupabase((r) => {
      if (r.table !== 'agent_documents') return undefined;
      // The hash lookup does not ask for a single object, so PostgREST answers with a list.
      if (r.method === 'GET') {
        return { status: 200, body: storedHash ? [{ content_hash: storedHash }] : [] };
      }
      storedHash = (r.body as { content_hash: string }).content_hash;
      return r.method === 'POST' ? documentRow : undefined;
    });
    const run = (): ReturnType<typeof ingestDocuments> =>
      ingestDocuments({
        docs: [{ sourceId: 'hours.md', title: 'Hours', text }],
        embeddings: new FeatureHashEmbeddings(),
        store: stores().vectorStore,
      });

    // First ingest completes, so the stored hash is the real one and a second run skips.
    expect(await run()).toMatchObject({ ingested: 1, skipped: 0 });
    expect(await run()).toMatchObject({ ingested: 0, skipped: 1 });

    // An ingest that died after the marker was written must not be skipped.
    storedHash = `pending:${storedHash}`;
    calls.length = 0;
    expect(await run()).toMatchObject({ ingested: 1, skipped: 0 });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'DELETE', 'POST', 'PATCH']);
  });

  it('appendMessage throws when the last_active_at update fails', async () => {
    const calls = stubSupabase((r) =>
      r.table === 'agent_conversations' ? pgError('conversation row is gone') : undefined,
    );

    await expect(
      stores().conversations.appendMessage('c-1', { role: 'user', content: 'hi' }),
    ).rejects.toThrow(/touch conversation.*conversation row is gone/);

    expect(calls.map((c) => `${c.method} ${c.table}`)).toEqual([
      'POST agent_messages',
      'PATCH agent_conversations',
    ]);
  });

  it('puts the network kill switch back', async () => {
    await expect(fetch('https://example.invalid/')).rejects.toThrow(/Network access is disabled/);
  });
});

describe('the event sink (SPEC §9.27)', () => {
  it('stores an event that has no conversation as NULL, and one that has as its id', async () => {
    const calls = stubSupabase();
    const { events } = stores();
    const cid = '3f2b8c1e-6d0a-4c57-9a3e-0b1d2c3e4f5a';

    await events.write(makeEvent('error', '', { message: 'store down' }));
    await events.write(makeEvent('user_message', cid, { message: 'hi' }));

    expect(calls.map((c) => `${c.method} ${c.table}`)).toEqual([
      'POST agent_events',
      'POST agent_events',
    ]);
    // NULL fits the uuid column. test/postgres.test.ts shows Postgres taking it, and
    // refusing a placeholder that is not a uuid.
    expect(calls[0]!.body).toEqual({
      conversation_id: null,
      type: 'error',
      payload: { message: 'store down' },
    });
    expect(calls[1]!.body).toEqual({
      conversation_id: cid,
      type: 'user_message',
      payload: { message: 'hi' },
    });
  });
});

// Both tests run on the test runner's clock, so nothing here waits in real time.
describe('a store that is down (SPEC §9.29)', () => {
  it('a read that cannot connect is tried once and fails', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    const outcome = stores()
      .vectorStore.getDocumentHash('faq.md')
      .then(
        () => 'resolved',
        (err: Error) => err.message,
      );
    // Let every wait the client might have wanted run out. Retries, if there were any,
    // would all happen here.
    await vi.runAllTimersAsync();

    expect(attempts).toBe(1);
    expect(await outcome).toMatch(/getDocumentHash failed.*fetch failed/);
  });

  it('a request that never answers is abandoned at the deadline, and not before', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    // Answers only by failing when the caller gives up on it.
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      attempts++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }) as typeof fetch;

    let outcome = 'pending';
    const call = stores()
      .conversations.get('3f2b8c1e-6d0a-4c57-9a3e-0b1d2c3e4f5a')
      .then(
        () => (outcome = 'resolved'),
        (err: Error) => (outcome = err.message),
      );

    await vi.advanceTimersByTimeAsync(DEFAULT_STORE_TIMEOUT_MS - 1);
    expect(outcome).toBe('pending');

    // Asserted before `call` is awaited: with no deadline there would be nothing to await.
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toMatch(/conversation get failed/);
    await call;
    expect(attempts).toBe(1);
    expect(DEFAULT_STORE_TIMEOUT_MS).toBe(2000);
  });

  it('the deadline is the caller’s to set', async () => {
    vi.useFakeTimers();
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;
    const slow = createSupabaseStores('http://supabase.test', 'test-service-role-key', {
      timeoutMs: 60_000,
    });

    let outcome = 'pending';
    const call = slow.vectorStore.getDocumentHash('faq.md').then(
      () => (outcome = 'resolved'),
      (err: Error) => (outcome = err.message),
    );

    await vi.advanceTimersByTimeAsync(59_999);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toMatch(/getDocumentHash failed/);
    await call;
  });
});
