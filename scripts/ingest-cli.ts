/**
 * The ingest CLI's logic, kept apart from its entry point (scripts/ingest.ts) so a test can
 * call it. See that file for usage.
 */
import { ingestDocuments } from '../src/rag/ingest.js';
import { createMemoryStores } from '../src/stores/memory.js';
import { FeatureHashEmbeddings } from '../src/rag/embed.js';
import { fromEnv } from '../src/config.js';
import { readDocs } from './read-docs.js';

/**
 * How long one request to the store may take during an ingest. One request carries every
 * chunk of a document, so it gets far longer than the two seconds a chat reply is given.
 */
export const INGEST_STORE_TIMEOUT_MS = 60_000;

const USAGE = 'Usage: tsx scripts/ingest.ts --dir <path> [--dry-run]';

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Run the CLI with these arguments. Throws with the usage line when `--dir` is missing. */
export async function runIngest(
  args: string[],
  log: (line: string) => void = console.log,
): Promise<void> {
  const dir = getArg(args, '--dir');
  const dryRun = args.includes('--dry-run');
  if (!dir) throw new Error(USAGE);

  const docs = readDocs(dir);
  log(`Found ${docs.length} document(s) under ${dir}`);

  if (dryRun) {
    const { vectorStore } = createMemoryStores();
    const res = await ingestDocuments({
      docs,
      embeddings: new FeatureHashEmbeddings(),
      store: vectorStore,
      dryRun: true,
      onProgress: (p) => log(`  [dry-run] ${p.sourceId}: ${p.chunks} chunk(s)`),
    });
    log(
      `DRY RUN — ${res.documents} doc(s), ${res.chunks} chunk(s). No embedding, no network, no store writes.`,
    );
    return;
  }

  const { runtime } = fromEnv({ storeTimeoutMs: INGEST_STORE_TIMEOUT_MS });
  const res = await ingestDocuments({
    docs,
    embeddings: runtime.embeddings,
    store: runtime.vectorStore,
    onProgress: (p) => log(`  ${p.status.padEnd(8)} ${p.sourceId} (${p.chunks} chunk(s))`),
  });
  log(
    `Done — ${res.ingested} ingested, ${res.skipped} unchanged, ${res.chunks} chunk(s), ` +
      `${res.embeddingCalls} embedding call(s).`,
  );
}
