/**
 * The Supabase store, driven offline. `fetch` is replaced by a stub that records each
 * request and answers the way PostgREST would, then the network kill switch is put back.
 *
 * What this proves: the order and the bodies of the requests supabase-js sends for
 * `upsertDocument` and `appendMessage`, and that an error response becomes a thrown Error.
 * What it cannot prove: that Postgres accepts any of them (the vector cast, the upsert's
 * conflict target, row-level security). Those stay on the README's list of live checks.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { createSupabaseStores, FeatureHashEmbeddings, ingestDocuments } from '../src/index.js';

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
      if (r.method === 'GET') return { status: 200, body: { content_hash: storedHash } };
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
