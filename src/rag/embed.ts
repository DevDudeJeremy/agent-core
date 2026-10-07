/**
 * Embeddings behind a swappable interface. Anthropic has no embeddings API, so the
 * production reference is Voyage (their recommended partner) over plain `fetch` — no extra
 * SDK. Tests and the offline demo use {@link FeatureHashEmbeddings}, a deterministic
 * bag-of-words hasher, so nothing touches the network.
 */

/** The single source of truth for embedding dimensionality. The SQL migration references it. */
export const EMBEDDING_DIM = 1024;

export interface EmbeddingProvider {
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** Lowercase alphanumeric word tokens. Shared by the hasher and the memory store's FTS proxy. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic feature-hashing embedder: bag-of-words → signed hashed histogram →
 * L2-normalized unit vector. Same text always yields the same vector, so retrieval is
 * fully reproducible offline. Not for production quality — it exists to make the RAG
 * pipeline testable without an embeddings API.
 */
export class FeatureHashEmbeddings implements EmbeddingProvider {
  readonly dimension: number;

  constructor(dimension: number = EMBEDDING_DIM) {
    this.dimension = dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const v = new Array<number>(this.dimension).fill(0);
    for (const token of tokenize(text)) {
      const idx = fnv1a(token) % this.dimension;
      const sign = (fnv1a(token + 'sign') & 1) === 1 ? 1 : -1;
      v[idx] = (v[idx] ?? 0) + sign;
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm === 0) return v;
    return v.map((x) => x / norm);
  }
}

export interface VoyageOptions {
  apiKey: string;
  model?: string;
  dimension?: number;
  baseUrl?: string;
}

/**
 * Production embeddings via Voyage AI. Reference implementation only — never exercised in
 * tests (the network kill switch throws). Swap for any provider that fits the interface.
 */
export class VoyageEmbeddings implements EmbeddingProvider {
  readonly dimension: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: VoyageOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'voyage-3';
    this.dimension = opts.dimension ?? EMBEDDING_DIM;
    this.baseUrl = opts.baseUrl ?? 'https://api.voyageai.com/v1/embeddings';
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: this.model }),
    });
    if (!res.ok) {
      throw new Error(`Voyage embeddings request failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    const rows = json.data ?? [];
    return rows.map((r) => r.embedding);
  }
}
