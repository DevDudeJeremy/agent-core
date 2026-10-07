/**
 * Full in-memory implementations of the stores — the substrate for tests, local dev, and
 * the offline demo. The vector store's hybrid `query()` uses the SQL function's fusion
 * ARITHMETIC — top-12 per channel, Reciprocal Rank Fusion at k=60, both pinned by a test —
 * and only APPROXIMATES everything else. Known differences (not a complete list):
 *  - no stemming or stop-word removal (Postgres `to_tsvector('english', …)` does both);
 *  - a multi-word query matches a chunk containing ANY of its words, where
 *    `websearch_to_tsquery` requires all of them;
 *  - full-text rank is a raw term count standing in for `ts_rank`;
 *  - vector matches scoring zero or less are dropped, where the SQL keeps the 12 nearest
 *    whatever their distance;
 *  - ties are broken by chunk id here; the SQL has no tie-breaker, so equal-ranked rows
 *    come back in whatever order Postgres picks.
 * Ranking on real Postgres is on the README's list of live checks.
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

/** Term-frequency proxy for Postgres `ts_rank`: total occurrences of query terms. */
function ftsScore(content: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const wanted = new Set(terms);
  let score = 0;
  for (const tok of tokenize(content)) {
    if (wanted.has(tok)) score++;
  }
  return score;
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

    // Channel 2: full-text (term frequency), top RRF_CANDIDATES.
    const terms = tokenize(q.text);
    const fts = sortRanked(
      all
        .map((chunk) => ({ chunk, score: ftsScore(chunk.content, terms) }))
        .filter((r) => r.score > 0),
    ).slice(0, RRF_CANDIDATES);

    // Reciprocal Rank Fusion (k = RRF_K).
    const fused = new Map<string, { chunk: MemChunk; score: number }>();
    const fuse = (list: Ranked[]): void => {
      list.forEach((item, i) => {
        const rank = i + 1;
        const contribution = 1 / (RRF_K + rank);
        const current = fused.get(item.chunk.id);
        if (current) current.score += contribution;
        else fused.set(item.chunk.id, { chunk: item.chunk, score: contribution });
      });
    };
    fuse(vector);
    fuse(fts);

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
