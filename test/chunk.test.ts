import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  chunkMarkdown,
  createMemoryStores,
  FeatureHashEmbeddings,
  ingestDocuments,
  type TextChunk,
  type VectorStore,
} from '../src/index.js';

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

// ---------------------------------------------------------------------------------------
// SPEC §9.42: a chunk never holds half of a character.
//
// A character above U+FFFF is two units of a JavaScript string: a high half (U+D800 to
// U+DBFF), then a low half (U+DC00 to U+DFFF). A half without its other half is an unpaired
// surrogate, and Postgres refuses to store one. Everything below is ASCII: each character
// above U+007F is built from its number, so nothing on the way here can have changed one.
// ---------------------------------------------------------------------------------------

const cp = (n: number): string => String.fromCodePoint(n);
const unit = (n: number): string => String.fromCharCode(n);
/** U+1F600, two units: D83D then DE00. */
const FACE = cp(0x1f600);
const isHigh = (u: number): boolean => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number): boolean => u >= 0xdc00 && u <= 0xdfff;

/** Where the unpaired surrogates are in a string, found by walking its units. */
function unpairedAt(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (isHigh(u)) {
      if (i + 1 < s.length && isLow(s.charCodeAt(i + 1))) i++;
      else out.push(i);
    } else if (isLow(u)) {
      out.push(i);
    }
  }
  return out;
}

/** The runtime's own answer. `isWellFormed` is not in the ES2023 typings this compiles against. */
const runtimeSaysIllFormed = (s: string): boolean =>
  !(s as unknown as { isWellFormed(): boolean }).isWellFormed();

/** Does this text hold an unpaired surrogate? Asked both ways; the two must agree. */
function holdsHalf(s: string): boolean {
  const walk = unpairedAt(s).length > 0;
  if (walk !== runtimeSaysIllFormed(s)) throw new Error('the two tests for a half disagree');
  return walk;
}

/** One section: a heading (or none) and the text under it. */
interface Doc {
  title: string;
  body: string;
}
interface Settings {
  maxChars?: number;
  overlap?: number;
}
const asMarkdown = (d: Doc): string => (d.title ? `# ${d.title}\n\n${d.body}\n` : d.body);
const prefixOf = (d: Doc): string => (d.title ? `${d.title}\n\n` : '');
const chunk = (d: Doc, s: Settings = {}): TextChunk[] => chunkMarkdown(asMarkdown(d), s);
/** The text of each chunk without its heading prefix. */
const bodies = (d: Doc, chunks: TextChunk[]): string[] =>
  chunks.map((c) => {
    if (!c.content.startsWith(prefixOf(d))) throw new Error('a chunk lacks its heading prefix');
    return c.content.slice(prefixOf(d).length);
  });

/**
 * `windowText` exactly as it was before SPEC §9.42, in 0.2.0 as published: windows counted in
 * units and nothing else. Kept here so that "the bytes it chunked to before" has something
 * to be held against that the chunker under test cannot change. The hashes in RECORDED bind
 * this copy to that code itself.
 */
function windowsByUnits(s: string, size: number, overlap: number): string[] {
  if (s.length <= size) return [s];
  const step = Math.max(1, size - overlap);
  const out: string[] = [];
  for (let start = 0; start < s.length; start += step) {
    out.push(s.slice(start, start + size));
    if (start + size >= s.length) break;
  }
  return out;
}
/** The room for text under this heading, and how far each window is from the one before. */
function arithmetic(d: Doc, s: Settings = {}): { size: number; step: number } {
  const size = Math.max(1, (s.maxChars ?? 1500) - prefixOf(d).length);
  return { size, step: Math.max(1, size - (s.overlap ?? 200)) };
}
/** One section as the earlier windowing chunked it. */
function chunkByUnits(d: Doc, s: Settings = {}): TextChunk[] {
  const { size } = arithmetic(d, s);
  return windowsByUnits(d.body, size, s.overlap ?? 200).map((w, i) => ({
    content: prefixOf(d) + w,
    chunkIndex: i,
    breadcrumb: d.title,
  }));
}
/** A window of well-formed text less the half character at its start, at its end, or both. */
function lessHalves(w: string): string {
  const from = w.length > 0 && isLow(w.charCodeAt(0)) ? 1 : 0;
  const to = w.length > 0 && isHigh(w.charCodeAt(w.length - 1)) ? w.length - 1 : w.length;
  return w.slice(from, Math.max(from, to));
}
/** JSON.stringify writes an unpaired surrogate as an escape, so no two lists share a text. */
const sha = (chunks: TextChunk[]): string =>
  createHash('sha256').update(JSON.stringify(chunks), 'utf8').digest('hex');

// ---- the documents of the measurement --------------------------------------------------

const BAKERY_TITLE = 'Example Bakery: orders and hours';
/** [the number of the character that opens the paragraph, the paragraph]. A made-up shop. */
const BAKERY_LINES: Array<[number, string]> = [
  [
    0x1f44b,
    'Welcome to Example Bakery. This page answers the questions we hear most at the counter and on the phone.',
  ],
  [
    0x1f552,
    'We are open Tuesday to Saturday from 7 in the morning until 3 in the afternoon, and Sunday from 8 until noon.',
  ],
  [
    0x1f4cd,
    'You will find us at 12 Example Street, two doors down from the post office, with the green awning.',
  ],
  [
    0x1f17f,
    'Park behind the building. The lot is free for customers and the back door is open during shop hours.',
  ],
  [
    0x1f950,
    'Croissants come out of the oven at 7 and again at 10. On Saturdays they are usually gone by 11.',
  ],
  [
    0x1f35e,
    'Sourdough is baked every day we are open. Rye is baked on Wednesday and Saturday only.',
  ],
  [
    0x1f382,
    'Custom cakes need five days of notice. Wedding cakes need three weeks and a tasting visit.',
  ],
  [
    0x1f9c1,
    'Cupcakes can be ordered by the dozen with two days of notice. Six flavours are on the list at the counter.',
  ],
  [
    0x1f36a,
    'Cookie trays for offices and schools serve twelve, twenty-four or forty-eight people.',
  ],
  [
    0x1f4de,
    'To order, call the shop during opening hours or use the order form on this site at any time.',
  ],
  [
    0x1f4c5,
    'Pick a collection day when you order. We hold an order until closing time on that day.',
  ],
  [
    0x1f4b3,
    'We take cards and cash. A deposit of half the price is taken for any order over one hundred dollars.',
  ],
  [
    0x1f69a,
    'Delivery is offered within five miles for orders over fifty dollars, for a flat fee of eight dollars.',
  ],
  [
    0x1f33e,
    'We bake with wheat flour every day. We offer two gluten-free loaves, baked first thing on Thursday.',
  ],
  [
    0x1f95c,
    'Nuts are used in this kitchen. We cannot promise that any item is free of traces of nuts.',
  ],
  [0x1f381, 'Gift cards are sold at the counter in any amount from ten dollars and do not expire.'],
  [
    0x1f389,
    'For a party, ask about the celebration box: a cake, twelve cupcakes and a tray of cookies at one price.',
  ],
  [
    0x1f552,
    'If you are running late for a collection, call us. We can leave a paid order with the cafe next door.',
  ],
  [
    0x1f4de,
    'To change or cancel an order, call at least two days before the collection day for a full refund of the deposit.',
  ],
  [0x1f35e, 'Day-old bread is sold at half price from the basket by the door, while it lasts.'],
  [
    0x1f950,
    'Pastry boxes for meetings hold twelve or twenty-four pieces. Order by noon the day before.',
  ],
  [0x1f382, 'We write a short message on any cake at no charge. Tell us the words when you order.'],
  [0x1f4c5, 'We close for the first week of January and for the last week of August every year.'],
  [
    0x1f69a,
    'We do not ship by mail. Bread and cakes do not travel well and we would rather you had them fresh.',
  ],
  [
    0x1f33e,
    'A list of ingredients for every item is kept in the binder at the counter. Ask and we will show you.',
  ],
  [0x1f4b3, 'Schools and charities can ask for an invoice instead of paying at collection.'],
  [0x1f381, 'A loyalty card gets a stamp for every loaf. The tenth loaf is free.'],
  [
    0x1f9c1,
    'Classes for children run on the first Sunday of the month. Places are limited to eight.',
  ],
  [
    0x1f4cd,
    'On Saturdays we also have a stall at the farmers market by the river, from 8 until 1.',
  ],
  [
    0x1f44b,
    'If your question is not answered here, ask in the chat or call the shop. We are glad to help.',
  ],
];
/** The page with no character above U+007F at all. */
const bakeryPlain = (): Doc => ({
  title: BAKERY_TITLE,
  body: BAKERY_LINES.map(([, line]) => line).join('\n\n'),
});
/** The page as someone might write it, each paragraph opening with an emoji, after `shift` letters. */
const bakeryWithEmoji = (shift = 0): Doc => ({
  title: BAKERY_TITLE,
  body: 'a'.repeat(shift) + BAKERY_LINES.map(([n, line]) => `${cp(n)} ${line}`).join('\n\n'),
});
/** A line of 800 party emoji, four kinds in turn, between two sentences. */
function dividerPage(word: 'cake' | 'cakes'): Doc {
  const kinds = [0x1f389, 0x1f388, 0x1f382, 0x1f381];
  const divider = Array.from({ length: 800 }, (_, i) => cp(kinds[i % 4]!)).join('');
  const before = `We set up, we clean up, and the ${word} is on us.`;
  return {
    title: 'Party packages',
    body: `${before}\n\n${divider}\n\nBook two weeks ahead for a weekend.`,
  };
}
/** Made-up words in Gothic letters (U+10330 to U+1034A), a script wholly above U+FFFF. */
const GOTHIC_WORDS = ((): string => {
  let seed = 12345;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const words: string[] = [];
  while (words.join(' ').length < 3000) {
    let word = '';
    for (let i = 2 + next(6); i > 0; i--) word += cp(0x10330 + next(27));
    words.push(word);
  }
  return words.join(' ');
})();
const gothicWords = (shift = 0): Doc => ({
  title: 'Gothic',
  body: 'a'.repeat(shift) + GOTHIC_WORDS,
});

/**
 * [the document, whether the earlier windowing cut a character in it, the SHA-256 of the
 * chunks it made]. The hashes were recorded by running the package's own chunker on these
 * documents before it was changed. That file was the same bytes in 0.2.0 as published.
 */
const RECORDED: Array<[string, boolean, string]> = [
  [
    'the letters-only page',
    false,
    'c0bdf62ec7221962ec8e6c311e6cb354a5ab75626592cfc4b4f833e227375b97',
  ],
  [
    '5,000 letters with no break',
    false,
    '58cb39257802833a04226fce9a34b00aefb1d1c810d17f5f03d585d85ee0f9ef',
  ],
  [
    '0 letter(s) then 2,000 copies of U+1F600',
    false,
    '760308cdb9964edf271a7d6f894327f20f26d54f24f1626c556c45b3dd343517',
  ],
  [
    '1 letter(s) then 2,000 copies of U+1F600',
    true,
    '75ca34fde56d6e89fc64662bd3daeca59654910e2ed10e5f43456b797b7f7c1c',
  ],
  [
    '2 letter(s) then 2,000 copies of U+1F600',
    false,
    '214a88ced5086904280118307f7a97df8299c66dd424c1237ea7909ad1386d97',
  ],
  [
    '3 letter(s) then 2,000 copies of U+1F600',
    true,
    'ece5c17da423145bc915dc3c160bd1f2443645be2bde2ee3f35813f5507b31ac',
  ],
  [
    '4 letter(s) then 2,000 copies of U+1F600',
    false,
    'a82bfff643c9b3ecf98ffe567d03617557bdab7f5aeec7d69c9c324c8503756f',
  ],
  [
    '5 letter(s) then 2,000 copies of U+1F600',
    true,
    'b463095837ea8c5008896a5ef98db152acecd651beb0bfd87d22b5e250901457',
  ],
  [
    '2,000 copies of U+1F600 under a heading of 1 letter(s)',
    true,
    'b1ffc715858279952a4ce3cbcfda5c992b05add632fb70f42b3fd4b70b6529a0',
  ],
  [
    '2,000 copies of U+1F600 under a heading of 2 letter(s)',
    false,
    'e4aff3d3d467be25d67fb9549a10a90d8bef1cf86cbfeb2c2d6993465e2a5cb2',
  ],
  [
    '2,000 copies of U+1F600 under a heading of 3 letter(s)',
    true,
    'a8f870eb2150605127f3607f58094199d95ed34b5af6f4557fd72cbda4ba328d',
  ],
  [
    '2,000 copies of U+1F600 under a heading of 4 letter(s)',
    false,
    'a4c615382443ad4eacfcf328ceecbda8fd5d1979ad063bde4d19b1cadfab7769',
  ],
  [
    '2,000 copies of U+1F600 under a heading of 5 letter(s)',
    true,
    'e52396f36cbd3567cef267366b6c98c84d7a5d5338b1951b6863e91404a00067',
  ],
  [
    '2,000 copies of U+1F600 under a heading of 6 letter(s)',
    false,
    'b15e5dec0082cd471550bd6aa303ab01ff6cda633bd443d39cd4e01437674449',
  ],
  [
    '2,000 copies of U+1F600 under a heading of 7 letter(s)',
    true,
    '9ef64ef092e707ffe3e6395e5f94aea2e286c5fd45b13c5797be8a0e5e2373ec',
  ],
  [
    '2,000 copies of U+1F600 under a heading of 8 letter(s)',
    false,
    '328d13e21c737358683fa1e191ec8ac9af2b5667acec8e6d99b6e66e72c40157',
  ],
  [
    'the letters-only page with one U+1F600 put at unit 1464',
    false,
    'e3768381d79d0fc5629981b41d4f070c4b183a3ae9bb67a4ebae0822502aeb27',
  ],
  [
    'the letters-only page with one U+1F600 put at unit 1465',
    true,
    '7072c14af4a5ddcca603dbec3746a6465ba177f5b5b7b86b16525216145d9f31',
  ],
  [
    'the letters-only page with one U+1F600 put at unit 1466',
    false,
    '4442e9f9b78b8fa71019c0f6c8b3559a589a16bb64a132160dbdef2290d789a4',
  ],
  [
    'the emoji page as written',
    false,
    '106d56c07ad90a888fdaa22b497eaeee5f3b60985a8b0d456cae2975ae5dee6d',
  ],
  [
    'the emoji page with 32 letter(s) in front',
    true,
    '0c7e47109cf7224666c8e195079b3d2a0dd978b59aceb62e073bbbaf673505d2',
  ],
  [
    'a line of 800 emoji between two sentences',
    false,
    'b9a1577d837e4c610fd18f7f705f7ce63c669e66589985fe7cba8f321f8e88ed',
  ],
  [
    'the same with "cake" changed to "cakes"',
    true,
    'fbf223eae516c07cbaf3756d400f78bbc531275743a262f85ee1c786df4d57fc',
  ],
  [
    '329 words in Gothic letters',
    true,
    '9c40c1e710ec6163cb0183ccd04b8160d30a5e99cd6912f467b5d5abf30d1bab',
  ],
];
function namedDocuments(): Map<string, Doc> {
  const docs = new Map<string, Doc>();
  const plain = bakeryPlain();
  const { size } = arithmetic(plain);
  docs.set('the letters-only page', plain);
  docs.set('5,000 letters with no break', { title: '', body: 'x'.repeat(5000) });
  for (let k = 0; k <= 5; k++) {
    docs.set(`${k} letter(s) then 2,000 copies of U+1F600`, {
      title: '',
      body: 'x'.repeat(k) + FACE.repeat(2000),
    });
  }
  for (let n = 1; n <= 8; n++) {
    docs.set(`2,000 copies of U+1F600 under a heading of ${n} letter(s)`, {
      title: 'Heading!'.slice(0, n),
      body: FACE.repeat(2000),
    });
  }
  for (const at of [size - 2, size - 1, size]) {
    docs.set(`the letters-only page with one U+1F600 put at unit ${at}`, {
      title: plain.title,
      body: plain.body.slice(0, at) + FACE + plain.body.slice(at),
    });
  }
  docs.set('the emoji page as written', bakeryWithEmoji(0));
  docs.set('the emoji page with 32 letter(s) in front', bakeryWithEmoji(32));
  docs.set('a line of 800 emoji between two sentences', dividerPage('cake'));
  docs.set('the same with "cake" changed to "cakes"', dividerPage('cakes'));
  docs.set('329 words in Gothic letters', gothicWords());
  return docs;
}
const NAMED = namedDocuments();
const named = (name: string): Doc => {
  const d = NAMED.get(name);
  if (!d) throw new Error(`no document named ${name}`);
  return d;
};

/** Letters that never repeat a stretch, so a chunk can be found in its text by content. */
const counted = (units: number): string => {
  let s = '';
  for (let i = 0; s.length < units; i++) s += `w${i} `;
  return s.slice(0, units - 1) + 'z';
};
/** Put `what` into `s` so that its first unit is unit `at`. */
const putAt = (s: string, at: number, what: string): string => s.slice(0, at) + what + s.slice(at);
/** How many units each pair of neighbouring chunks shares, by where each chunk lies in the text. */
function shared(d: Doc, chunks: TextChunk[]): number[] {
  const places = bodies(d, chunks).map((b) => {
    const at = d.body.indexOf(b);
    if (at < 0 || d.body.indexOf(b, at + 1) >= 0) throw new Error('a chunk is not in one place');
    return { start: at, end: at + b.length };
  });
  return places.slice(1).map((p, i) => places[i]!.end - p.start);
}

describe('a chunk never holds half of a character (SPEC §9.42)', () => {
  it('the test for an unpaired surrogate gives the known answer, asked two ways', () => {
    const known: Array<[string, number]> = [
      ['abc', 0],
      [FACE, 0],
      [unit(0xd83d), 1],
      [unit(0xde00), 1],
      ['a' + unit(0xd83d) + 'b', 1],
      [unit(0xde00) + unit(0xd83d), 2],
      [FACE.slice(0, 1), 1],
      [FACE.slice(1), 1],
      [(FACE + FACE).slice(0, 2), 0],
    ];
    for (const [text, expected] of known) {
      expect(unpairedAt(text).length).toBe(expected);
      expect(runtimeSaysIllFormed(text)).toBe(expected > 0);
    }
  });

  it('the copy of the earlier windowing reproduces the hashes recorded before the chunker was changed', () => {
    expect(RECORDED.map(([name]) => name)).toEqual([...NAMED.keys()]);
    for (const [name, cut, hash] of RECORDED) {
      const before = chunkByUnits(named(name));
      expect([name, sha(before)]).toEqual([name, hash]);
      expect([name, before.some((c) => holdsHalf(c.content))]).toEqual([name, cut]);
    }
    expect(RECORDED.filter(([, cut]) => cut).length).toBe(11);
  });

  describe('the documents of the measurement', () => {
    it.each(RECORDED.filter(([, cut]) => cut))(
      '%s (cut before): no chunk holds an unpaired surrogate',
      (name) => {
        const d = named(name);
        const before = chunkByUnits(d);
        const after = chunk(d);
        expect(after.filter((c) => holdsHalf(c.content)).length).toBe(0);
        // Each chunk is the earlier chunk at that place less the half at its edge.
        expect(bodies(d, after)).toEqual(bodies(d, before).map(lessHalves));
        expect(after.map((c) => [c.chunkIndex, c.breadcrumb])).toEqual(
          before.map((c) => [c.chunkIndex, c.breadcrumb]),
        );
        for (const c of after) expect(c.content.length).toBeLessThanOrEqual(1500);
        // The chunks did change: this is not one of the documents that chunk as before.
        expect(sha(after)).not.toBe(sha(before));
      },
    );

    it.each(RECORDED.filter(([, cut]) => !cut))(
      '%s (not cut before): the chunks are the bytes recorded before the change',
      (name, _cut, hash) => {
        const after = chunk(named(name));
        expect(sha(after)).toBe(hash);
        expect(after).toEqual(chunkByUnits(named(name)));
      },
    );
  });

  it('the emoji page with 0 to 1,265 letters in front: none is cut, and the 1,211 that were not cut before are the same bytes', () => {
    const cutNow: number[] = [];
    const cutBefore: number[] = [];
    const changed: number[] = [];
    for (let shift = 0; shift <= 1265; shift++) {
      const d = bakeryWithEmoji(shift);
      const before = chunkByUnits(d);
      const after = chunk(d);
      if (after.some((c) => holdsHalf(c.content))) cutNow.push(shift);
      if (before.some((c) => holdsHalf(c.content))) cutBefore.push(shift);
      else if (sha(after) !== sha(before)) changed.push(shift);
    }
    expect(cutNow).toEqual([]);
    expect(changed).toEqual([]);
    // The numbers of the measurement: the fixture cuts where it was measured to.
    expect(cutBefore.length).toBe(55);
    expect(cutBefore[0]).toBe(32);
  });

  it('the Gothic words with 0 to 1,291 letters in front: none is cut, and the 128 that were not cut before are the same bytes', () => {
    const cutNow: number[] = [];
    const changed: number[] = [];
    let cutBefore = 0;
    for (let shift = 0; shift <= 1291; shift++) {
      const d = gothicWords(shift);
      const before = chunkByUnits(d);
      const after = chunk(d);
      if (after.some((c) => holdsHalf(c.content))) cutNow.push(shift);
      if (before.some((c) => holdsHalf(c.content))) cutBefore++;
      else if (sha(after) !== sha(before)) changed.push(shift);
    }
    expect(cutNow).toEqual([]);
    expect(changed).toEqual([]);
    expect(cutBefore).toBe(1164);
  });

  describe('a sweep of leading offsets, heading lengths and settings', () => {
    /** [maxChars, overlap]. Ordinary ones, then the corners: no overlap, more overlap than room, a negative one, one to three units of room. */
    const SETTINGS: Array<[number, number]> = [
      [100, 20],
      [64, 0],
      [50, 1],
      [50, 2],
      [33, 10],
      [12, 3],
      [8, 0],
      [7, 7],
      [6, 9],
      [5, 2],
      [4, 1],
      [4, 0],
      [3, 1],
      [3, 0],
      [2, 1],
      [2, 0],
      [1, 0],
      [1, 3],
      [10, -3],
      [3, -1],
    ];
    const HEADINGS = ['', 'H', 'He', 'Hea'];
    /** A fixed rule for "random": the same numbers on every run. */
    const mixed = (seedFrom: number): string => {
      let seed = seedFrom >>> 0;
      let s = '';
      for (let i = 0; i < 90; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        s += seed % 3 === 0 ? cp(0x1f300 + (seed % 200)) : 'abcdefghijklmnopqrstuvwxyz'[seed % 26]!;
      }
      return s;
    };
    const TEXTS: Array<[string, string]> = [
      ['sixty copies of U+1F600', FACE.repeat(60)],
      ['U+1F600 and two letters, forty times', (FACE + 'ab').repeat(40)],
      ['U+1F600 and one letter, fifty times', (FACE + 'a').repeat(50)],
      ['letters and characters above U+FFFF in a fixed mixed order', mixed(7)],
      ['letters only', 'abcdefghij'.repeat(20)],
    ];

    interface Case {
      label: string;
      d: Doc;
      s: Settings;
      size: number;
      step: number;
      before: TextChunk[];
      after: TextChunk[];
    }
    let built: Case[] | undefined;
    /** Chunked when a test first asks, not when the file is read. */
    const sweep = (): Case[] => (built ??= build());
    const build = (): Case[] => {
      const cases: Case[] = [];
      for (const [maxChars, overlap] of SETTINGS) {
        for (const title of HEADINGS) {
          for (const [what, text] of TEXTS) {
            for (let lead = 0; lead <= 7; lead++) {
              const d: Doc = { title, body: 'x'.repeat(lead) + text };
              const s: Settings = { maxChars, overlap };
              cases.push({
                label: `maxChars ${maxChars}, overlap ${overlap}, heading "${title}", ${lead} letter(s) then ${what}`,
                d,
                s,
                ...arithmetic(d, s),
                before: chunkByUnits(d, s),
                after: chunk(d, s),
              });
            }
          }
        }
      }
      return cases;
    };
    /** Every character of a text, as [its first unit, how many units it is]. */
    const characters = (s: string): Array<[number, number]> => {
      const out: Array<[number, number]> = [];
      for (let at = 0; at < s.length;) {
        const width =
          isHigh(s.charCodeAt(at)) && at + 1 < s.length && isLow(s.charCodeAt(at + 1)) ? 2 : 1;
        out.push([at, width]);
        at += width;
      }
      return out;
    };

    it('the sweep is the size it says and holds both kinds of document', () => {
      const cases = sweep();
      expect(cases.length).toBe(20 * 4 * 5 * 8);
      const cutBefore = cases.filter((c) => c.before.some((b) => holdsHalf(b.content)));
      // Counted with the copy of the earlier windowing, so not by the chunker under test.
      expect(cutBefore.length).toBe(2270);
      expect(cases.length - cutBefore.length).toBe(930);
    });

    it('no chunk of any of them holds an unpaired surrogate, and the heading and the indexes are as before', () => {
      const failed: string[] = [];
      for (const c of sweep()) {
        if (c.after.some((a) => holdsHalf(a.content))) failed.push(c.label);
        else if (c.after.some((a, i) => a.chunkIndex !== i || a.breadcrumb !== c.d.title))
          failed.push(`${c.label} (index or heading)`);
      }
      expect(failed).toEqual([]);
    });

    it('a document that was not cut before chunks to exactly the bytes it did, at every setting', () => {
      const failed: string[] = [];
      for (const c of sweep()) {
        if (c.before.some((b) => holdsHalf(b.content))) continue;
        if (sha(c.after) !== sha(c.before)) failed.push(c.label);
      }
      expect(failed).toEqual([]);
    });

    it('where windows share text or leave gaps, each chunk is the earlier chunk at that place less the halves at its edges', () => {
      const failed: string[] = [];
      let compared = 0;
      for (const c of sweep()) {
        if (c.step === c.size) continue;
        compared++;
        const expected = bodies(c.d, c.before)
          .map(lessHalves)
          .filter((b) => b.length > 0);
        if (JSON.stringify(bodies(c.d, c.after)) !== JSON.stringify(expected)) failed.push(c.label);
        // As many chunks as before, once a window is three units or more.
        else if (c.size >= 3 && c.step < c.size && c.after.length !== c.before.length)
          failed.push(`${c.label} (count)`);
      }
      expect(failed).toEqual([]);
      expect(compared).toBe(1600);
    });

    it('no chunk is longer than the room for it; with one unit of room a chunk is one whole character', () => {
      const failed: string[] = [];
      let twoUnitChunks = 0;
      // Counted from the texts, not from the chunks: with one unit of room and no gaps, each
      // character above U+FFFF is one chunk of two units.
      let twoUnitCharacters = 0;
      for (const c of sweep()) {
        if (c.size === 1 && c.step === 1) {
          twoUnitCharacters += characters(c.d.body).filter(([, width]) => width === 2).length;
        }
        for (const b of bodies(c.d, c.after)) {
          if (b.length === 0) failed.push(`${c.label} (an empty chunk)`);
          else if (c.size > 1 && b.length > c.size) failed.push(`${c.label} (${b.length} units)`);
          else if (c.size === 1 && b.length > 1) {
            if (b.length === 2 && !holdsHalf(b) && characters(b).length === 1) twoUnitChunks++;
            else failed.push(`${c.label} (${b.length} units in one unit of room)`);
          }
        }
      }
      expect(failed).toEqual([]);
      expect(twoUnitCharacters).toBeGreaterThan(10000);
      expect(twoUnitChunks).toBe(twoUnitCharacters);
    });

    it('every character of the text is whole in at least one chunk, when overlap is 0 or more', () => {
      const failed: string[] = [];
      let checked = 0;
      for (const c of sweep()) {
        if ((c.s.overlap ?? 0) < 0) continue;
        checked++;
        // Where each chunk lies in the text. The texts repeat, so a chunk cannot be found by
        // its content: its place is worked out, then the chunk is held to be that stretch.
        const places: Array<[number, number]> = [];
        if (c.step === c.size) {
          // Windows that share nothing: each chunk begins where the one before it ended.
          let from = 0;
          for (const b of bodies(c.d, c.after)) {
            places.push([from, from + b.length]);
            from += b.length;
          }
        } else {
          // Each window on the arithmetic's place, an edge inside a character one unit inward.
          for (let start = 0; start < c.d.body.length; start += c.step) {
            const end = Math.min(c.d.body.length, start + c.size);
            const from = start > 0 && isLow(c.d.body.charCodeAt(start)) ? start + 1 : start;
            const to =
              end < c.d.body.length && isHigh(c.d.body.charCodeAt(end - 1)) ? end - 1 : end;
            if (to > from) places.push([from, to]);
            if (end >= c.d.body.length) break;
          }
        }
        const stretches = places.map(([from, to]) => c.d.body.slice(from, to));
        if (JSON.stringify(stretches) !== JSON.stringify(bodies(c.d, c.after))) {
          failed.push(`${c.label} (the chunks are not where they were worked out to be)`);
          continue;
        }
        for (const [at, width] of characters(c.d.body)) {
          if (!places.some(([start, end]) => start <= at && at + width <= end)) {
            failed.push(`${c.label} (the character at unit ${at} is whole in no chunk)`);
            break;
          }
        }
      }
      expect(failed).toEqual([]);
      expect(checked).toBe(18 * 4 * 5 * 8);
    });

    it('with an overlap of 0 the chunks join back into the text', () => {
      const failed: string[] = [];
      let checked = 0;
      for (const c of sweep()) {
        if (c.s.overlap !== 0) continue;
        checked++;
        if (bodies(c.d, c.after).join('') !== c.d.body) failed.push(c.label);
      }
      expect(failed).toEqual([]);
      expect(checked).toBe(6 * 4 * 5 * 8);
    });
  });

  describe('what neighbours share at the defaults (1,500 units a chunk, 200 shared)', () => {
    // No heading, so the first chunk ends at unit 1500 and the second starts at unit 1300.
    const letters = counted(3000);

    it('200 where no edge moved', () => {
      const d: Doc = { title: '', body: letters };
      expect(shared(d, chunk(d))).toEqual([200, 200]);
    });
    it('199 where the earlier chunk would have ended inside a character', () => {
      const d: Doc = { title: '', body: putAt(letters, 1499, FACE) };
      expect(shared(d, chunk(d))).toEqual([199, 200]);
      expect(bodies(d, chunk(d))[0]).toBe(d.body.slice(0, 1499));
    });
    it('199 where the later chunk would have started inside a character', () => {
      const d: Doc = { title: '', body: putAt(letters, 1299, FACE) };
      expect(shared(d, chunk(d))).toEqual([199, 200]);
      expect(bodies(d, chunk(d))[1]).toBe(d.body.slice(1301, 2800));
    });
    it('198 where both would have', () => {
      const d: Doc = { title: '', body: putAt(putAt(letters, 1299, FACE), 1499, FACE) };
      expect(shared(d, chunk(d))).toEqual([198, 200]);
    });
    it('a character one unit clear of an edge moves nothing', () => {
      for (const at of [1298, 1300, 1498, 1500]) {
        const d: Doc = { title: '', body: putAt(letters, at, FACE) };
        expect(chunk(d)).toEqual(chunkByUnits(d));
        expect(shared(d, chunk(d))).toEqual([200, 200]);
      }
    });
  });

  describe('the characters at the corners of the two ranges of halves', () => {
    /** D800 and DBFF are the first and the last high half; DC00 and DFFF the first and the last low half. */
    const CORNERS: Array<[string, number, number, number]> = [
      ['U+10000 (D800 then DC00)', 0x10000, 0xd800, 0xdc00],
      ['U+103FF (D800 then DFFF)', 0x103ff, 0xd800, 0xdfff],
      ['U+10FC00 (DBFF then DC00)', 0x10fc00, 0xdbff, 0xdc00],
      ['U+10FFFF (DBFF then DFFF)', 0x10ffff, 0xdbff, 0xdfff],
    ];
    const letters = counted(3000);
    it.each(CORNERS)(
      '%s across the end of a chunk, and across the start of the next, is in neither as a half',
      (_name, n, high, low) => {
        const c = cp(n);
        expect([c.length, c.charCodeAt(0), c.charCodeAt(1)]).toEqual([2, high, low]);
        const atEnd: Doc = { title: '', body: putAt(letters, 1499, c) };
        expect(bodies(atEnd, chunk(atEnd))[0]).toBe(atEnd.body.slice(0, 1499));
        expect(shared(atEnd, chunk(atEnd))).toEqual([199, 200]);
        const atStart: Doc = { title: '', body: putAt(letters, 1299, c) };
        expect(bodies(atStart, chunk(atStart))[1]).toBe(atStart.body.slice(1301, 2800));
        expect(shared(atStart, chunk(atStart))).toEqual([199, 200]);
        expect([...chunk(atEnd), ...chunk(atStart)].filter((x) => holdsHalf(x.content))).toEqual(
          [],
        );
      },
    );
  });

  describe('text that is already ill formed is left as it is', () => {
    const letters = counted(3000);
    const high = unit(0xd83d);
    const low = unit(0xde00);
    /** Each text holds a half with no other half beside it, at or next to a window's edge. */
    const ILL_FORMED: Array<[string, string]> = [
      ['a high half as the last unit of the first window', putAt(letters, 1499, high)],
      ['a high half as the first unit after it', putAt(letters, 1500, high)],
      ['a low half as the first unit of the second window', putAt(letters, 1300, low)],
      ['a low half as the last unit before it', putAt(letters, 1299, low)],
      ['a low half as the first unit after the first window', putAt(letters, 1500, low)],
      ['a high half as the last unit before the second window', putAt(letters, 1299, high)],
      [
        'two halves the wrong way round across the end of the first window',
        putAt(letters, 1499, low + high),
      ],
      [
        'two halves the wrong way round across the start of the second',
        putAt(letters, 1299, low + high),
      ],
      [
        'a high half, a letter, then a low half across an edge',
        putAt(letters, 1498, high + 'q' + low),
      ],
      ['two high halves across an edge', putAt(letters, 1499, high + high)],
      ['two low halves across an edge', putAt(letters, 1499, low + low)],
    ];
    it.each(ILL_FORMED)("%s: the chunks are exactly the earlier windowing's", (_what, body) => {
      const d: Doc = { title: '', body };
      expect(holdsHalf(body)).toBe(true);
      expect(chunk(d)).toEqual(chunkByUnits(d));
    });

    it('none is added: beside a whole character moved off an edge, a chunk holds the halves the text held there', () => {
      // A high half alone at unit 10, and a whole U+1F600 across the end of the first window.
      const d: Doc = { title: '', body: putAt(putAt(letters, 10, high), 1499, FACE) };
      const after = bodies(d, chunk(d));
      expect(after[0]).toBe(d.body.slice(0, 1499));
      expect(after.map((b) => unpairedAt(b))).toEqual([[10], [], []]);
      expect(unpairedAt(d.body)).toEqual([10]);
    });
  });

  describe('windows that share nothing', () => {
    it('with an overlap of 0, a chunk begins where the one before it really ended', () => {
      const d: Doc = { title: '', body: 'abc' + FACE + 'defgh' };
      const s = { maxChars: 4, overlap: 0 };
      expect(bodies(d, chunkByUnits(d, s))).toEqual(['abc' + FACE[0], FACE[1] + 'def', 'gh']);
      expect(bodies(d, chunk(d, s))).toEqual(['abc', FACE + 'de', 'fgh']);
    });
    it('with one unit of room, a chunk is one whole character, which can be two units', () => {
      const d: Doc = { title: '', body: 'a' + FACE + 'b' };
      expect(bodies(d, chunk(d, { maxChars: 1, overlap: 0 }))).toEqual(['a', FACE, 'b']);
      // Under a heading that leaves one unit: the chunk holding U+1F600 is maxChars and one.
      const h: Doc = { title: 'H', body: 'a' + FACE + 'b' };
      const chunks = chunk(h, { maxChars: 4, overlap: 0 });
      expect(chunks.map((c) => c.content)).toEqual(['H\n\na', 'H\n\n' + FACE, 'H\n\nb']);
      expect(chunks.map((c) => c.content.length)).toEqual([4, 5, 4]);
    });
  });

  describe('text that is already ill formed, where windows share nothing', () => {
    const high = unit(0xd83d);
    const low = unit(0xde00);
    /** [the setting, what the text is, the text]. No whole character lies on an edge in any. */
    const CASES: Array<[Settings, string, string]> = [
      [
        { maxChars: 4, overlap: 0 },
        'a high half as the last unit of a window',
        'abc' + high + 'defgh',
      ],
      [
        { maxChars: 4, overlap: 0 },
        'a low half as the first unit of a window',
        'abcd' + low + 'efgh',
      ],
      [
        { maxChars: 4, overlap: 0 },
        'two halves the wrong way round across an edge',
        'abc' + low + high + 'efgh',
      ],
      [{ maxChars: 4, overlap: 0 }, 'two high halves across an edge', 'abc' + high + high + 'efgh'],
      [
        { maxChars: 1, overlap: 0 },
        'one unit of room: a high half alone, a low half alone',
        'a' + high + 'b' + low + 'c',
      ],
      [
        { maxChars: 1, overlap: 0 },
        'one unit of room: two halves the wrong way round',
        'a' + low + high + 'b',
      ],
      [
        { maxChars: 1, overlap: 0 },
        'one unit of room: a high half as the last unit of the text',
        'ab' + high,
      ],
      [
        { maxChars: 1, overlap: 3 },
        'one unit of room and an overlap: two high halves',
        'a' + high + high + 'b',
      ],
    ];
    it.each(CASES)("%o, %s: the chunks are exactly the earlier windowing's", (s, _what, body) => {
      const d: Doc = { title: '', body };
      expect(holdsHalf(body)).toBe(true);
      expect(chunk(d, s)).toEqual(chunkByUnits(d, s));
    });
  });

  describe('sizes that are not whole numbers', () => {
    /** [maxChars, overlap]: cut where `slice` cuts them, as before. */
    const FRACTIONS: Array<[number, number]> = [
      [1.5, 0],
      [2.5, 0],
      [2.5, 0.5],
      [3.7, 1.2],
      [10.25, 3.5],
    ];
    const TEXTS = [
      FACE + 'abc',
      'a' + FACE + 'bcd',
      FACE.repeat(12),
      // At maxChars 2.5 and overlap 0.5 the windows of this one share no text, and every
      // window after the first is left with nothing in it. No chunk is empty; the twelve
      // characters are in no chunk, which SPEC §9.42 does not hold at such a setting.
      'a' + FACE.repeat(12),
      ('ab' + FACE).repeat(9),
      'abcdefghijklmnop',
    ];

    it('no chunk is empty or holds an unpaired surrogate, and with an overlap of 0 the chunks join back', () => {
      const failed: string[] = [];
      for (const [maxChars, overlap] of FRACTIONS) {
        for (const body of TEXTS) {
          const d: Doc = { title: '', body };
          const after = bodies(d, chunk(d, { maxChars, overlap }));
          const label = `maxChars ${maxChars}, overlap ${overlap}, ${body.length} units`;
          if (after.some((b) => b.length === 0)) failed.push(`${label} (an empty chunk)`);
          if (after.some(holdsHalf)) failed.push(`${label} (a half)`);
          if (overlap === 0 && after.join('') !== body)
            failed.push(`${label} (does not join back)`);
        }
      }
      expect(failed).toEqual([]);
    });
    it('the one that gave an empty chunk: U+1F600 and three letters at maxChars 1.5', () => {
      const d: Doc = { title: '', body: FACE + 'abc' };
      expect(bodies(d, chunk(d, { maxChars: 1.5, overlap: 0 }))).toEqual([FACE, 'a', 'bc']);
    });
    it('with a room just over one unit, each chunk is still one whole character', () => {
      const d: Doc = { title: '', body: 'a' + FACE.repeat(3) + 'b' };
      // A guard that compared two positions would move on by 2 ** -40 of a unit a pass here,
      // and this test would not finish.
      expect(bodies(d, chunk(d, { maxChars: 1 + 2 ** -40, overlap: 0 }))).toEqual([
        'a',
        FACE,
        FACE,
        FACE,
        'b',
      ]);
    });
    it('a sweep of 972: no half and no empty chunk, an overlap of 0 joins back, the same bytes where nothing was cut', () => {
      // What is held at these sizes, and no more: whether every character is whole in some
      // chunk is not (SPEC §9.42 holds that for whole numbers).
      const SIZES = [1.0000001, 1.2, 1.5, 1.9999999, 2.5, 3.3, 4.75, 7.5, 10.25];
      const OVERLAPS = [0, 0.5, 1, 1.5, 2.5, 9];
      /** Forty characters, each used once: letters from U+4E00 on, characters above U+FFFF from U+20100 on. */
      const each = (seedFrom: number): string => {
        let seed = seedFrom >>> 0;
        let text = '';
        for (let nth = 0; nth < 40; nth++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          text += seed % 5 < 2 ? cp(0x20100 + nth) : cp(0x4e00 + nth);
        }
        return text;
      };
      const failed: string[] = [];
      let cases = 0;
      let cutBefore = 0;
      for (const maxChars of SIZES) {
        for (const overlap of OVERLAPS) {
          for (let seed = 1; seed <= 6; seed++) {
            for (let lead = 0; lead <= 2; lead++) {
              cases++;
              const d: Doc = { title: '', body: 'x'.repeat(lead) + each(seed) };
              const s: Settings = { maxChars, overlap };
              const label = `maxChars ${maxChars}, overlap ${overlap}, text ${seed}, ${lead} letter(s) in front`;
              const before = bodies(d, chunkByUnits(d, s));
              const after = bodies(d, chunk(d, s));
              if (after.some((b) => b.length === 0)) failed.push(`${label} (an empty chunk)`);
              if (after.some(holdsHalf)) failed.push(`${label} (a half)`);
              if (overlap === 0 && after.join('') !== d.body)
                failed.push(`${label} (does not join back)`);
              if (before.some(holdsHalf)) cutBefore++;
              else if (JSON.stringify(after) !== JSON.stringify(before))
                failed.push(`${label} (not cut before, and not the same bytes)`);
            }
          }
        }
      }
      expect(failed).toEqual([]);
      // Counted with the copy of the earlier windowing: both kinds of text are in the sweep.
      expect([cases, cutBefore]).toEqual([972, 960]);
    });
    it('a text with nothing above U+FFFF chunks as the earlier windowing did', () => {
      for (const [maxChars, overlap] of FRACTIONS) {
        const d: Doc = { title: '', body: 'abcdefghijklmnop' };
        expect(chunk(d, { maxChars, overlap })).toEqual(chunkByUnits(d, { maxChars, overlap }));
      }
    });
  });

  it('under two headings each section is windowed on its own, and the indexes run on', () => {
    const a: Doc = { title: 'A', body: 'x'.repeat(3000) };
    const b: Doc = { title: 'B', body: 'x' + FACE.repeat(2000) };
    const chunks = chunkMarkdown(`# ${a.title}\n\n${a.body}\n\n# ${b.title}\n\n${b.body}\n`);
    const first = chunkByUnits(a);
    const second = chunkByUnits(b);
    // The earlier windowing does not cut the first section, and cuts two chunks of the second's three.
    expect(first.filter((c) => holdsHalf(c.content)).length).toBe(0);
    expect(second.map((c) => holdsHalf(c.content))).toEqual([false, true, true]);
    expect(chunks.map((c) => c.content)).toEqual([
      ...first.map((c) => c.content),
      ...second.map((c) => 'B\n\n' + lessHalves(c.content.slice(3))),
    ]);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    expect(chunks.some((c) => holdsHalf(c.content))).toBe(false);
  });

  it('ingest hands the embedding provider and the store no text holding an unpaired surrogate', async () => {
    class Counted extends FeatureHashEmbeddings {
      texts: string[] = [];
      override async embed(texts: string[]): Promise<number[][]> {
        this.texts.push(...texts);
        return super.embed(texts);
      }
    }
    const embeddings = new Counted();
    const { vectorStore } = createMemoryStores();
    const stored: string[] = [];
    const store: VectorStore = {
      getDocumentHash: (sourceId) => vectorStore.getDocumentHash(sourceId),
      upsertDocument: async (doc, chunks) => {
        stored.push(...chunks.map((c) => c.content));
        await vectorStore.upsertDocument(doc, chunks);
      },
      query: (q) => vectorStore.query(q),
    };
    const docs = [
      'the emoji page with 32 letter(s) in front',
      '1 letter(s) then 2,000 copies of U+1F600',
    ];
    // Both are documents the earlier windowing cut.
    for (const name of docs)
      expect(chunkByUnits(named(name)).some((c) => holdsHalf(c.content))).toBe(true);
    const result = await ingestDocuments({
      docs: docs.map((name) => ({ sourceId: name, title: name, text: asMarkdown(named(name)) })),
      embeddings,
      store,
    });
    expect(result.ingested).toBe(2);
    expect(embeddings.texts.length).toBe(6);
    expect(embeddings.texts.filter(holdsHalf)).toEqual([]);
    expect(stored).toEqual(embeddings.texts);
    const [embedding] = await new FeatureHashEmbeddings().embed([
      'Do you run classes for children?',
    ]);
    const returned = await vectorStore.query({
      embedding: embedding!,
      text: 'Do you run classes for children?',
      limit: 8,
    });
    // The question is about the emoji page: retrieval returns chunks of it, none holding a half.
    expect(returned.some((r) => r.sourceId === docs[0])).toBe(true);
    expect(returned.filter((r) => holdsHalf(r.content))).toEqual([]);
  });
});
