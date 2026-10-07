import { readdirSync, readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import {
  FeatureHashEmbeddings,
  createMemoryStores,
  ingestDocuments,
  retrieve,
  RRF_CANDIDATES,
  RRF_K,
  type EmbeddingProvider,
  type IngestDoc,
  type Reranker,
} from '../src/index.js';

const embedder = new FeatureHashEmbeddings();
const embedOne = async (t: string): Promise<number[]> => (await embedder.embed([t]))[0]!;

describe('hybrid retrieval + RRF fusion (SPEC §9.8)', () => {
  it('surfaces a vector-only and a keyword-only match, fused with RRF (k=60)', async () => {
    const { vectorStore } = createMemoryStores();
    // Three docs. Query embedding derived from "alpha"; query text = "beta".
    await vectorStore.upsertDocument({ sourceId: 'a', title: 'A', contentHash: 'h' }, [
      { chunkIndex: 0, content: 'alpha alpha', embedding: await embedOne('alpha alpha') },
    ]);
    await vectorStore.upsertDocument({ sourceId: 'b', title: 'B', contentHash: 'h' }, [
      { chunkIndex: 0, content: 'beta', embedding: await embedOne('beta') },
    ]);
    await vectorStore.upsertDocument({ sourceId: 'c', title: 'C', contentHash: 'h' }, [
      { chunkIndex: 0, content: 'alpha beta gamma', embedding: await embedOne('alpha beta gamma') },
    ]);

    const results = await vectorStore.query({
      embedding: await embedOne('alpha'), // vector channel matches a (& c partially)
      text: 'beta', // fts channel matches b and c
      limit: 10,
    });

    const ids = results.map((r) => r.id);
    // c is in both channels (rank 2 each) → highest; a (vector-only) and b (keyword-only) tie.
    expect(ids).toEqual(['c#0', 'a#0', 'b#0']);

    const byId = Object.fromEntries(results.map((r) => [r.id, r.score]));
    expect(byId['c#0']).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 2), 10); // 2/62
    expect(byId['a#0']).toBeCloseTo(1 / (RRF_K + 1), 10); // vector rank 1
    expect(byId['b#0']).toBeCloseTo(1 / (RRF_K + 1), 10); // fts rank 1
    // The vector-only (a) and keyword-only (b) matches both surfaced.
    expect(ids).toContain('a#0');
    expect(ids).toContain('b#0');
  });

  it('respects topK and invokes a custom reranker that can reorder', async () => {
    const { vectorStore } = createMemoryStores();
    for (const w of ['alpha', 'alpha beta', 'alpha beta gamma', 'alpha beta gamma delta']) {
      await vectorStore.upsertDocument({ sourceId: w, title: w, contentHash: 'h' }, [
        { chunkIndex: 0, content: w, embedding: await embedOne(w) },
      ]);
    }

    const reranker = vi.fn<Reranker>(async (_q, candidates) => [...candidates].reverse());
    const results = await retrieve({
      query: 'alpha',
      embeddings: embedder,
      store: vectorStore,
      topK: 2,
      reranker,
    });

    expect(reranker).toHaveBeenCalledOnce();
    expect(results.length).toBe(2); // topK respected
    // With reversal, the last candidate is promoted into topK.
    const noRerank = await retrieve({
      query: 'alpha',
      embeddings: embedder,
      store: vectorStore,
      topK: 2,
    });
    expect(results.map((r) => r.id)).not.toEqual(noRerank.map((r) => r.id));
  });
});

// The fusion test above reads RRF_K from the code it is testing, so on its own it would pass
// with any k. These pin the numbers themselves, in TypeScript and in the SQL function.
describe('RRF constants are pinned (SPEC §9.16)', () => {
  it('k is 60 and each channel contributes 12 candidates', () => {
    expect(RRF_K).toBe(60);
    expect(RRF_CANDIDATES).toBe(12);
  });

  it('the memory store applies both numbers', async () => {
    const { vectorStore } = createMemoryStores();
    const add = async (sourceId: string, content: string): Promise<void> =>
      vectorStore.upsertDocument({ sourceId, title: sourceId, contentHash: 'h' }, [
        { chunkIndex: 0, content, embedding: await embedOne(content) },
      ]);
    // Query: vector of "alpha", text "beta".
    //  - v00..v11 match the vector exactly and the text not at all: vector ranks 1-12.
    //  - `both` matches the vector weakly and the text twice: vector rank 13, keyword rank 1.
    //  - k00..k12 match only the text, once each: keyword ranks 2-14.
    for (let i = 0; i < 12; i++) await add(`v${String(i).padStart(2, '0')}`, 'alpha');
    await add('both', 'alpha beta beta');
    for (let i = 0; i < 13; i++) await add(`k${String(i).padStart(2, '0')}`, 'beta');

    const results = await vectorStore.query({
      embedding: await embedOne('alpha'),
      text: 'beta',
      limit: 100,
    });
    const scores = Object.fromEntries(results.map((r) => [r.id, r.score]));

    // Keyword channel cut at 12: `both` and k00..k10 get in, k11 and k12 do not.
    expect(Object.keys(scores).filter((id) => id.startsWith('k'))).toHaveLength(11);
    expect(scores).not.toHaveProperty(['k11#0']);
    expect(scores).not.toHaveProperty(['k12#0']);
    // Vector channel cut at 12: `both` is 13th there, so it scores from the keyword channel
    // alone. A cut made on the fused pool instead would let its vector rank count as well.
    expect(Object.keys(scores).filter((id) => id.startsWith('v'))).toHaveLength(12);
    expect(scores['both#0']).toBeCloseTo(1 / 61, 12);
    // Rank r in one channel scores 1 / (60 + r).
    expect(scores['v00#0']).toBeCloseTo(1 / 61, 12);
    expect(scores['v11#0']).toBeCloseTo(1 / 72, 12);
    expect(scores['k10#0']).toBeCloseTo(1 / 72, 12);
  });

  it('the SQL function ddj_match_chunks hard-codes the same two numbers', () => {
    // Read as text, so this pins what the file says. test/postgres.test.ts is where the
    // migration is executed and the two cuts and the fusion are checked on real Postgres.
    const dir = new URL('../supabase/migrations/', import.meta.url);
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(new URL(f, dir), 'utf8'))
      .join('\n')
      .replace(/--.*$/gm, ''); // comments are not SQL
    // Exactly one definition across every migration: a later file cannot quietly replace it.
    const marker = 'function ddj_match_chunks';
    expect(sql.split(marker)).toHaveLength(2);
    const body = sql.slice(sql.indexOf(marker));

    // Candidates per channel: each CTE ends `limit <n> )`. The final `limit match_count` is
    // not a number, so it is not one of these.
    const limits = [...body.matchAll(/\blimit\s+(\d+)\s*\)/g)].map((m) => Number(m[1]));
    expect(limits).toEqual([12, 12]);

    // RRF k: one `1.0 / (<k> + <channel>.rank)` term per channel.
    const ks = [...body.matchAll(/1\.0\s*\/\s*\(\s*(\d+)\s*\+\s*[vf]\.rank\s*\)/g)].map((m) =>
      Number(m[1]),
    );
    expect(ks).toEqual([60, 60]);
  });
});

describe('ingest idempotency (SPEC §9.8)', () => {
  it('re-ingesting identical content performs zero embedding calls and zero upserts', async () => {
    const { vectorStore } = createMemoryStores();
    const upsertSpy = vi.spyOn(vectorStore, 'upsertDocument');
    const embedSpy = vi.fn(async (texts: string[]) => embedder.embed(texts));
    const spyEmbedder: EmbeddingProvider = { dimension: embedder.dimension, embed: embedSpy };

    const docs: IngestDoc[] = [
      { sourceId: 'd1.md', title: 'D1', text: '# H\nhello world content' },
    ];

    const first = await ingestDocuments({ docs, embeddings: spyEmbedder, store: vectorStore });
    expect(first.ingested).toBe(1);
    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).toHaveBeenCalledTimes(1);

    const second = await ingestDocuments({ docs, embeddings: spyEmbedder, store: vectorStore });
    expect(second.skipped).toBe(1);
    expect(second.embeddingCalls).toBe(0);
    expect(embedSpy).toHaveBeenCalledTimes(1); // unchanged
    expect(upsertSpy).toHaveBeenCalledTimes(1); // unchanged
  });

  it('changed content replaces all of that document’s chunks', async () => {
    const { vectorStore } = createMemoryStores();
    const docs: IngestDoc[] = [{ sourceId: 'd1.md', title: 'D1', text: 'original apple content' }];
    await ingestDocuments({ docs, embeddings: embedder, store: vectorStore });

    const changed: IngestDoc[] = [
      { sourceId: 'd1.md', title: 'D1', text: 'rewritten banana content' },
    ];
    const res = await ingestDocuments({ docs: changed, embeddings: embedder, store: vectorStore });
    expect(res.ingested).toBe(1);

    const hits = await vectorStore.query({
      embedding: await embedOne('banana'),
      text: 'banana',
      limit: 10,
    });
    expect(hits.some((h) => h.content.includes('banana'))).toBe(true);
    const apple = await vectorStore.query({
      embedding: await embedOne('apple'),
      text: 'apple',
      limit: 10,
    });
    expect(apple.some((h) => h.content.includes('apple'))).toBe(false);
  });
});
