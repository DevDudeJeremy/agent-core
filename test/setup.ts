/**
 * Network kill switch. Every test runs with `globalThis.fetch` replaced by a thrower, so
 * any code path that reaches for the network (Voyage, Supabase, Anthropic) fails loudly
 * instead of silently going online. The whole suite must pass with ZERO env and ZERO
 * network beyond the npm registry. One file, test/supabase-store.test.ts, swaps in a
 * recording stub for its own tests (still no network) and puts this back after each.
 */
globalThis.fetch = (async (input: unknown) => {
  const target =
    typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
  throw new Error(
    `Network access is disabled during tests (attempted fetch to: ${target}). ` +
      'Use FeatureHashEmbeddings, the memory stores, and MockModelClient offline.',
  );
}) as unknown as typeof fetch;
