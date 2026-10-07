/**
 * Content ingest CLI.
 *
 *   tsx scripts/ingest.ts --dir <path> [--dry-run]
 *
 * --dry-run chunks and prints stats only — no embedding, no store writes, no network, and
 * zero env required. Without --dry-run it builds a production runtime from env (fromEnv())
 * and upserts into the client's Supabase project (idempotent via content hash).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { ingestDocuments } from '../src/rag/ingest.js';
import { createMemoryStores } from '../src/stores/memory.js';
import { FeatureHashEmbeddings } from '../src/rag/embed.js';
import { fromEnv } from '../src/config.js';
import type { IngestDoc } from '../src/stores/types.js';

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function deriveTitle(text: string, filename: string): string {
  const heading = /^#\s+(.+)$/m.exec(text);
  return heading ? heading[1]!.trim() : filename;
}

function readDocs(dir: string): IngestDoc[] {
  const out: IngestDoc[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const ext = extname(entry).toLowerCase();
      if (ext !== '.md' && ext !== '.txt') continue;
      const text = readFileSync(full, 'utf8');
      out.push({ sourceId: relative(dir, full), title: deriveTitle(text, entry), text });
    }
  };
  walk(dir);
  out.sort((a, b) => a.sourceId.localeCompare(b.sourceId)); // deterministic order
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = getArg(args, '--dir');
  const dryRun = args.includes('--dry-run');

  if (!dir) {
    console.error('Usage: tsx scripts/ingest.ts --dir <path> [--dry-run]');
    process.exit(1);
  }

  const docs = readDocs(dir);
  console.log(`Found ${docs.length} document(s) under ${dir}`);

  if (dryRun) {
    const { vectorStore } = createMemoryStores();
    const res = await ingestDocuments({
      docs,
      embeddings: new FeatureHashEmbeddings(),
      store: vectorStore,
      dryRun: true,
      onProgress: (p) => console.log(`  [dry-run] ${p.sourceId}: ${p.chunks} chunk(s)`),
    });
    console.log(
      `DRY RUN — ${res.documents} doc(s), ${res.chunks} chunk(s). No embedding, no network, no store writes.`,
    );
    return;
  }

  const { runtime } = fromEnv();
  const res = await ingestDocuments({
    docs,
    embeddings: runtime.embeddings,
    store: runtime.vectorStore,
    onProgress: (p) => console.log(`  ${p.status.padEnd(8)} ${p.sourceId} (${p.chunks} chunk(s))`),
  });
  console.log(
    `Done — ${res.ingested} ingested, ${res.skipped} unchanged, ${res.chunks} chunk(s), ` +
      `${res.embeddingCalls} embedding call(s).`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
