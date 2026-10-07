/**
 * Heading-aware markdown chunker. Deterministic (same input → identical chunks). A chunk
 * never spans a heading boundary, and every chunk is prefixed with its heading breadcrumb
 * so retrieved fragments stay self-locating.
 */

export interface ChunkOptions {
  maxChars?: number;
  overlap?: number;
}

export interface TextChunk {
  content: string;
  chunkIndex: number;
  /** e.g. "Pricing > Monthly plans" — the heading path this chunk lives under. */
  breadcrumb: string;
}

const DEFAULT_MAX_CHARS = 1500;
const DEFAULT_OVERLAP = 200;

interface Section {
  breadcrumb: string;
  body: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Split markdown into sections bounded by ATX headings, tracking the heading breadcrumb. */
function splitSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let body: string[] = [];

  const breadcrumb = (): string => stack.map((s) => s.title).join(' > ');
  const flush = (): void => {
    sections.push({ breadcrumb: breadcrumb(), body: body.join('\n') });
    body = [];
  };

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      flush(); // close the section that belonged to the previous breadcrumb
      const level = m[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: m[2]!.trim() });
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

/** Slide a fixed-size window with a fixed overlap. Consecutive windows overlap by `overlap`. */
function windowText(s: string, size: number, overlap: number): string[] {
  if (s.length <= size) return [s];
  const step = Math.max(1, size - overlap);
  const out: string[] = [];
  for (let start = 0; start < s.length; start += step) {
    out.push(s.slice(start, start + size));
    if (start + size >= s.length) break;
  }
  return out;
}

export function chunkMarkdown(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;

  const chunks: TextChunk[] = [];
  let index = 0;

  for (const section of splitSections(text)) {
    const body = section.body.trim();
    if (body.length === 0) continue;

    const prefix = section.breadcrumb ? `${section.breadcrumb}\n\n` : '';
    const budget = Math.max(1, maxChars - prefix.length);

    for (const window of windowText(body, budget, overlap)) {
      chunks.push({
        content: prefix + window,
        chunkIndex: index++,
        breadcrumb: section.breadcrumb,
      });
    }
  }

  return chunks;
}
