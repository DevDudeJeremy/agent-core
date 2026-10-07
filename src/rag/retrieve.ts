/**
 * Retrieval: embed the query, pull a hybrid RRF-fused candidate pool from the store, run
 * the (optional) reranker, and return the top-K. The fusion math lives in the store
 * (SQL function `ddj_match_chunks`; the memory store repeats its arithmetic). This is the
 * thin orchestrator.
 */
import type { EmbeddingProvider } from './embed.js';
import type { RetrievedChunk, VectorStore } from '../stores/types.js';

/** Reranker hook. Default is identity; a cross-encoder (Voyage/Cohere) lands here per client. */
export type Reranker = (query: string, candidates: RetrievedChunk[]) => Promise<RetrievedChunk[]>;

/** Candidates pulled per channel (vector, full-text) before RRF fusion. */
export const RRF_CANDIDATES = 12;
/** Reciprocal Rank Fusion constant. Matches the SQL function exactly. */
export const RRF_K = 60;

export interface RetrieveParams {
  query: string;
  embeddings: EmbeddingProvider;
  store: VectorStore;
  topK: number;
  reranker?: Reranker;
}

export async function retrieve(params: RetrieveParams): Promise<RetrievedChunk[]> {
  const { query, embeddings, store, topK, reranker } = params;

  const [embedding] = await embeddings.embed([query]);
  if (!embedding) return [];

  // Ask the store for the full fused pool (up to 12 vector + 12 fts) so the reranker has
  // something to reorder before we slice to topK.
  const poolLimit = Math.max(topK, RRF_CANDIDATES * 2);
  const candidates = await store.query({ embedding, text: query, limit: poolLimit });

  const ranked = reranker ? await reranker(query, candidates) : candidates;
  return ranked.slice(0, topK);
}
