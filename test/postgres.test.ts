/**
 * The migration and `ddj_match_chunks`, executed. PGlite is PostgreSQL compiled to
 * WebAssembly: a real Postgres with the real pgvector, running inside this process from
 * files in node_modules. No server, no Docker, no network.
 *
 * What this proves: that the SQL in supabase/migrations/ applies as written, that the
 * retrieval function ranks and fuses the way the README says, that row-level security shuts
 * out a role that is not allowed to bypass it, and that the constraints the stores lean on
 * are really there. Each fixture also runs through the memory store, so the places where
 * that stand-in differs from Postgres are asserted, not assumed.
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
  type VectorStore,
} from '../src/index.js';
import { MockModelClient, stop, textDelta } from '../src/testing/mock-model.js';
import { readDocs } from '../scripts/read-docs.js';
import { buildAgent, collectTurn } from './harness.js';

const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);
const migrationSql = (): string =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(new URL(f, MIGRATIONS), 'utf8'))
    .join('\n');

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
const withoutDecoys = (scores: Scores): string[] =>
  Object.keys(scores)
    .filter((id) => !id.startsWith('decoy'))
    .sort();

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

  it('reads a multi-word query the way websearch_to_tsquery does; the memory store does not', async () => {
    // The twelve decoys take the whole vector channel in both stores. Every chunk below
    // points away from the query, so it can only come back through the keyword channel.
    await seed([
      ...decoys(),
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
    ]);
    const keywordMatches = async (
      text: string,
    ): Promise<{ postgres: string[]; memory: string[] }> => {
      const result = await match(text);
      return { postgres: withoutDecoys(result.postgres), memory: withoutDecoys(result.memory) };
    };

    // Postgres: every word must be there, after stemming. Memory: any word, as typed.
    expect(await keywordMatches('opening hours')).toEqual({
      postgres: ['open-hours'],
      memory: ['hours-only', 'open-hours'],
    });
    // Stemming: "refunds" finds "Refund" in Postgres and nothing in memory.
    expect(await keywordMatches('refunds')).toEqual({ postgres: ['refund'], memory: [] });
    // A quoted phrase must appear as a phrase.
    expect(await keywordMatches('"water heater"')).toEqual({
      postgres: ['heater-repair'],
      memory: ['heater-apart', 'heater-repair'],
    });
    // `or` widens, in Postgres. (Memory finds the same two, by matching either word.)
    expect(await keywordMatches('drain or leak')).toEqual({
      postgres: ['drain', 'leak'],
      memory: ['drain', 'leak'],
    });
    // A leading minus excludes.
    expect(await keywordMatches('plumbing -heating')).toEqual({
      postgres: ['plumb-only'],
      memory: ['plumb-heat', 'plumb-only'],
    });
    // Stop words are dropped, so a query made only of them matches nothing in Postgres.
    expect(await keywordMatches('the of and')).toEqual({
      postgres: [],
      memory: ['heater-repair', 'leak', 'plumb-heat'],
    });
    // A whole question: Postgres wants "time", "open" and "saturday" all present, and no
    // chunk has "time". Shorten it to the words that matter and the chunk is found.
    expect(await keywordMatches('what time do you open on saturday')).toEqual({
      postgres: [],
      memory: ['open-hours', 'saturday'],
    });
    expect((await keywordMatches('open saturday')).postgres).toEqual(['saturday']);
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

// The whole of a visitor's message is the keyword query, and websearch_to_tsquery wants every
// word of it. This is that, on the content the package ships, so the README can say it.
describe('the keyword half on a full-sentence question (SPEC §9.33)', () => {
  const EXAMPLE = fileURLToPath(new URL('../examples/client-content.example', import.meta.url));
  const hasher = new FeatureHashEmbeddings();
  const embed = async (t: string): Promise<number[]> => (await hasher.embed([t]))[0]!;

  /** Put the shipped example folder into Postgres the way an ingest would: every chunk. */
  async function ingestExample(): Promise<number> {
    let chunks = 0;
    for (const doc of readDocs(EXAMPLE)) {
      const row = await db.query<{ id: string }>(
        'insert into agent_documents (source_id, title, content_hash) values ($1, $2, $3) returning id',
        [doc.sourceId, doc.title, 'hash'],
      );
      for (const c of chunkMarkdown(doc.text)) {
        await db.query(
          'insert into agent_chunks (document_id, chunk_index, content, embedding) values ($1, $2, $3, $4)',
          [row.rows[0]!.id, c.chunkIndex, c.content, literal(await embed(c.content))],
        );
        chunks++;
      }
    }
    return chunks;
  }
  const keywordMatches = async (text: string): Promise<number> =>
    (
      await db.query<{ n: number }>(
        "select count(*)::int as n from agent_chunks where fts @@ websearch_to_tsquery('english', $1)",
        [text],
      )
    ).rows[0]!.n;

  it('matches nothing by keyword, and the vector half still brings the passage back', async () => {
    expect(await ingestExample()).toBe(6);
    const question = 'Do you fix water heaters?';

    // Every word that is not a stop word must be in the chunk. No chunk says "fix".
    const parsed = await db.query<{ q: string }>(
      "select websearch_to_tsquery('english', $1)::text as q",
      [question],
    );
    expect(parsed.rows[0]!.q).toBe("'fix' & 'water' & 'heater'");
    expect(await keywordMatches(question)).toBe(0);
    // The words that matter, on their own, do find it.
    expect(await keywordMatches('water heaters')).toBe(1);

    // Asked the full question, the function still puts the right passage first. Its score is
    // a first place in the vector half and nothing from the keyword half.
    const hits = await db.query<{ source_id: string; content: string; rrf_score: number }>(
      'select source_id, content, rrf_score from ddj_match_chunks($1, $2, $3)',
      [literal(await embed(question)), question, 4],
    );
    expect(hits.rows[0]!.source_id).toBe('services.md');
    expect(hits.rows[0]!.content).toContain(
      'We repair and replace gas and electric water heaters.',
    );
    expect(hits.rows[0]!.rrf_score).toBeCloseTo(1 / 61, 12);
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
