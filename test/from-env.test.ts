/**
 * The production path, as far as it goes with no service behind it. `fromEnv()` and
 * `defineAgentFromEnv()` build real clients, and building one makes no request, so with
 * made-up values in the environment all of this runs offline.
 *
 * What this proves: which settings end up in force, that a missing variable is named, and
 * that the store's deadline is the one asked for.
 * What it cannot prove: that any key works. The values here are not keys.
 */
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_MODEL,
  DEFAULT_STORE_TIMEOUT_MS,
  MemoryEventSink,
  createAgentHandler,
  defineAgentFromEnv,
  fromEnv,
  type AgentFile,
  type ResolvedAgentConfig,
} from '../src/index.js';
import { MockModelClient } from '../src/testing/mock-model.js';
import { INGEST_STORE_TIMEOUT_MS, runIngest } from '../scripts/ingest-cli.js';

const REQUIRED = {
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  VOYAGE_API_KEY: 'test-voyage-key',
  SUPABASE_URL: 'http://supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
};
const EXAMPLE_CONTENT = fileURLToPath(
  new URL('../examples/client-content.example', import.meta.url),
);
const SOME_ID = '3f2b8c1e-6d0a-4c57-9a3e-0b1d2c3e4f5a';

const killSwitch = globalThis.fetch;
beforeEach(() => {
  for (const [name, value] of Object.entries(REQUIRED)) vi.stubEnv(name, value);
  // Whatever the developer's shell has for these must not leak into the assertions.
  for (const name of ['AGENT_MODEL', 'AGENT_ALLOWED_ORIGINS', 'ANTHROPIC_BASE_URL']) {
    vi.stubEnv(name, undefined);
  }
});
afterEach(() => {
  globalThis.fetch = killSwitch;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const FILE: AgentFile = {
  business: { name: 'Harbor Books', description: 'An independent bookshop on the quay.' },
  persona: { name: 'Mina', tone: 'Bookish and brief.' },
  model: 'model-from-the-file',
  http: { basePath: '/desk', allowedOrigins: ['https://harborbooks.example'] },
};

/** A browser's preflight from `origin`: 204 when the allowlist has it, 403 when not. */
async function preflight(agent: ResolvedAgentConfig, origin: string): Promise<number> {
  const res = await createAgentHandler(agent)(
    new Request(`http://host${agent.http.basePath}/chat`, {
      method: 'OPTIONS',
      headers: { origin },
    }),
  );
  return res.status;
}

describe('defineAgentFromEnv: a config file in, a production agent out (SPEC §9.32)', () => {
  it('the host’s model and allowlist win when the host has set them', async () => {
    vi.stubEnv('AGENT_MODEL', 'model-from-the-host');
    vi.stubEnv('AGENT_ALLOWED_ORIGINS', 'https://a.example, https://b.example');

    const agent = defineAgentFromEnv(FILE);

    expect(agent.model).toBe('model-from-the-host');
    expect(agent.http.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(await preflight(agent, 'https://b.example')).toBe(204);
    // The file's own origin is replaced, not added to.
    expect(await preflight(agent, 'https://harborbooks.example')).toBe(403);
    // Everything the host has no say over is still the file's.
    expect(agent.http.basePath).toBe('/desk');
    expect(agent.business.name).toBe('Harbor Books');
  });

  it('with neither set, what the file says stands', async () => {
    const agent = defineAgentFromEnv(FILE);

    expect(agent.model).toBe('model-from-the-file');
    expect(agent.http.allowedOrigins).toEqual(['https://harborbooks.example']);
    expect(await preflight(agent, 'https://harborbooks.example')).toBe(204);
  });

  it('with no model anywhere it is the default, and with no allowlist anywhere a browser is refused', async () => {
    const bare: AgentFile = { business: FILE.business, persona: FILE.persona };

    const agent = defineAgentFromEnv(bare);

    expect(agent.model).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe('claude-haiku-4-5');
    expect(agent.http.allowedOrigins).toEqual([]);
    expect(await preflight(agent, 'https://anyone.example')).toBe(403);
    // Health is public either way.
    const health = await createAgentHandler(agent)(new Request('http://host/agent/health'));
    expect(health.status).toBe(200);
  });

  it('keeps a runtime part the file supplies and takes the rest from the environment', () => {
    const own = new MockModelClient([]);
    const sink = new MemoryEventSink();
    const fromTheEnvironment = fromEnv().runtime;

    const agent = defineAgentFromEnv({ ...FILE, runtime: { modelClient: own, events: sink } });

    expect(agent.runtime.modelClient).toBe(own);
    expect(agent.runtime.events).toBe(sink);
    // The stores and the embedder are the production ones: same classes fromEnv() builds.
    expect(agent.runtime.conversations.constructor).toBe(
      fromTheEnvironment.conversations.constructor,
    );
    expect(agent.runtime.vectorStore.constructor).toBe(fromTheEnvironment.vectorStore.constructor);
    expect(agent.runtime.embeddings.constructor).toBe(fromTheEnvironment.embeddings.constructor);
  });

  it.each(Object.keys(REQUIRED))('a missing %s is named in the error', (name) => {
    vi.stubEnv(name, undefined);

    expect(() => defineAgentFromEnv(FILE)).toThrow(
      `Missing required environment variable: ${name}. See .env.example.`,
    );
  });
});

/** A store that never answers: the request settles only when the caller gives up on it. */
function storeThatNeverAnswers(): { attempts: () => number; firstRequest: Promise<void> } {
  let attempts = 0;
  let seen!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    seen = resolve;
  });
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    attempts++;
    seen();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    });
  }) as typeof fetch;
  return { attempts: () => attempts, firstRequest };
}

// On the test runner's clock: nothing below waits in real time.
describe('the store’s deadline is the one asked for (SPEC §9.32, §9.34)', () => {
  const settle = (work: Promise<unknown>): { outcome: () => string } => {
    let outcome = 'pending';
    void work.then(
      () => (outcome = 'resolved'),
      (err: Error) => (outcome = err.message),
    );
    return { outcome: () => outcome };
  };

  it('fromEnv() gives the store the chat default', async () => {
    vi.useFakeTimers();
    storeThatNeverAnswers();

    const call = settle(fromEnv().runtime.conversations.get(SOME_ID));

    await vi.advanceTimersByTimeAsync(DEFAULT_STORE_TIMEOUT_MS - 1);
    expect(call.outcome()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(call.outcome()).toMatch(/conversation get failed/);
  });

  it('fromEnv({ storeTimeoutMs }) and defineAgentFromEnv(file, { storeTimeoutMs }) pass it through', async () => {
    vi.useFakeTimers();
    storeThatNeverAnswers();

    const direct = settle(fromEnv({ storeTimeoutMs: 7_000 }).runtime.conversations.get(SOME_ID));
    const mounted = settle(
      defineAgentFromEnv(FILE, { storeTimeoutMs: 7_000 }).runtime.conversations.get(SOME_ID),
    );

    // Well past the default, and neither has been given up on.
    await vi.advanceTimersByTimeAsync(6_999);
    expect(direct.outcome()).toBe('pending');
    expect(mounted.outcome()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(direct.outcome()).toMatch(/conversation get failed/);
    expect(mounted.outcome()).toMatch(/conversation get failed/);
  });

  it('a real ingest gives the store 60 seconds, not the chat default', async () => {
    vi.useFakeTimers();
    const store = storeThatNeverAnswers();

    const run = settle(runIngest(['--dir', EXAMPLE_CONTENT], () => {}));
    // The first thing an ingest asks the store is a document's stored hash.
    await store.firstRequest;

    await vi.advanceTimersByTimeAsync(DEFAULT_STORE_TIMEOUT_MS);
    expect(run.outcome()).toBe('pending');
    await vi.advanceTimersByTimeAsync(INGEST_STORE_TIMEOUT_MS - DEFAULT_STORE_TIMEOUT_MS - 1);
    expect(run.outcome()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(run.outcome()).toMatch(/getDocumentHash failed/);
    expect(store.attempts()).toBe(1);
    expect(INGEST_STORE_TIMEOUT_MS).toBe(60_000);
  });
});

describe('the ingest CLI without a store', () => {
  it('a dry run needs no environment at all and counts the chunks', async () => {
    for (const name of Object.keys(REQUIRED)) vi.stubEnv(name, undefined);
    const lines: string[] = [];

    await runIngest(['--dir', EXAMPLE_CONTENT, '--dry-run'], (line) => lines.push(line));

    expect(lines.at(-1)).toBe(
      'DRY RUN — 3 doc(s), 6 chunk(s). No embedding, no network, no store writes.',
    );
  });

  it('with no --dir it stops with the usage line', async () => {
    await expect(runIngest([], () => {})).rejects.toThrow(
      'Usage: tsx scripts/ingest.ts --dir <path> [--dry-run]',
    );
  });
});
