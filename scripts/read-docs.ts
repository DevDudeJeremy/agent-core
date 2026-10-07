/**
 * Read a folder of content into IngestDoc[]: every `.md` and `.txt` under it, with the path
 * relative to the folder as the document's source id. Shared by the ingest CLI and the
 * examples. It lives outside `src/` because reading files is Node-only and the core is not.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { IngestDoc } from '../src/stores/types.js';

function deriveTitle(text: string, filename: string): string {
  const heading = /^#\s+(.+)$/m.exec(text);
  return heading ? heading[1]!.trim() : filename;
}

export function readDocs(dir: string): IngestDoc[] {
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
      // Forward slashes on every system, so a document keeps one id wherever it is ingested.
      const sourceId = relative(dir, full).split(sep).join('/');
      out.push({ sourceId, title: deriveTitle(text, entry), text });
    }
  };
  walk(dir);
  out.sort((a, b) => a.sourceId.localeCompare(b.sourceId)); // deterministic order
  return out;
}
