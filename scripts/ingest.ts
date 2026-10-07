/**
 * Content ingest CLI.
 *
 *   tsx scripts/ingest.ts --dir <path> [--dry-run]
 *
 * --dry-run chunks and prints stats only — no embedding, no store writes, no network, and
 * zero env required. Without --dry-run it builds a production runtime from env (fromEnv())
 * and upserts into the client's Supabase project (idempotent via content hash).
 *
 * This file is only the entry point. The logic is in scripts/ingest-cli.ts.
 */
import { runIngest } from './ingest-cli.js';

runIngest(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
