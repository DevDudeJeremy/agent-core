/**
 * The English stop words of Postgres: the 127 words of its `english.stop`, in that file's
 * order. `to_tsvector('english', …)` drops these from a passage and from a message before
 * anything is counted, so the stand-in store has to drop the same ones or its "more than half
 * of the words" is a different rule. "Do you fix water heaters?" asks three words in
 * Postgres; without this list it would ask five here.
 *
 * Not part of the package's public API: only `stores/memory.ts` reads it. A test compares it
 * with the list the test database itself reads (test/postgres.test.ts).
 */
const WORDS = `
  i me my myself we our ours ourselves you your yours yourself yourselves he him his himself
  she her hers herself it its itself they them their theirs themselves what which who whom
  this that these those am is are was were be been being have has had having do does did doing
  a an the and but if or because as until while of at by for with about against between into
  through during before after above below to from up down in out on off over under again
  further then once here there when where why how all any both each few more most other some
  such no nor not only own same so than too very s t can will just don should now
`;

export const ENGLISH_STOP_WORDS: ReadonlySet<string> = new Set(WORDS.trim().split(/\s+/));
