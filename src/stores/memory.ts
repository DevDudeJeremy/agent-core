/**
 * Full in-memory implementations of the stores — the substrate for tests, local dev, and
 * the offline demo. The vector store's hybrid `query()` repeats three things the SQL function
 * `ddj_match_chunks` does, and approximates the rest.
 *
 * The same as the SQL:
 *  - the fusion ARITHMETIC: top 12 per channel, Reciprocal Rank Fusion at k=60, equal
 *    weights, both numbers pinned by a test;
 *  - the keyword half's ADMISSION RULE: a chunk gets a keyword vote only when it holds more
 *    than half of the message's distinct words, after Postgres's own 127 English stop words
 *    are dropped (english-stop-words.ts). Admitted chunks are ordered by how many of the
 *    words they hold, then by how often, then by document and chunk;
 *  - the keyword half's BOUNDS, kept and not approximated: it reads the first 10,000
 *    characters of a message, and nothing in an unbroken run of 100 or more (a run is broken
 *    by a space, a tab, a line feed or a carriage return). Characters are counted the way
 *    Postgres counts them, by code point, not by the UTF-16 units of a JavaScript string;
 *    and documents are ordered by `sourceId` in code-point order, which is the byte order
 *    the SQL's `collate "C"` gives.
 *
 * Where it differs from Postgres. Five differences of behaviour, and none of bounds:
 *  - no stemming: "heater" does not find "heaters" here, and "refunds" does not find
 *    "Refund". Postgres finds both;
 *  - order among chunks holding the same number of the words is a plain count of
 *    occurrences, where Postgres uses `ts_rank`. They can disagree: for "alpha beta gamma",
 *    `alpha alpha alpha alpha beta` (5) comes before `alpha alpha beta beta` (4) here, and
 *    after it in Postgres;
 *  - a token is a run of ASCII letters and digits, nothing else. Postgres splits hyphens,
 *    signs, e-mail addresses, URLs and non-ASCII letters its own way, which can change how
 *    many words a message asks. "AR-4420" is `ar` and `4420` here; in Postgres it is `ar`
 *    and `-4420`. And 99 non-ASCII letters are a word asked to Postgres and nothing here;
 *  - vector matches scoring zero or less are dropped, where the SQL keeps the 12 nearest
 *    whatever their distance;
 *  - ties in the fused score are broken by chunk id here; the SQL leaves them unordered.
 *
 * One more difference, outside retrieval, which no test asserts: these stores accept text
 * holding a NUL character or an unpaired surrogate. A database behind Supabase does not.
 * The HTTP handler refuses a request body holding either before any store is called
 * (SPEC §9.41). It checks nothing else: a model's reply and a tool's input reach these
 * stores as they are.
 *
 * What this stand-in cannot prove: NOTHING ABOUT STEMMING, nothing about how a server
 * indexes a stored passage (its tokens never grow when folded, so it cannot show a passage
 * word a server indexes wrongly), and nothing about what a database refuses to store. A
 * keyword match that depends on a plural or a tense is only ever exercised by
 * test/postgres.test.ts, which runs the same fixtures through this store and through the
 * SQL on a real Postgres and asserts each of the five differences above.
 */
import type {
  Conversation,
  ConversationStore,
  EmbeddedChunk,
  IngestedDoc,
  RetrievedChunk,
  StoredMessage,
  VectorStore,
} from './types.js';
import { RRF_CANDIDATES, RRF_K } from '../rag/retrieve.js';
import { tokenize } from '../rag/embed.js';
import { ENGLISH_STOP_WORDS } from './english-stop-words.js';

interface MemChunk {
  id: string;
  sourceId: string;
  title: string;
  url?: string;
  content: string;
  embedding: number[];
  chunkIndex: number;
}

interface MemDoc {
  hash: string;
  chunks: MemChunk[];
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * What a chunk holds of the words a message asks: how many distinct ones (`held`), and how
 * often in all (`occurrences`, the stand-in for Postgres `ts_rank`).
 */
function keywordCounts(
  content: string,
  asked: ReadonlySet<string>,
): { held: number; occurrences: number } {
  const held = new Set<string>();
  let occurrences = 0;
  for (const tok of tokenize(content)) {
    if (asked.has(tok)) {
      held.add(tok);
      occurrences++;
    }
  }
  return { held: held.size, occurrences };
}

/**
 * Code-point order, which is the byte order of UTF-8 and so what the SQL's `collate "C"`
 * gives. Plain `<` compares UTF-16 units and parts from it above U+FFFF; `localeCompare`
 * parts from it at the first capital letter.
 */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < x.length && i < y.length; i++) {
    const difference = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return x.length - y.length;
}

/** How much of a message the keyword half reads, and the longest unbroken run it reads. */
const KEYWORD_MAX_CHARACTERS = 10_000;
const UNBROKEN_RUN = /[^ \t\n\r]{100}[^ \t\n\r]*/gu;

/**
 * What the keyword half reads of a message, as the SQL reads it: the first 10,000
 * characters, then every unbroken run of 100 or more replaced by a space. The cut comes
 * first. Both numbers count code points: a character above U+FFFF is one character, though
 * it is two units of a JavaScript string.
 */
function keywordText(message: string): string {
  let read = '';
  let characters = 0;
  for (const character of message) {
    if (characters === KEYWORD_MAX_CHARACTERS) break;
    read += character;
    characters++;
  }
  return read.replace(UNBROKEN_RUN, ' ');
}

interface Ranked {
  chunk: MemChunk;
  score: number;
}

/** Deterministic: score desc, then id asc so ties never reorder between runs. */
function sortRanked(list: Ranked[]): Ranked[] {
  return [...list].sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
}

class MemoryVectorStore implements VectorStore {
  private readonly docs = new Map<string, MemDoc>();

  async getDocumentHash(sourceId: string): Promise<string | null> {
    return this.docs.get(sourceId)?.hash ?? null;
  }

  async upsertDocument(doc: IngestedDoc, chunks: EmbeddedChunk[]): Promise<void> {
    const memChunks: MemChunk[] = chunks.map((c) => ({
      id: `${doc.sourceId}#${c.chunkIndex}`,
      sourceId: doc.sourceId,
      title: doc.title,
      url: doc.url,
      content: c.content,
      embedding: c.embedding,
      chunkIndex: c.chunkIndex,
    }));
    this.docs.set(doc.sourceId, { hash: doc.contentHash, chunks: memChunks });
  }

  async query(q: { embedding: number[]; text: string; limit: number }): Promise<RetrievedChunk[]> {
    const all: MemChunk[] = [];
    for (const d of this.docs.values()) all.push(...d.chunks);

    // Channel 1: vector (cosine), top RRF_CANDIDATES.
    const vector = sortRanked(
      all
        .map((chunk) => ({ chunk, score: cosine(q.embedding, chunk.embedding) }))
        .filter((r) => r.score > 0),
    ).slice(0, RRF_CANDIDATES);

    // Channel 2: keyword. The words asked are the distinct words of what the keyword half
    // reads of the message, without stop words. A chunk is admitted only when it holds more
    // than half of them; nothing is admitted when nothing is asked. Order: words held,
    // occurrences, document, chunk.
    const asked = new Set(
      tokenize(keywordText(q.text)).filter((word) => !ENGLISH_STOP_WORDS.has(word)),
    );
    const keyword = all
      .map((chunk) => ({ chunk, ...keywordCounts(chunk.content, asked) }))
      .filter((k) => 2 * k.held > asked.size)
      .sort(
        (a, b) =>
          b.held - a.held ||
          b.occurrences - a.occurrences ||
          byCodePoint(a.chunk.sourceId, b.chunk.sourceId) ||
          a.chunk.chunkIndex - b.chunk.chunkIndex,
      )
      .slice(0, RRF_CANDIDATES);

    // Reciprocal Rank Fusion (k = RRF_K).
    const fused = new Map<string, { chunk: MemChunk; score: number }>();
    const fuse = (list: { chunk: MemChunk }[]): void => {
      list.forEach((item, i) => {
        const rank = i + 1;
        const contribution = 1 / (RRF_K + rank);
        const current = fused.get(item.chunk.id);
        if (current) current.score += contribution;
        else fused.set(item.chunk.id, { chunk: item.chunk, score: contribution });
      });
    };
    fuse(vector);
    fuse(keyword);

    return sortRanked([...fused.values()].map((f) => ({ chunk: f.chunk, score: f.score })))
      .slice(0, q.limit)
      .map(({ chunk, score }) => ({
        id: chunk.id,
        content: chunk.content,
        sourceId: chunk.sourceId,
        title: chunk.title,
        url: chunk.url,
        score,
      }));
  }
}

class MemoryConversationStore implements ConversationStore {
  private readonly convos = new Map<string, Conversation>();
  private readonly messages = new Map<string, StoredMessage[]>();

  async create(meta: { visitor?: Conversation['visitor']; page?: string }): Promise<Conversation> {
    const now = new Date().toISOString();
    const convo: Conversation = {
      id: crypto.randomUUID(),
      status: 'open',
      visitor: meta.visitor,
      page: meta.page,
      createdAt: now,
      lastActiveAt: now,
    };
    this.convos.set(convo.id, convo);
    this.messages.set(convo.id, []);
    return convo;
  }

  async get(id: string): Promise<Conversation | null> {
    return this.convos.get(id) ?? null;
  }

  async appendMessage(id: string, msg: StoredMessage): Promise<void> {
    const list = this.messages.get(id);
    if (!list) throw new Error(`Unknown conversation: ${id}`);
    list.push({
      role: msg.role,
      content: msg.content,
      createdAt: msg.createdAt ?? new Date().toISOString(),
    });
    const convo = this.convos.get(id);
    if (convo) convo.lastActiveAt = new Date().toISOString();
  }

  async listMessages(id: string, limit: number): Promise<StoredMessage[]> {
    const list = this.messages.get(id) ?? [];
    return list.slice(Math.max(0, list.length - limit));
  }

  async setStatus(id: string, status: Conversation['status']): Promise<void> {
    const convo = this.convos.get(id);
    if (convo) convo.status = status;
  }
}

export function createMemoryStores(): {
  vectorStore: VectorStore;
  conversations: ConversationStore;
} {
  return { vectorStore: new MemoryVectorStore(), conversations: new MemoryConversationStore() };
}
