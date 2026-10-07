import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '../src/index.js';

describe('markdown chunker (SPEC §9.7)', () => {
  it('is deterministic — identical input yields identical chunks', () => {
    const text = '# Title\n\n' + 'lorem ipsum dolor sit amet '.repeat(200);
    expect(chunkMarkdown(text)).toEqual(chunkMarkdown(text));
  });

  it('never exceeds maxChars', () => {
    const text = 'x'.repeat(5000);
    for (const c of chunkMarkdown(text, { maxChars: 100, overlap: 20 })) {
      expect(c.content.length).toBeLessThanOrEqual(100);
    }
  });

  it('consecutive chunks overlap by the configured amount', () => {
    const body = '0123456789'.repeat(50); // 500 chars, no headings → empty breadcrumb
    const chunks = chunkMarkdown(body, { maxChars: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i++) {
      const tail = chunks[i]!.content.slice(-20);
      const head = chunks[i + 1]!.content.slice(0, 20);
      expect(head).toBe(tail);
    }
  });

  it('never spans an ## heading boundary', () => {
    const text = ['## Section A', 'AAA content here', '', '## Section B', 'BBB content here'].join(
      '\n',
    );
    for (const c of chunkMarkdown(text)) {
      const hasA = c.content.includes('AAA');
      const hasB = c.content.includes('BBB');
      expect(hasA && hasB).toBe(false);
    }
  });

  it('prefixes each chunk with its heading breadcrumb', () => {
    const text = ['# Top', '## Sub', 'the body text under sub'].join('\n');
    const chunks = chunkMarkdown(text);
    const sub = chunks.find((c) => c.content.includes('the body text under sub'))!;
    expect(sub.breadcrumb).toBe('Top > Sub');
    expect(sub.content.startsWith('Top > Sub')).toBe(true);
  });

  it('assigns sequential chunk indices across the whole document', () => {
    const text = ['# A', 'a'.repeat(300), '## B', 'b'.repeat(300)].join('\n');
    const chunks = chunkMarkdown(text, { maxChars: 120, overlap: 10 });
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });
});
