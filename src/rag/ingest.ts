/**
 * Ingest pipeline: hash-skip → chunk → embed → upsert. The content-hash check happens
 * BEFORE embedding, so re-ingesting unchanged content costs zero embedding calls and zero
 * writes (idempotent). Changed content replaces all of that document's chunks.
 */
import type { EmbeddingProvider } from './embed.js';
import { chunkMarkdown, type ChunkOptions } from './chunk.js';
import type { EmbeddedChunk, IngestDoc, VectorStore } from '../stores/types.js';

export interface IngestDocProgress {
  sourceId: string;
  status: 'skipped' | 'ingested' | 'chunked';
  chunks: number;
}

export interface IngestOptions {
  docs: IngestDoc[];
  embeddings: EmbeddingProvider;
  store: VectorStore;
  chunkOptions?: ChunkOptions;
  /** Chunk and count only — no embedding, no store writes, no network, no env needed. */
  dryRun?: boolean;
  onProgress?: (info: IngestDocProgress) => void;
}

export interface IngestResult {
  documents: number;
  ingested: number;
  skipped: number;
  chunks: number;
  embeddingCalls: number;
}

export async function ingestDocuments(opts: IngestOptions): Promise<IngestResult> {
  const { docs, embeddings, store, chunkOptions, dryRun, onProgress } = opts;

  let ingested = 0;
  let skipped = 0;
  let chunkTotal = 0;
  let embeddingCalls = 0;

  for (const doc of docs) {
    const hash = await sha256Hex(doc.text);

    // Idempotency: skip BEFORE spending an embedding call.
    if (!dryRun) {
      const existing = await store.getDocumentHash(doc.sourceId);
      if (existing === hash) {
        skipped++;
        onProgress?.({ sourceId: doc.sourceId, status: 'skipped', chunks: 0 });
        continue;
      }
    }

    const textChunks = chunkMarkdown(doc.text, chunkOptions);
    chunkTotal += textChunks.length;

    if (dryRun) {
      onProgress?.({ sourceId: doc.sourceId, status: 'chunked', chunks: textChunks.length });
      continue;
    }

    const vectors = await embeddings.embed(textChunks.map((c) => c.content));
    embeddingCalls++;

    const embedded: EmbeddedChunk[] = textChunks.map((c, i) => ({
      chunkIndex: c.chunkIndex,
      content: c.content,
      embedding: vectors[i] ?? [],
      metadata: { breadcrumb: c.breadcrumb },
    }));

    await store.upsertDocument(
      { sourceId: doc.sourceId, title: doc.title, url: doc.url, contentHash: hash },
      embedded,
    );
    ingested++;
    onProgress?.({ sourceId: doc.sourceId, status: 'ingested', chunks: textChunks.length });
  }

  return { documents: docs.length, ingested, skipped, chunks: chunkTotal, embeddingCalls };
}

/** SHA-256 via Web Crypto — portable (Node/Workers/Deno), no `node:crypto` import. */
async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
