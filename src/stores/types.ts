/**
 * Dependency-injected persistence interfaces. Every store has a complete in-memory
 * implementation (stores/memory.ts) and a Supabase implementation (stores/supabase.ts).
 * Nothing here imports a database driver — these are pure contracts.
 */

export interface VisitorInfo {
  name?: string;
  email?: string;
}

export interface Conversation {
  id: string;
  status: 'open' | 'handed_off' | 'closed';
  visitor?: VisitorInfo;
  page?: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
}

/** A raw document read off disk / handed to the ingest pipeline. */
export interface IngestDoc {
  sourceId: string;
  title: string;
  text: string;
  url?: string;
}

/** Document metadata persisted alongside its chunks (carries the content hash). */
export interface IngestedDoc {
  sourceId: string;
  title: string;
  url?: string;
  contentHash: string;
}

export interface EmbeddedChunk {
  chunkIndex: number;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export interface RetrievedChunk {
  id: string;
  content: string;
  sourceId: string;
  title: string;
  url?: string;
  /** Fused relevance score (RRF, or reranker output). Higher is better. */
  score: number;
}

export interface VectorStore {
  getDocumentHash(sourceId: string): Promise<string | null>;
  /**
   * Replace-all for a single document: previous chunks for `sourceId` are dropped. An
   * implementation must record `contentHash` only once the new chunks are stored, because
   * ingest skips a document whose stored hash matches.
   */
  upsertDocument(doc: IngestedDoc, chunks: EmbeddedChunk[]): Promise<void>;
  /** Hybrid retrieval (vector + full-text, RRF-fused). Returns up to `limit` candidates. */
  query(q: { embedding: number[]; text: string; limit: number }): Promise<RetrievedChunk[]>;
}

export interface ConversationStore {
  create(meta: { visitor?: VisitorInfo; page?: string }): Promise<Conversation>;
  get(id: string): Promise<Conversation | null>;
  appendMessage(id: string, msg: StoredMessage): Promise<void>;
  /** Most recent `limit` messages, in ascending (chronological) order. */
  listMessages(id: string, limit: number): Promise<StoredMessage[]>;
  setStatus(id: string, status: 'open' | 'handed_off' | 'closed'): Promise<void>;
}
