/**
 * The migrations and `ddj_match_chunks`, executed. PGlite is PostgreSQL compiled to
 * WebAssembly: a real Postgres with the real pgvector, running inside this process from
 * files in node_modules. No server, no Docker, no network.
 *
 * What this proves: that every file in supabase/migrations/ applies as written and in name
 * order, that the retrieval function admits, ranks and fuses the way the README says, that
 * row-level security shuts out a role that is not allowed to bypass it, and that the
 * constraints the stores lean on are really there. Each fixture also runs through the memory
 * store, so the places where that stand-in differs from Postgres are asserted, not assumed.
 * What it cannot prove: anything about Supabase itself. There is no PostgREST here, the
 * roles below are made by this file to stand for Supabase's, and the Postgres version is
 * PGlite's, not the one a project runs.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import {
  EMBEDDING_DIM,
  FeatureHashEmbeddings,
  chunkMarkdown,
  createMemoryStores,
  createSupabaseStores,
  ingestDocuments,
  retrieve,
  type VectorStore,
} from '../src/index.js';
import { MockModelClient, stop, textDelta } from '../src/testing/mock-model.js';
import { ENGLISH_STOP_WORDS } from '../src/stores/english-stop-words.js';
import { readDocs } from '../scripts/read-docs.js';
import { buildAgent, collectTurn } from './harness.js';

const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);
/** Every migration file, in the order a fresh install applies them. */
const migrationFiles = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const fileSql = (name: string): string => readFileSync(new URL(name, MIGRATIONS), 'utf8');
const migrationSql = (): string => migrationFiles().map(fileSql).join('\n');

const TABLES = [
  'agent_chunks',
  'agent_conversations',
  'agent_documents',
  'agent_events',
  'agent_messages',
];

let db: PGlite;
let memory: VectorStore;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.exec(migrationSql());
  // Stand-ins for Supabase's three API roles. As on Supabase, each is granted every table
  // and the function, so row-level security is the only thing left to keep the first two
  // out; the third may bypass it, as the service-role key's role may.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    grant all on all tables in schema public to anon, authenticated, service_role;
    grant execute on all functions in schema public to anon, authenticated, service_role;
  `);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec('truncate agent_documents, agent_conversations, agent_events cascade');
  memory = createMemoryStores().vectorStore;
});

const literal = (v: number[]): string => `[${v.join(',')}]`;

/**
 * A unit vector `degrees` away from the query direction. The query is the vector at 0, so
 * cosine similarity is cos(degrees): a smaller angle is a nearer chunk, and every chunk in
 * a fixture gets its own angle, so no two tie in the vector channel.
 */
function at(degrees: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = Math.cos((degrees * Math.PI) / 180);
  v[1] = Math.sin((degrees * Math.PI) / 180);
  return v;
}
const QUERY = at(0);

interface Chunk {
  id: string;
  content: string;
  embedding: number[];
}
const chunk = (id: string, degrees: number, content: string): Chunk => ({
  id,
  content,
  embedding: at(degrees),
});

// Letters the bounds on a message are tested with.
/** Ⱥ. Two bytes of UTF-8, and three once this database folds it to lower case. */
const A_STROKE = '\u023A';
/** Ⱦ. The same. */
const T_STROKE = '\u023E';
/** 𝒜. One character to Postgres; two units of a JavaScript string. */
const SCRIPT_A = '\u{1D49C}';
/** ﬁ. One character, which a dictionary files under "f". */
const FI_LIGATURE = '\uFB01';
/** What the keyword half reads of a message `$1`, written as the migration writes it. */
const READ_OF_MESSAGE = String.raw`regexp_replace(left($1, 10000), '[^ \t\n\r]{100}[^ \t\n\r]*', ' ', 'g')`;

/** Put the same chunks in Postgres and in the memory store, one chunk per document. */
async function seed(chunks: Chunk[]): Promise<void> {
  for (const c of chunks) {
    const doc = await db.query<{ id: string }>(
      'insert into agent_documents (source_id, title, content_hash) values ($1, $2, $3) returning id',
      [c.id, `Title of ${c.id}`, 'hash'],
    );
    await db.query(
      'insert into agent_chunks (document_id, chunk_index, content, embedding) values ($1, 0, $2, $3)',
      [doc.rows[0]!.id, c.content, literal(c.embedding)],
    );
    await memory.upsertDocument(
      { sourceId: c.id, title: `Title of ${c.id}`, contentHash: 'hash' },
      [{ chunkIndex: 0, content: c.content, embedding: c.embedding }],
    );
  }
}

type Scores = Record<string, number>;

/** Run one query against both, and give back each one's fused score per chunk. */
async function match(
  text: string,
  embedding: number[] = QUERY,
): Promise<{ postgres: Scores; memory: Scores; postgresOrder: string[]; memoryOrder: string[] }> {
  const pg = await db.query<{ source_id: string; rrf_score: number }>(
    'select source_id, rrf_score from ddj_match_chunks($1, $2, $3)',
    [literal(embedding), text, 100],
  );
  const mem = await memory.query({ embedding, text, limit: 100 });
  return {
    postgres: Object.fromEntries(pg.rows.map((r) => [r.source_id, r.rrf_score])),
    memory: Object.fromEntries(mem.map((r) => [r.sourceId, r.score])),
    postgresOrder: pg.rows.map((r) => r.source_id),
    memoryOrder: mem.map((r) => r.sourceId),
  };
}

function expectScores(actual: Scores, expected: Scores): void {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const [id, score] of Object.entries(expected)) {
    expect(actual[id], `score of ${id}`).toBeCloseTo(score, 12);
  }
}

const pad = (n: number): string => String(n).padStart(2, '0');
/** Twelve chunks nearer the query than anything else in a fixture, with no query word. */
const decoys = (): Chunk[] =>
  Array.from({ length: 12 }, (_, i) => chunk(`decoy${pad(i + 1)}`, i + 1, 'filler'));
interface Row {
  sourceId: string;
  content: string;
  score: number;
}
/** What the SQL function returns for a message, best first. A NULL message is allowed. */
async function sqlRows(text: string | null, limit = 100, embedding = QUERY): Promise<Row[]> {
  const result = await db.query<{ source_id: string; content: string; rrf_score: number }>(
    'select source_id, content, rrf_score from ddj_match_chunks($1, $2, $3)',
    [literal(embedding), text, limit],
  );
  return result.rows.map((r) => ({
    sourceId: r.source_id,
    content: r.content,
    score: r.rrf_score,
  }));
}
/** The same question put to the stand-in store. */
async function standInRows(text: string, limit = 100, embedding = QUERY): Promise<Row[]> {
  const hits = await memory.query({ embedding, text, limit });
  return hits.map((h) => ({ sourceId: h.sourceId, content: h.content, score: h.score }));
}
/**
 * The rows that are not decoys, in the order returned. With the twelve decoys holding the
 * whole vector half, such a row can only have come back by keyword, and its score says where
 * it ranked there: 1 / (60 + rank).
 */
const byKeyword = (rows: Row[]): Row[] => rows.filter((r) => !r.sourceId.startsWith('decoy'));
const ids = (rows: Row[]): string[] => rows.map((r) => r.sourceId);
/** Keyword ranks 1, 2, 3 … in order: each row scores 1 / (60 + its place). */
function expectKeywordRanks(rows: Row[], expected: string[]): void {
  expect(ids(rows)).toEqual(expected);
  rows.forEach((r, i) => expect(r.score, `score of ${r.sourceId}`).toBeCloseTo(1 / (61 + i), 12));
}

/**
 * Run `work` with another definition of `ddj_match_chunks` in place, then put back the one
 * the last migration file defines. This is how a test shows what an earlier design returns
 * on the same fixture.
 */
async function withFunction<T>(sql: string, work: () => Promise<T>): Promise<T> {
  await db.exec(sql);
  try {
    return await work();
  } finally {
    await db.exec(fileSql(migrationFiles().at(-1)!));
  }
}
/** The keyword half of 0.1.x: every word of the message, as the first migration defines it. */
const publishedFunction = (): string => fileSql(migrationFiles()[0]!);
/**
 * The any-word keyword half that was built for this package and held. A passage holding any
 * one word of the message got a vote, ordered by ts_rank. It is kept here only as the
 * control for two fixtures below.
 */
const HELD_ANY_WORD_FUNCTION = `
create or replace function ddj_match_chunks(
  query_embedding vector(1024), query_text text, match_count int
)
returns table (
  id uuid, content text, source_id text, title text, url text, rrf_score double precision
)
language sql
stable
as $$
  with keyword as (
    select replace(
             plainto_tsquery('english', left(query_text, 10000))::text, ' & ', ' | '
           )::tsquery as any_word
  ),
  vector_hits as (
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as rank
    from agent_chunks c
    order by c.embedding <=> query_embedding
    limit 12
  ),
  fts_hits as (
    select c.id, row_number() over (order by ts_rank(c.fts, k.any_word) desc) as rank
    from agent_chunks c
    cross join keyword k
    where c.fts @@ k.any_word
    order by ts_rank(c.fts, k.any_word) desc
    limit 12
  ),
  fused as (
    select
      coalesce(v.id, f.id) as id,
      coalesce(1.0 / (60 + v.rank), 0.0) + coalesce(1.0 / (60 + f.rank), 0.0) as rrf_score
    from vector_hits v
    full outer join fts_hits f on v.id = f.id
  )
  select c.id, c.content, d.source_id, d.title, d.url, fused.rrf_score
  from fused
  join agent_chunks c on c.id = fused.id
  join agent_documents d on d.id = c.document_id
  order by fused.rrf_score desc
  limit match_count;
$$;`;

describe('the migration on real Postgres (SPEC §9.22)', () => {
  it('applies as written, and applies again without error', async () => {
    // beforeAll applied it once. A second run must be harmless.
    await db.exec(migrationSql());

    const version = await db.query<{ v: string }>('select version() as v');
    expect(version.rows[0]!.v).toMatch(/^PostgreSQL \d+/);
    const ext = await db.query<{ extname: string }>(
      "select extname from pg_extension where extname = 'vector'",
    );
    expect(ext.rows).toHaveLength(1);

    const tables = await db.query<{ tablename: string; rowsecurity: boolean }>(
      "select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename",
    );
    expect(tables.rows).toEqual(TABLES.map((tablename) => ({ tablename, rowsecurity: true })));
    const policies = await db.query<{ n: number }>('select count(*)::int as n from pg_policies');
    expect(policies.rows[0]!.n).toBe(0);

    const indexes = await db.query<{ indexname: string; method: string }>(
      `select i.relname as indexname, am.amname as method
         from pg_index x
         join pg_class i on i.oid = x.indexrelid
         join pg_class t on t.oid = x.indrelid
         join pg_am am on am.oid = i.relam
        where t.relname = 'agent_chunks' and not x.indisprimary
        order by i.relname`,
    );
    expect(indexes.rows).toEqual([
      { indexname: 'agent_chunks_document_idx', method: 'btree' },
      { indexname: 'agent_chunks_embedding_idx', method: 'hnsw' },
      { indexname: 'agent_chunks_fts_idx', method: 'gin' },
    ]);

    const fn = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_proc where proname = 'ddj_match_chunks'",
    );
    expect(fn.rows[0]!.n).toBe(1);
  });

  it('holds the constraints the stores rely on', async () => {
    const failure = async (sql: string, params: unknown[] = []): Promise<string> => {
      try {
        await db.query(sql, params);
        return 'accepted';
      } catch (err) {
        return (err as Error).message;
      }
    };
    const doc = await db.query<{ id: string }>(
      "insert into agent_documents (source_id, title, content_hash) values ('faq.md', 'FAQ', 'h1') returning id",
    );
    const documentId = doc.rows[0]!.id;

    // A vector of the wrong size. test/supabase-store.test.ts replays this exact message.
    expect(
      await failure(
        "insert into agent_chunks (document_id, chunk_index, content, embedding) values ($1, 0, 'x', '[0.25,-0.5]')",
        [documentId],
      ),
    ).toBe('expected 1024 dimensions, not 2');

    // upsertDocument's conflict target is a real unique constraint, and it updates in place.
    const again = await db.query<{ id: string; content_hash: string }>(
      `insert into agent_documents (source_id, title, content_hash) values ('faq.md', 'FAQ', 'h2')
         on conflict (source_id) do update set content_hash = excluded.content_hash
         returning id, content_hash`,
    );
    expect(again.rows).toEqual([{ id: documentId, content_hash: 'h2' }]);

    // An event with no conversation is stored; a placeholder that is not a uuid is not.
    expect(
      await failure(
        "insert into agent_events (conversation_id, type, payload) values (null, 'error', '{}')",
      ),
    ).toBe('accepted');
    expect(
      await failure(
        "insert into agent_events (conversation_id, type, payload) values ('unknown', 'error', '{}')",
      ),
    ).toBe('invalid input syntax for type uuid: "unknown"');

    // A message needs its conversation, and a status has to be one of the three.
    expect(
      await failure(
        "insert into agent_messages (conversation_id, role, content) values (gen_random_uuid(), 'user', 'hi')",
      ),
    ).toMatch(/violates foreign key constraint/);
    expect(await failure("insert into agent_conversations (status) values ('archived')")).toMatch(
      /violates check constraint/,
    );

    // Deleting a document takes its chunks with it.
    await db.query(
      'insert into agent_chunks (document_id, chunk_index, content, embedding) values ($1, 0, $2, $3)',
      [documentId, 'x', literal(QUERY)],
    );
    await db.query('delete from agent_documents where id = $1', [documentId]);
    const left = await db.query<{ n: number }>('select count(*)::int as n from agent_chunks');
    expect(left.rows[0]!.n).toBe(0);
  });
});

describe('ddj_match_chunks on real Postgres (SPEC §9.22)', () => {
  it('surfaces a vector-only and a keyword-only match, and fuses them with RRF', async () => {
    // Nearest first: near01, near02, both, near03 … near11 are the 12 nearest. near12 is
    // 13th, and `keyword` is further off still. Only `both` and `keyword` hold the word.
    await seed([
      chunk('near01', 1, 'filler'),
      chunk('near02', 2, 'filler'),
      chunk('both', 2.5, 'beta beta'),
      ...Array.from({ length: 10 }, (_, i) => chunk(`near${pad(i + 3)}`, i + 3, 'filler')),
      chunk('keyword', 40, 'beta beta beta'),
    ]);

    const { postgres, memory: mem, postgresOrder } = await match('beta');

    const expected: Scores = {
      near01: 1 / 61, // vector rank 1
      near02: 1 / 62, // vector rank 2
      both: 1 / 63 + 1 / 62, // vector rank 3, keyword rank 2
      keyword: 1 / 61, // keyword rank 1; 14th nearest, so no vector share
    };
    for (let n = 3; n <= 11; n++) expected[`near${pad(n)}`] = 1 / (60 + n + 1); // ranks 4 … 12
    // near12 is absent: 13th nearest, and it does not hold the word.
    expectScores(postgres, expected);
    expect(postgresOrder[0]).toBe('both');
    // The memory store gives the same answer on this fixture.
    expectScores(mem, expected);
  });

  it('cuts the keyword channel at 12 as well', async () => {
    // key01 holds the word 14 times, key02 13 times … key14 once: 14 distinct keyword ranks.
    // All of them point away from the query, so they never enter the vector channel.
    await seed([
      ...decoys(),
      ...Array.from({ length: 14 }, (_, i) =>
        chunk(
          `key${pad(i + 1)}`,
          100 + i,
          Array(14 - i)
            .fill('beta')
            .join(' '),
        ),
      ),
    ]);

    const { postgres, memory: mem } = await match('beta');

    const expected: Scores = {};
    for (let n = 1; n <= 12; n++) {
      expected[`decoy${pad(n)}`] = 1 / (60 + n);
      expected[`key${pad(n)}`] = 1 / (60 + n);
    }
    // key13 and key14 match the word and are cut all the same.
    expectScores(postgres, expected);
    expectScores(mem, expected);
  });

  it('a message with no meaningful word matches nothing by keyword and raises nothing', async () => {
    // The last chunk holds all three of "the", "of" and "and". Stop words are dropped twice,
    // from the stored column and from the query, so "the of and" finds it only if both stop
    // dropping them. With one side changed alone this test stays green.
    await seed([
      ...decoys(),
      chunk('heater-repair', 101, 'Water heater repair and installation.'),
      chunk('leak', 102, 'We fix a leak the same day.'),
      chunk('stop-words', 103, 'The top of the tank and the valve.'),
    ]);
    const onlyTheVectorHalf: Scores = {};
    for (let n = 1; n <= 12; n++) onlyTheVectorHalf[`decoy${pad(n)}`] = 1 / (60 + n);

    // Empty, blank, only stop words, only punctuation, a lone minus.
    for (const text of ['', '   ', 'the of and', 'Do you?', '?!.,;:()[]{}', '-', ' - ']) {
      const { postgres } = await match(text);
      // No error, no keyword match, and the vector half answers as if nothing was typed.
      expectScores(postgres, onlyTheVectorHalf);
    }
  });

  it('keeps the 12 nearest whatever their distance; the memory store drops what is not similar', async () => {
    // The README's own example: three chunks, a query vector for "alpha", the word "beta".
    const hasher = new FeatureHashEmbeddings();
    const embed = async (t: string): Promise<number[]> => (await hasher.embed([t]))[0]!;
    await seed([
      { id: 'a', content: 'alpha alpha', embedding: await embed('alpha alpha') },
      { id: 'b', content: 'beta beta', embedding: await embed('beta beta') },
      { id: 'c', content: 'alpha beta gamma', embedding: await embed('alpha beta gamma') },
    ]);

    const result = await match('beta', await embed('alpha'));

    // Postgres ranks all three by distance, so `b`, which shares nothing with the query
    // vector, still gets third place in the vector channel. With its keyword rank of 1 that
    // puts it first.
    expectScores(result.postgres, { b: 1 / 63 + 1 / 61, c: 1 / 62 + 1 / 62, a: 1 / 61 });
    expect(result.postgresOrder).toEqual(['b', 'c', 'a']);
    // The memory store gives `b` no vector share, and puts `c` first.
    expectScores(result.memory, { c: 1 / 62 + 1 / 62, a: 1 / 61, b: 1 / 61 });
    expect(result.memoryOrder).toEqual(['c', 'a', 'b']);
  });
});

// The keyword half gives a passage a vote only when the passage holds more than half of the
// message's distinct meaningful words. In every fixture below the twelve decoys take the
// whole vector half, in both stores, and every other passage points away from the query. So
// a passage that is not a decoy and comes back came back by keyword.
describe('the keyword half: more than half of the words (SPEC §9.39)', () => {
  const TEXTS: Chunk[] = [
    chunk('open-hours', 101, 'We are open every weekday. Opening hours are nine to five.'),
    chunk('hours-only', 102, 'Our hours are nine to five.'),
    chunk('heater-repair', 103, 'Water heater repair and installation.'),
    chunk('heater-apart', 104, 'A heater for hot water.'),
    chunk('drain', 105, 'We fix a blocked drain.'),
    chunk('leak', 106, 'We fix a leak the same day.'),
    chunk('plumb-heat', 107, 'Plumbing and heating.'),
    chunk('plumb-only', 108, 'Plumbing only.'),
    chunk('saturday', 109, 'We open at nine on Saturdays.'),
    chunk('refund', 110, 'Refund within thirty days.'),
  ];
  /** The passages that came back by keyword from Postgres, sorted by id. */
  const keywordIds = async (text: string | null): Promise<string[]> =>
    ids(byKeyword(await sqlRows(text))).sort();

  it('admits a passage holding more than half of the words; exactly half is not enough (KC-1)', async () => {
    await seed([
      ...decoys(),
      chunk('four', 101, 'alpha beta gamma delta'),
      chunk('three', 102, 'alpha beta gamma'),
      chunk('two', 103, 'alpha beta'),
      chunk('one', 104, 'alpha'),
    ]);

    const cases: Array<[message: string, rows: string[]]> = [
      // One word asked: every passage holding it. Equal on both counts, so document order.
      ['alpha', ['four', 'one', 'three', 'two']],
      // Two asked: both are needed.
      ['alpha beta', ['four', 'three', 'two']],
      // Three asked: two will do.
      ['alpha beta gamma', ['four', 'three', 'two']],
      // Four asked: three are needed. `two` holds exactly half and gets no vote.
      ['alpha beta gamma delta', ['four', 'three']],
      // Five asked: three.
      ['alpha beta gamma delta epsilon', ['four', 'three']],
      // Six asked: four.
      ['alpha beta gamma delta epsilon zeta', ['four']],
      // A repeated word counts once: this asks five words, not six.
      ['alpha alpha beta gamma delta epsilon', ['four', 'three']],
      // Stop words count on neither side: this asks two words.
      ['the alpha of the beta', ['four', 'three', 'two']],
    ];
    for (const [message, expected] of cases) {
      expectKeywordRanks(byKeyword(await sqlRows(message)), expected);
      // The stand-in store applies the same rule and gives the same rows and scores.
      expectKeywordRanks(byKeyword(await standInRows(message)), expected);
    }
  });

  it('orders by words held, then by rank, then by document (KC-2)', async () => {
    const twenty = (word: string): string => Array(20).fill(word).join(' ');
    // Inserted in an order that runs against the document order the last key uses.
    await seed([
      ...decoys(),
      chunk('b-two-often', 101, `${twenty('alpha')} ${twenty('beta')}`),
      chunk('c-two-once', 102, 'alpha beta'),
      chunk('a-two-once', 103, 'alpha beta'),
      chunk('z-three-once', 104, 'alpha beta gamma'),
    ]);

    // More of the words beats a higher ts_rank: two words twenty times each score above
    // three words once each on ts_rank alone. Then ts_rank. Then the earlier document.
    const expected = ['z-three-once', 'b-two-often', 'a-two-once', 'c-two-once'];
    expectKeywordRanks(byKeyword(await sqlRows('alpha beta gamma')), expected);
    expectKeywordRanks(byKeyword(await standInRows('alpha beta gamma')), expected);

    const rank = await db.query<{ often: number; once: number }>(
      `select ts_rank(to_tsvector('english', $1), q) as often,
              ts_rank(to_tsvector('english', 'alpha beta gamma'), q) as once
         from (select to_tsquery('english', 'alpha | beta | gamma') as q) x`,
      [`${twenty('alpha')} ${twenty('beta')}`],
    );
    expect(rank.rows[0]!.often).toBeGreaterThan(rank.rows[0]!.once);
  });

  // The fixture that separates this rule from both earlier ones. Four passages near the
  // query mention a tank. The one passage that names the part is far from the query, so the
  // vector half misses it, and it holds three of the message's four words.
  describe('an exact term the vector half missed (KC-5)', () => {
    const MESSAGE = 'Do you have the AR-4420 in stock for my tank?';
    const fixture = (): Chunk[] => [
      chunk('near01', 1, 'We flush every tank in spring.'),
      chunk('near02', 2, 'A tank lasts about ten years.'),
      chunk('near03', 3, 'Ask us which tank suits your home.'),
      chunk('near04', 4, 'The old tank is recycled.'),
      ...Array.from({ length: 8 }, (_, i) => chunk(`near${pad(i + 5)}`, i + 5, 'filler')),
      chunk('part', 40, 'Replace the anode rod, part AR-4420, and the tank lasts longer.'),
    ];
    const reachesTheModel = (rows: Row[]): void => {
      // The first two tie at 1/61 (first by vector, first by keyword), so their order is
      // not asserted for Postgres.
      expect(ids(rows).slice(0, 2).sort()).toEqual(['near01', 'part']);
      expect(ids(rows).slice(2)).toEqual(['near02', 'near03']);
      const scores = Object.fromEntries(rows.map((r) => [r.sourceId, r.score]));
      expectScores(scores, { near01: 1 / 61, part: 1 / 61, near02: 1 / 62, near03: 1 / 63 });
    };

    it('is among the four passages the model reads, in both stores', async () => {
      await seed(fixture());

      reachesTheModel(await sqlRows(MESSAGE, 4));
      const standIn = await standInRows(MESSAGE, 4);
      reachesTheModel(standIn);
      // Equal fused scores go by chunk id in the stand-in; Postgres leaves them unordered.
      expect(ids(standIn)).toEqual(['near01', 'part', 'near02', 'near03']);
    });

    it('control: the any-word rule finds it and then buries it; the every-word rule never finds it', async () => {
      await seed(fixture());
      const tankPassages = ['near01', 'near02', 'near03', 'near04'];

      // Any word: the four tank passages are in both lists, and a passage in both lists
      // outranks every passage in one. The part is in one.
      const held = await withFunction(HELD_ANY_WORD_FUNCTION, () => sqlRows(MESSAGE, 4));
      expect(ids(held).sort()).toEqual(tankPassages);
      // Every word: no passage says "stock", so the keyword half is silent.
      const published = await withFunction(publishedFunction(), () => sqlRows(MESSAGE, 4));
      expect(ids(published)).toEqual(tankPassages);

      // And the function is back: the part reaches the model again.
      reachesTheModel(await sqlRows(MESSAGE, 4));
    });
  });

  // The other side of the same arithmetic. The passage that answers shares no word with the
  // message and is first in the vector half. Four others each share a common word.
  describe('a paraphrase the vector half ranks first (KC-6)', () => {
    const MESSAGE = 'What happens if I need to call it off last minute?';
    const fixture = (): Chunk[] => [
      chunk(
        'answer',
        1,
        'Move or cancel a visit free of charge up to 24 hours before the window starts.',
      ),
      chunk('near02', 2, 'Call the office in the morning.'),
      chunk('near03', 3, 'We need access to the valve.'),
      chunk('near04', 4, 'Call us if you need a quote.'),
      chunk('near05', 5, 'The last visit of the day starts at four.'),
      ...Array.from({ length: 7 }, (_, i) => chunk(`near${pad(i + 6)}`, i + 6, 'filler')),
    ];
    const vectorOrder = ['answer', ...Array.from({ length: 11 }, (_, i) => `near${pad(i + 2)}`)];

    it('is not outvoted: the keyword half says nothing, in both stores', async () => {
      await seed(fixture());

      for (const rows of [sqlRows, standInRows]) {
        expectKeywordRanks(await rows(MESSAGE, 4), ['answer', 'near02', 'near03', 'near04']);
        // Twelve rows, each scoring its vector share alone: the keyword half added nothing.
        expectKeywordRanks(await rows(MESSAGE, 100), vectorOrder);
      }
    });

    it('control: under the any-word rule four passages sharing a word push the answer out', async () => {
      await seed(fixture());

      const held = await withFunction(HELD_ANY_WORD_FUNCTION, () => sqlRows(MESSAGE, 4));

      expect(ids(held).sort()).toEqual(['near02', 'near03', 'near04', 'near05']);
      expect(ids(held)).not.toContain('answer');
    });

    it('control: the every-word rule of 0.1.x says nothing here either, so the answer stays first', async () => {
      await seed(fixture());

      const published = await withFunction(publishedFunction(), () => sqlRows(MESSAGE, 100));

      // No passage holds every word of the message. Twelve rows, each at its vector share.
      expectKeywordRanks(published, vectorOrder);
    });
  });

  it('reads nothing a visitor types as search syntax, and nothing raises (KC-7)', async () => {
    await seed([...decoys(), ...TEXTS]);
    const bothHeaterPassages = ['heater-apart', 'heater-repair'];

    // A whole question: "time", "open" and "saturday" are asked, and one passage holds two.
    expect(await keywordIds('what time do you open on saturday')).toEqual(['saturday']);
    // The stand-in does not stem, so "saturday" does not find "Saturdays" there.
    expect(ids(byKeyword(await standInRows('what time do you open on saturday')))).toEqual([]);
    // Two words: both are needed, by stem.
    expect(await keywordIds('opening hours')).toEqual(['open-hours']);
    expect(await keywordIds('refunds')).toEqual(['refund']);
    // `or` is a stop word, not an operator: two words are asked and no passage holds both.
    expect(await keywordIds('drain or leak')).toEqual([]);
    expect(await keywordIds('fix water')).toEqual([]);
    expect(await keywordIds('water heater')).toEqual(bothHeaterPassages);
    // A quoted phrase is two words. "A heater for hot water" matches although the words
    // are not side by side.
    expect(await keywordIds('"water heater"')).toEqual(bothHeaterPassages);
    // A leading minus does not exclude. Both words are asked, so only the passage with both.
    expect(await keywordIds('plumbing -heating')).toEqual(['plumb-heat']);
    // `:*` is not a prefix match. "heat" is the stem of "heating"; "wat" is no word here.
    expect(await keywordIds('heat:*')).toEqual(['plumb-heat']);
    expect(await keywordIds('wat:* heat:*')).toEqual([]);

    // Everything else that is syntax to to_tsquery is punctuation here.
    for (const text of [
      '(water) heater)',
      '((water heater',
      'water & heater',
      'water | heater',
      '!water !heater',
      'water <-> heater',
      'water <2> heater',
      '"water heater',
      "'water' 'heater'",
      "water' | 'heater",
      'water\\ heater \\',
      'water:A heater:B',
      '&&& water ||| heater !!!',
      "water' or '1'='1 heater",
      'WATER HEATER',
      'water-heater',
      'вода water heater',
      '🔧 water heater 🔧',
    ]) {
      expect(await keywordIds(text), text).toEqual(bothHeaterPassages);
    }

    // Text shaped like SQL is words like any other: six of them here, two held, no vote.
    expect(await keywordIds("water'); drop table agent_chunks; -- heater")).toEqual([]);
    const chunks = await db.query<{ n: number }>('select count(*)::int as n from agent_chunks');
    expect(chunks.rows[0]!.n).toBe(22);

    // Postgres reads each of these as a word of its own that no passage holds.
    for (const text of [
      'wáter heater',
      'https://example.com/water?heater=1&x=2',
      'heater@water.example',
    ]) {
      expect(await keywordIds(text), text).toEqual([]);
    }
    // No message at all.
    expect(await keywordIds(null)).toEqual([]);
  });

  // What the keyword half reads of a long message: its first 10,000 characters. Every row
  // runs through both stores, because the stand-in keeps the same bound in the same unit.
  describe('a long message raises nothing, and only its first 10,000 characters are read (KC-9)', () => {
    // About 2.6 MB of distinct words. The function of 0.1.x raises "value is too big in
    // tsquery" on this.
    const filler = Array.from({ length: 250_000 }, (_, i) => `word${i}`).join(' ');
    // "a " is a stop word and a space, so the padding asks nothing.
    const padding = (chars: number): string => 'a '.repeat(chars / 2);
    const others = Array.from({ length: 400 }, (_, i) => `other${i}`).join(' ');

    it.each<[what: string, message: () => string, rows: string[]]>([
      // "drain" at the very end is past the 10,000th character, so it is not read.
      ['2.6 MB of distinct words, then "drain"', () => `${filler} drain`, []],
      // At the start it is read, as one word among some 1,200. That is no majority.
      ['"drain", then the same 2.6 MB', () => `drain ${filler}`, []],
      // One unbroken token of a megabyte is not a word. "drain" is the only word asked.
      [
        '"drain" and one unbroken token of 1,000,000 characters',
        () => `drain ${'x'.repeat(1_000_000)}`,
        ['drain'],
      ],
      // The boundary itself: the last word that is read, the first that is cut, the first
      // that is not read at all.
      ['"drain" ending at character 10,000', () => `${padding(9_994)} drain`, ['drain']],
      ['"drain" cut to "drai" at character 10,000', () => `${padding(9_996)}drain`, []],
      ['"drain" starting at character 10,001', () => `${padding(10_000)}drain`, []],
      // Inside the limit with 400 other words: read in full, and no majority.
      ['"drain" and 400 other distinct words', () => `drain ${others}`, []],
      // The unit of the cut. A character above U+FFFF is one character to Postgres and two
      // units of a JavaScript string: 9,990 of them are 19,980 units and still inside.
      [
        '9,990 characters above U+FFFF, then "drain" (it ends at character 9,996)',
        () => `${SCRIPT_A.repeat(9_990)} drain`,
        ['drain'],
      ],
      [
        '9,999 characters above U+FFFF, then "drain" (it starts at character 10,001)',
        () => `${SCRIPT_A.repeat(9_999)} drain`,
        [],
      ],
    ])(
      '%s',
      async (_what, message, expected) => {
        expect(filler.length).toBeGreaterThan(2_500_000);
        await seed([...decoys(), ...TEXTS]);
        const text = message();

        expect(ids(byKeyword(await sqlRows(text)))).toEqual(expected);
        expect(ids(byKeyword(await standInRows(text)))).toEqual(expected);
      },
      30_000,
    );
  });

  it('admits exactly the passages that hold more than half, over 16,000 seeded pairs (KC-10)', async () => {
    // A small repeatable generator, so a failure names the same pair every run.
    let state = 20_261_007;
    const next = (): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const pick = <T>(list: T[]): T => list[Math.floor(next() * list.length)]!;
    const PASSAGE_WORDS = [
      // ordinary words, some sharing a stem
      ...'water heater heaters repair repairs drain drains leak boiler tank pipe valve'.split(' '),
      ...'filter pressure install installed service furnace plumbing heating hours'.split(' '),
      ...'saturday refund refunds price quote visit'.split(' '),
      // stop words
      ...'the of and do you is a to in on for my it or not'.split(' '),
      // hyphenated words, part codes, a phone number, an e-mail address, a URL
      ...'call-out same-day water-heater AR-4420 NW-50G TH-90 CF-10 E118 16x25x1'.split(' '),
      '555-0100',
      'hello@tricity.example',
      'https://example.com/water?heater=1&x=2',
      // accented and non-Latin words
      ...'wáter café вода 水'.split(' '),
      // every operator character, alone and stuck to a word
      ...['&', '|', '!', '(', ')', ':*', '<->', '<2>', '"', "'", '\\', '-'],
      ...['"water', 'heater"', '-heating', 'water:*', '!drain', '(tank)', "o'clock"],
    ];
    // A message can also hold words that are long, or that grow when folded: some under
    // the run bound, some over it, and two runs joined by a space that breaks nothing.
    const MESSAGE_WORDS = [
      ...PASSAGE_WORDS,
      ...[60, 99, 100, 683].map((n) => A_STROKE.repeat(n)),
      T_STROKE.repeat(1_023),
      '\u0130'.repeat(700),
      '\u1E9E'.repeat(99),
      'x'.repeat(99),
      'x'.repeat(100),
      'y'.repeat(2_046),
      SCRIPT_A.repeat(99),
      `${'z'.repeat(60)}\u00A0${'z'.repeat(60)}`,
    ];
    const sentence = (min: number, max: number, words: string[]): string =>
      Array.from({ length: min + Math.floor(next() * (max - min + 1)) }, () => pick(words)).join(
        ' ',
      );

    const passages = Array.from({ length: 40 }, (_, i) =>
      chunk(`p${pad(i)}`, 100 + i, sentence(3, 14, PASSAGE_WORDS)),
    );
    await seed([...decoys(), ...passages]);
    // The two properties are properties of a well-formed passage. No passage here holds a
    // word this database would index wrongly, and every stored value can be read back.
    expect(passages.filter((p) => /[\u023A\u023E]{683,}/u.test(p.content))).toEqual([]);
    const readable = await db.query<{ n: number }>(
      'select count(*)::int as n from agent_chunks where length(fts::text) >= 0',
    );
    expect(readable.rows[0]!.n).toBe(52);
    const messages = Array.from({ length: 400 }, () => sentence(1, 9, MESSAGE_WORDS));
    const withARun = messages.filter((m) => /[^ \t\n\r]{100}/u.test(m)).length;

    const mismatches: string[] = [];
    let pairs = 0;
    let admittedPairs = 0;
    let cutApplied = 0;
    for (const message of messages) {
      // Outside the function: the words of both sides, and the index probe on its own.
      const outside = await db.query<{
        source_id: string;
        probe: boolean;
        lexemes: string[];
        words: string[];
      }>(
        `select d.source_id,
                c.fts @@ replace(
                  plainto_tsquery('english', ${READ_OF_MESSAGE})::text, ' & ', ' | '
                )::tsquery as probe,
                tsvector_to_array(c.fts) as lexemes,
                tsvector_to_array(to_tsvector('english', ${READ_OF_MESSAGE})) as words
           from agent_chunks c
           join agent_documents d on d.id = c.document_id
          where d.source_id like 'p%'`,
        [message],
      );
      const held = new Map<string, number>();
      const shouldAdmit: string[] = [];
      for (const row of outside.rows) {
        pairs++;
        const count = row.words.filter((w) => row.lexemes.includes(w)).length;
        held.set(row.source_id, count);
        // (a) The index probe finds a passage exactly when it holds at least one word.
        if (row.probe !== count >= 1) {
          mismatches.push(`probe ${row.probe}, held ${count}: ${row.source_id} | ${message}`);
        }
        if (2 * count > row.words.length) shouldAdmit.push(row.source_id);
      }
      admittedPairs += shouldAdmit.length;

      // (b) The function admits a passage exactly when it holds more than half.
      const admitted = ids(byKeyword(await sqlRows(message)));
      if (shouldAdmit.length <= 12) {
        if (admitted.slice().sort().join() !== shouldAdmit.slice().sort().join()) {
          mismatches.push(`admitted [${admitted}], expected [${shouldAdmit}] | ${message}`);
        }
      } else {
        // More qualify than the cut lets through: twelve of them, and none holding fewer
        // of the words than one that was left out.
        cutApplied++;
        const fewestIn = Math.min(...admitted.map((id) => held.get(id) ?? -1));
        const mostOut = Math.max(
          ...shouldAdmit.filter((id) => !admitted.includes(id)).map((id) => held.get(id)!),
        );
        if (
          admitted.length !== 12 ||
          admitted.some((id) => !shouldAdmit.includes(id)) ||
          fewestIn < mostOut
        ) {
          mismatches.push(`cut: admitted [${admitted}], qualifying [${shouldAdmit}] | ${message}`);
        }
      }
    }

    expect(mismatches).toEqual([]);
    expect(pairs).toBe(16_000);
    // Not vacuous: plenty of pairs are admitted, and the cut at 12 is seldom what decides.
    expect(admittedPairs).toBeGreaterThan(100);
    // And the run bound was at work in many of the messages.
    expect(withARun).toBeGreaterThan(100);
    expect(cutApplied).toBeLessThan(messages.length / 4);
  }, 60_000);

  // Postgres limits a word in bytes, and measures it after folding it to lower case. A
  // letter that grows when folded can take a word past the limit although the message is
  // short, and what a server then does depends on its version: this one raises. So the
  // keyword half skips every unbroken run of 100 characters or more before anything parses
  // the message. Rows 1 to 6 raised before that bound existed.
  describe('no word of a message can reach the limit on a word (KC-21)', () => {
    const Q97 = 'q'.repeat(97);
    const fixture = (): Chunk[] => [
      ...decoys(),
      chunk('drain', 101, 'We fix a blocked drain.'),
      chunk('pair', 102, `drain ${Q97}`),
    ];
    const BOTH = ['drain', 'pair'];

    it.each<[row: number, what: string, message: string, postgres: string[], standIn?: string[]]>([
      // The raise: one unbroken word of a letter that grows when folded.
      [1, '683 of U+023A', A_STROKE.repeat(683), []],
      [2, '1,023 of U+023A', A_STROKE.repeat(1_023), []],
      [3, '683 of U+023E', T_STROKE.repeat(683), []],
      [
        4,
        'two such runs, then "drain"',
        `${A_STROKE.repeat(100)} ${A_STROKE.repeat(700)} drain`,
        BOTH,
      ],
      [5, '"drain", then 700 of U+023A', `drain ${A_STROKE.repeat(700)}`, BOTH],
      [
        6,
        'a real question, then 700 of U+023A',
        `Do you fix a blocked drain? ${A_STROKE.repeat(700)}`,
        ['drain'],
      ],
      // The number: 99 is read as a word, 100 is skipped. Row 7 is also where the stand-in
      // parts from Postgres: its words are ASCII letters and digits, so 99 other letters
      // are a second word asked to Postgres and nothing to the stand-in.
      [7, '"drain", then 99 of U+023A', `drain ${A_STROKE.repeat(99)}`, [], BOTH],
      [8, '"drain", then 99 of "x"', `drain ${'x'.repeat(99)}`, []],
      [9, '"drain", then 100 of "x"', `drain ${'x'.repeat(100)}`, BOTH],
      // What breaks a run: a line feed, a tab and a carriage return do, as a space does.
      [10, 'a line feed breaks a run', `drain\n${Q97}`, ['pair']],
      [11, 'a tab breaks a run', `drain\t${Q97}`, ['pair']],
      [12, 'a carriage return breaks a run', `drain\r${Q97}`, ['pair']],
      // Nothing else does: with these, "drain" and the 97 letters are one run of 103.
      [13, 'a no-break space does not break a run', `drain\u00A0${Q97}`, []],
      [14, 'a form feed does not break a run', `drain\f${Q97}`, []],
      // The cut at 10,000 comes first, then the runs. Here "drain" starts at character
      // 10,002; with the run of 200 removed first it would slide back inside.
      [15, 'the cut comes before the runs', `${'x'.repeat(200)} ${'a '.repeat(4_900)}drain`, []],
      // The unit of the cut: characters, not the two units a character above U+FFFF takes.
      [16, '9,990 characters above U+FFFF, then "drain"', `${SCRIPT_A.repeat(9_990)} drain`, BOTH],
      [17, '9,999 characters above U+FFFF, then "drain"', `${SCRIPT_A.repeat(9_999)} drain`, []],
    ])('row %i: %s', async (_row, _what, message, postgres, standIn = postgres) => {
      await seed(fixture());

      // None raises, and the passages that come back by keyword are these, at 1/61, 1/62.
      expectKeywordRanks(byKeyword(await sqlRows(message)), postgres);
      expectKeywordRanks(byKeyword(await standInRows(message)), standIn);
    });

    it('every length from 1 to 1,100 of such a letter: none raises, and the run rule holds (KC-22)', async () => {
      await seed(fixture());

      // 4,400 messages, made and asked inside the database: one statement per letter and
      // per form. Alone, such a word asks one word no passage holds. After "drain", up to
      // 99 copies are a second word asked, and from 100 on they are skipped.
      for (const letter of [A_STROKE, T_STROKE]) {
        for (const before of ['', 'drain ']) {
          const sweep = await db.query<{ n: number; votes: string[] | null }>(
            `select n,
                    (select array_agg(r.source_id order by r.rrf_score desc)
                       from ddj_match_chunks($1, $2::text || repeat($3::text, n), 100) r
                      where r.source_id not like 'decoy%') as votes
               from generate_series(1, 1100) as n
              order by n`,
            [literal(QUERY), before, letter],
          );
          expect(sweep.rows).toHaveLength(1_100);
          const offTheRule = sweep.rows.filter(
            (row) => (row.votes ?? []).join() !== (before && row.n >= 100 ? BOTH : []).join(),
          );
          expect(
            offTheRule.map((row) => `${row.n}: ${row.votes}`),
            `after "${before}"`,
          ).toEqual([]);
        }
      }
    }, 60_000);

    it('the stand-in counts a run in characters, not in the units of a JavaScript string (KC-15)', async () => {
      await seed(fixture());

      // "drain" glued to 60 characters above U+FFFF: 65 characters, and 125 units of a
      // JavaScript string. That is no run of 100, so the stand-in reads it, and the one
      // word it finds there is "drain". Counted in units it would be a run, be skipped, and
      // leave nothing asked.
      const message = `drain${SCRIPT_A.repeat(60)}`;
      expect(Array.from(message)).toHaveLength(65);
      expect(message).toHaveLength(125);
      expectKeywordRanks(byKeyword(await standInRows(message)), BOTH);

      // Postgres reads it too, as one word of 65 characters that no passage holds. That is
      // the difference of row 7 again, what a word is, and not a difference of bounds.
      expectKeywordRanks(byKeyword(await sqlRows(message)), []);
    });
  });

  it('the cut at 12 keeps the twelve passages holding the most words, in both stores (KC-23)', async () => {
    const twenty = (word: string): string => Array(20).fill(word).join(' ');
    await seed([
      ...decoys(),
      ...Array.from({ length: 12 }, (_, i) =>
        chunk(`often${pad(i + 1)}`, 101 + i, `${twenty('alpha')} ${twenty('beta')}`),
      ),
      chunk('three', 113, 'alpha beta gamma'),
    ]);

    // Thirteen passages qualify. The one holding all three words has the lowest ts_rank of
    // the thirteen, so a cut ordered by ts_rank alone would drop it and hand the fusion
    // ranks 2 to 13.
    const kept = ['three', ...Array.from({ length: 11 }, (_, i) => `often${pad(i + 1)}`)];
    for (const rows of [sqlRows, standInRows]) {
      const votes = byKeyword(await rows('alpha beta gamma', 100));
      expectKeywordRanks(votes, kept);
      expect(ids(votes)).not.toContain('often12');
      expect(votes.filter((r) => Math.abs(r.score - 1 / 73) < 1e-9)).toEqual([]);
    }
  });

  it('orders the chunks of one document by their index, in both stores (KC-24)', async () => {
    await seed(decoys());
    // One document, three chunks, stored last chunk first. Each holds both words once, so
    // only the chunk key separates them.
    const chunks = [
      { chunkIndex: 2, content: 'alpha beta two', embedding: at(101) },
      { chunkIndex: 1, content: 'alpha beta one', embedding: at(102) },
      { chunkIndex: 0, content: 'alpha beta zero', embedding: at(103) },
    ];
    const doc = await db.query<{ id: string }>(
      "insert into agent_documents (source_id, title, content_hash) values ('manual', 'Manual', 'hash') returning id",
    );
    for (const c of chunks) {
      await db.query(
        'insert into agent_chunks (document_id, chunk_index, content, embedding) values ($1, $2, $3, $4)',
        [doc.rows[0]!.id, c.chunkIndex, c.content, literal(c.embedding)],
      );
    }
    await memory.upsertDocument(
      { sourceId: 'manual', title: 'Manual', contentHash: 'hash' },
      chunks,
    );

    for (const rows of [sqlRows, standInRows]) {
      const votes = byKeyword(await rows('alpha beta'));
      expect(votes.map((r) => r.content)).toEqual([
        'alpha beta zero',
        'alpha beta one',
        'alpha beta two',
      ]);
      votes.forEach((r, i) => expect(r.score, r.content).toBeCloseTo(1 / (61 + i), 12));
    }
  });

  it('orders documents by the bytes of their ids, in both stores (KC-25)', async () => {
    // Stored in an order that is neither byte order nor a dictionary's.
    const stored = ['a-doc', 'B-doc', 'b_doc', 'b-doc', `${FI_LIGATURE}-doc`, `${SCRIPT_A}-doc`];
    await seed([...decoys(), ...stored.map((id, i) => chunk(id, 101 + i, 'alpha beta'))]);

    // Byte order of UTF-8, which is code-point order: capitals before small letters, "-"
    // before "_", and a character above U+FFFF after every character below it.
    const byteOrder = ['B-doc', 'a-doc', 'b-doc', 'b_doc', `${FI_LIGATURE}-doc`, `${SCRIPT_A}-doc`];
    for (const rows of [sqlRows, standInRows]) {
      expectKeywordRanks(byKeyword(await rows('alpha beta')), byteOrder);
    }

    // The fixture can tell the difference. By a language's collation, in this same
    // database, the six come out in another order.
    const dictionary = await db.query<{ source_id: string }>(
      `select source_id from agent_documents where source_id not like 'decoy%'
        order by source_id collate "und-x-icu"`,
    );
    expect(dictionary.rows.map((r) => r.source_id)).toEqual([
      'a-doc',
      `${SCRIPT_A}-doc`,
      'b_doc',
      'b-doc',
      'B-doc',
      `${FI_LIGATURE}-doc`,
    ]);
  });
});

// The same rule on the content the package ships: three documents, six passages.
describe('the keyword half on the shipped example content (SPEC §9.39)', () => {
  const EXAMPLE = fileURLToPath(new URL('../examples/client-content.example', import.meta.url));

  /**
   * Put the shipped example folder into both stores the way an ingest would: every chunk.
   * `degrees` places each passage, by a line of its text.
   */
  async function ingestExample(degrees: (content: string, n: number) => number): Promise<number> {
    let chunks = 0;
    for (const doc of readDocs(EXAMPLE)) {
      const row = await db.query<{ id: string }>(
        'insert into agent_documents (source_id, title, content_hash) values ($1, $2, $3) returning id',
        [doc.sourceId, doc.title, 'hash'],
      );
      const embedded = chunkMarkdown(doc.text).map((c) => ({
        ...c,
        embedding: at(degrees(c.content, chunks++)),
      }));
      for (const c of embedded) {
        await db.query(
          'insert into agent_chunks (document_id, chunk_index, content, embedding) values ($1, $2, $3, $4)',
          [row.rows[0]!.id, c.chunkIndex, c.content, literal(c.embedding)],
        );
      }
      await memory.upsertDocument(
        { sourceId: doc.sourceId, title: doc.title, contentHash: 'hash' },
        embedded.map((c) => ({
          chunkIndex: c.chunkIndex,
          content: c.content,
          embedding: c.embedding,
        })),
      );
    }
    return chunks;
  }
  /** Away from the query, so a shipped passage can only come back by keyword. */
  const awayFromTheQuery = (_content: string, n: number): number => 100 + n;
  const WATER_HEATERS = 'We repair and replace gas and electric water heaters.';

  it.each([
    { question: 'Do you fix water heaters?', file: 'services.md', says: WATER_HEATERS },
    {
      question: 'What time do you open on Saturday?',
      file: 'hours.md',
      says: 'Saturday, 9am to 1pm',
    },
    {
      question: 'Is there a travel fee outside the county?',
      file: 'service-area.md',
      says: 'carries a travel fee',
    },
    // The row this rule does not fix. The water-heater passage holds "repair" and "day",
    // two of the three words, so it gets the vote. The Heating passage, which is the one
    // about boilers, holds one and gets none.
    {
      question: 'Can you repair my boiler the same day?',
      file: 'services.md',
      says: WATER_HEATERS,
    },
    // An exact term inside a sentence: three of the five words are in one passage.
    { question: 'Is 555-0100 the number to call at night?', file: 'hours.md', says: '555-0100' },
    // By stem: "heater" finds "heaters".
    { question: 'Is a heater repair possible?', file: 'services.md', says: WATER_HEATERS },
  ])('"$question" gets one keyword vote, for the passage in $file (KC-3, KC-4)', async (row) => {
    await seed(decoys());
    expect(await ingestExample(awayFromTheQuery)).toBe(6);

    const votes = byKeyword(await sqlRows(row.question));

    // Exactly one, in first place in the keyword half.
    expect(votes).toHaveLength(1);
    expect(votes[0]!.sourceId).toBe(row.file);
    expect(votes[0]!.content).toContain(row.says);
    expect(votes[0]!.score).toBeCloseTo(1 / 61, 12);
  });

  it('gives no vote when the best passage holds exactly half of the words (KC-4)', async () => {
    await seed(decoys());
    await ingestExample(awayFromTheQuery);

    // "ring", "555", "-0100", "sunday": the passage with the number holds two of four.
    expect(byKeyword(await sqlRows('Can I ring 555-0100 on a Sunday?'))).toEqual([]);
  });

  it('the stand-in store does not stem: "heater" does not find "heaters" there (KC-15)', async () => {
    await seed(decoys());
    await ingestExample(awayFromTheQuery);
    const question = 'Is a heater repair possible?';

    expect(byKeyword(await sqlRows(question))).toHaveLength(1);
    expect(byKeyword(await standInRows(question))).toEqual([]);
    // Where no stem is involved the two agree: the passage says "water" and "heaters".
    const plural = byKeyword(await standInRows('Do you fix water heaters?'));
    expect(plural.map((r) => r.content.includes(WATER_HEATERS))).toEqual([true]);
  });

  it('the boiler question in the fusion: the keyword vote lifts the water-heater passage over the right one (KC-11)', async () => {
    // No decoys. The six shipped passages take vector ranks 1 to 6 in this order.
    const order = [
      'Heating',
      'Water heaters',
      'Emergencies',
      'Opening hours',
      'Service area',
      'Drains',
    ];
    const heading = (content: string): string => content.split('\n')[0]!.split(' > ').at(-1)!;
    await ingestExample((content) => order.indexOf(heading(content)) + 1);

    const rows = await sqlRows('Can you repair my boiler the same day?', 4);

    expect(rows.map((r) => heading(r.content))).toEqual([
      'Water heaters',
      'Heating',
      'Emergencies',
      'Opening hours',
    ]);
    // Water heaters: second by vector and the one keyword vote. Heating: first by vector
    // and nothing more. Emergencies holds "day" only, and gets nothing from the keyword half.
    expect(rows[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(rows[1]!.score).toBeCloseTo(1 / 61, 12);
    expect(rows[2]!.score).toBeCloseTo(1 / 63, 12);
    expect(rows[3]!.score).toBeCloseTo(1 / 64, 12);

    // Control: the same fixture under the every-word rule of 0.1.x. Its keyword half says
    // nothing, so the vector order stands and Heating is first. This is what the majority
    // rule gives up on this fixture.
    const before = await withFunction(publishedFunction(), () =>
      sqlRows('Can you repair my boiler the same day?', 4),
    );
    expect(before.map((r) => heading(r.content))).toEqual([
      'Heating',
      'Water heaters',
      'Emergencies',
      'Opening hours',
    ]);
    before.forEach((r, i) => expect(r.score).toBeCloseTo(1 / (61 + i), 12));
  });

  // The test above sets the vector ranks by hand. This one sets nothing: it is the path a
  // reader can run, with the shipped content embedded by the word-hash stand-in.
  it('on the runnable path the boiler passage is not among the four passages returned (SPEC §9.40)', async () => {
    const hasher = new FeatureHashEmbeddings();
    const embed = async (t: string): Promise<number[]> => (await hasher.embed([t]))[0]!;
    const question = 'Can you repair my boiler the same day?';
    // The passage about boilers, named by its heading so the test does not lean on its words.
    const isHeating = (r: { content: string }): boolean =>
      r.content.startsWith('Services > Heating');
    const docs = readDocs(EXAMPLE);

    // The stand-in store, filled the way the offline demo fills it; and Postgres, with the
    // same chunks and the same vectors.
    await ingestDocuments({ docs, embeddings: hasher, store: memory });
    for (const doc of docs) {
      const row = await db.query<{ id: string }>(
        'insert into agent_documents (source_id, title, content_hash) values ($1, $2, $3) returning id',
        [doc.sourceId, doc.title, 'hash'],
      );
      for (const c of chunkMarkdown(doc.text)) {
        await db.query(
          'insert into agent_chunks (document_id, chunk_index, content, embedding) values ($1, $2, $3, $4)',
          [row.rows[0]!.id, c.chunkIndex, c.content, literal(await embed(c.content))],
        );
      }
    }

    const offline = await retrieve({ query: question, embeddings: hasher, store: memory, topK: 4 });
    const onPostgres = await sqlRows(question, 4, await embed(question));

    for (const four of [offline, onPostgres]) {
      expect(four).toHaveLength(4);
      // The water-heater passage is first, and it got there by being in both lists.
      expect(four[0]!.content).toContain(WATER_HEATERS);
      expect(four[0]!.score).toBeGreaterThan(1 / 61);
      // The passage about boilers is not there. The word-hash embedder does not stem, so
      // "boiler" shares nothing with "boilers" and the vector half has no reason to bring
      // it. No rank is asserted: on Postgres it ties at the bottom with another passage.
      expect(four.some(isHeating)).toBe(false);
    }
    // In the stand-in store it is not returned at all, however many rows are asked for.
    const everything = await standInRows(question, 100, await embed(question));
    expect(everything.some(isHeating)).toBe(false);
    // It is in the content, and Postgres does return it when asked for every row: this
    // test is not passing because the passage is missing.
    const everyRow = await sqlRows(question, 100, await embed(question));
    expect(everyRow).toHaveLength(6);
    expect(everyRow.filter(isHeating)).toHaveLength(1);
  });
});

// A published migration file is never edited: the change to the function is a second file.
describe('two migration files (SPEC §9.39)', () => {
  it('upgrading applies the second file, and running the first again goes back (KC-14)', async () => {
    const [first, second] = migrationFiles();
    expect(migrationFiles()).toHaveLength(2);
    const fresh = new PGlite({ extensions: { vector } });
    try {
      const question = 'Do you fix water heaters?';
      const keywordVotes = async (): Promise<number> => {
        // One passage, so it is first in the vector half: 1/61. A keyword vote makes it 2/61.
        const rows = await fresh.query<{ rrf_score: number }>(
          'select rrf_score from ddj_match_chunks($1, $2, $3)',
          [literal(QUERY), question, 4],
        );
        expect(rows.rows).toHaveLength(1);
        return Math.round(rows.rows[0]!.rrf_score * 61) - 1;
      };
      const functions = async (): Promise<number> =>
        (
          await fresh.query<{ n: number }>(
            "select count(*)::int as n from pg_proc where proname = 'ddj_match_chunks'",
          )
        ).rows[0]!.n;

      // 0.1.x: the first file alone.
      await fresh.exec(fileSql(first!));
      const doc = await fresh.query<{ id: string }>(
        "insert into agent_documents (source_id, title, content_hash) values ('services.md', 'Services', 'hash') returning id",
      );
      await fresh.query(
        'insert into agent_chunks (document_id, chunk_index, content, embedding) values ($1, 0, $2, $3)',
        [doc.rows[0]!.id, 'We repair and replace gas and electric water heaters.', literal(at(1))],
      );
      expect(await keywordVotes()).toBe(0);

      // The upgrade: the second file, and nothing else.
      await fresh.exec(fileSql(second!));
      expect(await keywordVotes()).toBe(1);
      expect(await functions()).toBe(1);

      // Going back: the first file again.
      await fresh.exec(fileSql(first!));
      expect(await keywordVotes()).toBe(0);
      expect(await functions()).toBe(1);

      // And forward once more. The passage was there throughout.
      await fresh.exec(fileSql(second!));
      expect(await keywordVotes()).toBe(1);
      const kept = await fresh.query<{ n: number }>('select count(*)::int as n from agent_chunks');
      expect(kept.rows[0]!.n).toBe(1);
    } finally {
      await fresh.close();
    }
  }, 30_000);
});

// The function bounds a message. It does not bound a stored passage: the first migration
// builds the fts column from the passage as it is. This database keeps a broken copy of a
// passage word that folds past the limit, and a function that rebuilt such a value with its
// positions brought back nothing and left the database unable to answer. So the count reads
// a passage through strip(). This runs in a database of its own for that reason.
describe('a passage the server indexed wrongly (SPEC §9.39)', () => {
  it('does not stop the function answering (KC-26)', async () => {
    const own = new PGlite({ extensions: { vector } });
    try {
      await own.exec(migrationSql());
      const add = async (c: Chunk): Promise<void> => {
        const doc = await own.query<{ id: string }>(
          'insert into agent_documents (source_id, title, content_hash) values ($1, $2, $3) returning id',
          [c.id, `Title of ${c.id}`, 'hash'],
        );
        await own.query(
          'insert into agent_chunks (document_id, chunk_index, content, embedding) values ($1, 0, $2, $3)',
          [doc.rows[0]!.id, c.content, literal(c.embedding)],
        );
      };
      for (const c of [
        ...decoys(),
        chunk('wrapped', 101, `marker ${A_STROKE.repeat(683)}`),
        chunk('plain', 102, 'A marker by the drain.'),
      ]) {
        await add(c);
      }

      // The condition this test is about: the server kept the long word, broken. If a
      // server ever drops it instead, this is 1, the rest can no longer fail, and the test
      // says so here rather than passing quietly.
      const kept = await own.query<{ words: number }>(
        `select length(c.fts) as words from agent_chunks c
           join agent_documents d on d.id = c.document_id where d.source_id = 'wrapped'`,
      );
      expect(
        kept.rows[0]!.words,
        'the server no longer keeps the broken copy of the long word (it stored 1 word, not 2), so nothing below can fail any more',
      ).toBe(2);

      const ask = async (text: string): Promise<Row[]> =>
        (
          await own.query<{ source_id: string; rrf_score: number }>(
            'select source_id, rrf_score from ddj_match_chunks($1, $2, $3)',
            [literal(QUERY), text, 100],
          )
        ).rows.map((r) => ({ sourceId: r.source_id, content: '', score: r.rrf_score }));

      // A message sharing a word with that passage: every row comes back.
      const shared = await ask('marker');
      expect(shared).toHaveLength(14);
      expectKeywordRanks(byKeyword(shared), ['plain', 'wrapped']);
      // Two words asked: only the well-formed passage holds both.
      const two = await ask('marker drain');
      expect(two).toHaveLength(13);
      expectKeywordRanks(byKeyword(two), ['plain']);
      // And the database still answers.
      const count = await own.query<{ n: number }>('select count(*)::int as n from agent_chunks');
      expect(count.rows[0]!.n).toBe(14);
    } finally {
      await own.close();
    }
  }, 30_000);
});

// The stand-in store repeats the admission rule. These are the places it still parts from
// Postgres, each on a fixture where the two are seen to part.
describe('the stand-in store and Postgres (SPEC §9.39)', () => {
  it('drops the same 127 stop words Postgres drops (KC-15)', async () => {
    const file = await db.query<{ words: string }>(
      "select pg_read_file('../share/postgresql/tsearch_data/english.stop') as words",
    );
    const postgresList = file.rows[0]!.words.split(/\s+/).filter(Boolean);

    expect(postgresList).toHaveLength(127);
    expect(ENGLISH_STOP_WORDS.size).toBe(127);
    expect([...ENGLISH_STOP_WORDS].sort()).toEqual([...postgresList].sort());

    // Read back from Postgres itself, not from its file: each one leaves nothing behind.
    const kept = await db.query<{ word: string }>(
      `select word from unnest($1::text[]) as word
        where to_tsvector('english', word) <> ''::tsvector`,
      [[...ENGLISH_STOP_WORDS]],
    );
    expect(kept.rows).toEqual([]);
    // And what a contraction leaves behind is a word, in Postgres as here.
    const leftovers = ['m', 'll', 're', 've', 'won', 'isn'];
    const words = await db.query<{ word: string }>(
      `select word from unnest($1::text[]) as word
        where to_tsvector('english', word) <> ''::tsvector`,
      [leftovers],
    );
    expect(words.rows.map((r) => r.word).sort()).toEqual([...leftovers].sort());
    for (const word of leftovers) expect(ENGLISH_STOP_WORDS.has(word), word).toBe(false);
  });

  it('orders passages holding the same words by a plain count, where Postgres uses ts_rank (KC-15)', async () => {
    await seed([
      ...decoys(),
      chunk('lopsided', 101, 'alpha alpha alpha alpha beta'),
      chunk('even', 102, 'alpha alpha beta beta'),
    ]);

    // Both hold two of the three words. Postgres ranks the even one higher; the stand-in
    // counts five occurrences against four.
    expectKeywordRanks(byKeyword(await sqlRows('alpha beta gamma')), ['even', 'lopsided']);
    expectKeywordRanks(byKeyword(await standInRows('alpha beta gamma')), ['lopsided', 'even']);
  });

  it('splits a message into words its own way: letters and digits only (KC-15)', async () => {
    await seed([
      ...decoys(),
      chunk('heater-repair', 101, 'Water heater repair and installation.'),
      chunk('heater-apart', 102, 'A heater for hot water.'),
    ]);

    // Postgres reads an e-mail address as one word, which no passage holds. The stand-in
    // reads three words, "heater", "water" and "example", and both passages hold two.
    const address = 'heater@water.example';
    expect(byKeyword(await sqlRows(address))).toEqual([]);
    expect(ids(byKeyword(await standInRows(address)))).toEqual(['heater-apart', 'heater-repair']);
  });
});

describe('row-level security on real Postgres (SPEC §9.22)', () => {
  const as = async <T>(role: string, work: () => Promise<T>): Promise<T> => {
    await db.exec(`set role ${role}`);
    try {
      return await work();
    } finally {
      await db.exec('reset role');
    }
  };
  const count = async (table: string): Promise<number> =>
    (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;
  const fill = async (): Promise<void> => {
    await seed([chunk('faq', 1, 'beta')]);
    const convo = await db.query<{ id: string }>(
      'insert into agent_conversations default values returning id',
    );
    await db.query(
      "insert into agent_messages (conversation_id, role, content) values ($1, 'user', 'hi')",
      [convo.rows[0]!.id],
    );
    await db.query("insert into agent_events (type, payload) values ('user_message', '{}')");
  };
  afterEach(async () => {
    await db.exec('reset role');
  });

  it.each(['anon', 'authenticated'])(
    'a role that may not bypass it (%s) reads nothing and writes nothing',
    async (role) => {
      await fill();

      await as(role, async () => {
        // Granted every table, and still: no rows, from any of them or from the function.
        for (const table of TABLES) expect(await count(table), table).toBe(0);
        const hits = await db.query('select * from ddj_match_chunks($1, $2, $3)', [
          literal(QUERY),
          'beta',
          10,
        ]);
        expect(hits.rows).toEqual([]);

        await expect(db.query('insert into agent_conversations default values')).rejects.toThrow(
          /row-level security/,
        );
        const removed = await db.query('delete from agent_chunks');
        expect(removed.affectedRows).toBe(0);
        const changed = await db.query("update agent_documents set title = 'x'");
        expect(changed.affectedRows).toBe(0);
      });

      // Nothing was lost while it tried.
      for (const table of TABLES) expect(await count(table), table).toBe(1);
    },
  );

  it('the role that may bypass it reads and writes everything', async () => {
    await fill();

    await as('service_role', async () => {
      for (const table of TABLES) expect(await count(table), table).toBe(1);
      const hits = await db.query<{ source_id: string }>(
        'select source_id from ddj_match_chunks($1, $2, $3)',
        [literal(QUERY), 'beta', 10],
      );
      expect(hits.rows).toEqual([{ source_id: 'faq' }]);
      const made = await db.query('insert into agent_conversations default values');
      expect(made.affectedRows).toBe(1);
    });
  });
});

describe('the Supabase store against the real function (SPEC §9.22)', () => {
  const killSwitch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = killSwitch;
  });

  /**
   * Answer the one request `vectorStore.query()` makes by running it on Postgres. This
   * stands in for PostgREST for that single call: the JSON body's keys become the
   * function's named arguments, exactly as given, and the rows go back as JSON.
   */
  function answerRpcFromPostgres(): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const req = new Request(...args);
      const path = new URL(req.url).pathname;
      if (req.method !== 'POST' || path !== '/rest/v1/rpc/ddj_match_chunks') {
        throw new Error(`unexpected request: ${req.method} ${path}`);
      }
      const body = JSON.parse(await req.text()) as Record<string, unknown>;
      bodies.push(body);
      const names = Object.keys(body);
      const result = await db.query(
        `select * from ddj_match_chunks(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`,
        names.map((n) => body[n]),
      );
      return new Response(JSON.stringify(result.rows), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return bodies;
  }

  it('sends arguments the function accepts and maps its rows into RetrievedChunk', async () => {
    await seed([chunk('hours.md', 1, 'We open at nine.'), chunk('fees.md', 2, 'Call-out fee.')]);
    const bodies = answerRpcFromPostgres();
    const { vectorStore } = createSupabaseStores('http://supabase.test', 'test-service-role-key');

    const hits = await vectorStore.query({ embedding: QUERY, text: 'nine', limit: 5 });

    expect(Object.keys(bodies[0]!).sort()).toEqual([
      'match_count',
      'query_embedding',
      'query_text',
    ]);
    expect(hits).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        content: 'We open at nine.',
        sourceId: 'hours.md',
        title: 'Title of hours.md',
        url: undefined,
        score: expect.closeTo(1 / 61 + 1 / 61, 12),
      },
      {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        content: 'Call-out fee.',
        sourceId: 'fees.md',
        title: 'Title of fees.md',
        url: undefined,
        score: expect.closeTo(1 / 62, 12),
      },
    ]);
  });

  it('a full-sentence question gets its keyword match through the store as well', async () => {
    await seed([
      ...decoys(),
      chunk('water-heaters', 101, 'We repair and replace gas and electric water heaters.'),
      chunk('drains', 102, 'We clear blocked drains.'),
    ]);
    const bodies = answerRpcFromPostgres();
    const { vectorStore } = createSupabaseStores('http://supabase.test', 'test-service-role-key');

    const hits = await vectorStore.query({
      embedding: QUERY,
      text: 'Do you fix water heaters?',
      limit: 100,
    });

    // Thirteen rows: the twelve decoys from the vector half, and one passage that can only
    // have come back by keyword, in first place there.
    expect(hits).toHaveLength(13);
    const keywordHits = hits.filter((h) => !h.sourceId.startsWith('decoy'));
    expect(keywordHits.map((h) => h.sourceId)).toEqual(['water-heaters']);
    expect(keywordHits[0]!.score).toBeCloseTo(1 / 61, 12);
    // The request is the one the store has always sent: nothing new goes over the wire.
    expect(Object.keys(bodies[0]!).sort()).toEqual([
      'match_count',
      'query_embedding',
      'query_text',
    ]);
  });

  it('a turn retrieves through that store and that SQL, and the passage reaches the model', async () => {
    const hasher = new FeatureHashEmbeddings();
    const content = 'Saturday hours are nine to one.';
    const [embedding] = await hasher.embed([content]);
    await seed([{ id: 'hours.md', content, embedding: embedding! }]);
    answerRpcFromPostgres();
    const { vectorStore } = createSupabaseStores('http://supabase.test', 'test-service-role-key');
    const model = new MockModelClient([[textDelta('Nine to one.'), stop('end_turn')]]);
    const { agent } = buildAgent(model, { rag: { enabled: true } });
    const wired = { ...agent, runtime: { ...agent.runtime, vectorStore } };

    await collectTurn(wired, 'saturday hours');

    const sent = model.calls[0]!.messages.at(-1)!.content as string;
    expect(sent).toContain('<context>');
    expect(sent).toContain('[chunk 1 | source: hours.md | title: "Title of hours.md"]');
    expect(sent).toContain(content);
    expect(sent.endsWith('saturday hours')).toBe(true);
  });
});
