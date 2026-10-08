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

/**
 * True when `at` falls between the two units of one character above U+FFFF: a high half
 * (U+D800 to U+DBFF) just before it and a low half (U+DC00 to U+DFFF) just after.
 */
function insideCharacter(s: string, at: number): boolean {
  if (at <= 0 || at >= s.length) return false;
  const before = s.charCodeAt(at - 1);
  const after = s.charCodeAt(at);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * Slide a fixed-size window with a fixed overlap, both counted in the units of a JavaScript
 * string. A character above U+FFFF is two units, and an edge that would fall between the two
 * moves one unit into its own window: an end one unit earlier, a start one unit later. So a
 * window stops before such a character or begins after it and never holds half of one
 * (SPEC §9.42). Consecutive windows share `overlap` units, less one for each of their two
 * edges that moved. Text that already holds an unpaired surrogate is left as it is.
 */
function windowText(s: string, size: number, overlap: number): string[] {
  if (s.length <= size) return [s];
  const step = Math.max(1, size - overlap);
  /** The windows share nothing, so no neighbour holds what one of them leaves out. */
  const apart = step === size;
  const out: string[] = [];
  for (let start = 0; start < s.length;) {
    const end = Math.min(s.length, start + size);
    const from = insideCharacter(s, start) ? start + 1 : start;
    let to = insideCharacter(s, end) ? end - 1 : end;
    // The slice is asked whether anything is left, not the two positions: a size that is
    // not a whole number can put them a fraction apart over no text.
    let piece = s.slice(from, to);
    // Apart and nothing left: there was room for one unit and the character is two. The
    // window takes the whole character, the one case where it is longer than `size`.
    if (apart && !piece) {
      to = from + 2;
      piece = s.slice(from, to);
    }
    // Elsewhere a window with nothing left in it is not emitted.
    if (piece) out.push(piece);
    if (end >= s.length) break;
    // Apart, the next window begins where this one really ended, so the character this one
    // stopped before is the first of the next. Otherwise it begins where it always did.
    start = apart ? to : start + step;
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
