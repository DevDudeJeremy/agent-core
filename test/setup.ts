/**
 * Network kill switch. Every test runs with `globalThis.fetch` replaced by a thrower, so
 * any code path that reaches for the network (Voyage, Supabase, Anthropic) fails loudly
 * instead of silently going online. The whole suite must pass with ZERO env and ZERO
 * network beyond the npm registry. Four files swap in a stub of their own for some tests
 * (still no network) and put this back after each: test/supabase-store.test.ts,
 * test/anthropic-client.test.ts, test/postgres.test.ts and test/from-env.test.ts.
 */
globalThis.fetch = (async (input: unknown) => {
  const target =
    typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
  throw new Error(
    `Network access is disabled during tests (attempted fetch to: ${target}). ` +
      'Use FeatureHashEmbeddings, the memory stores, and MockModelClient offline.',
  );
}) as unknown as typeof fetch;
