/**
 * "A new agent is one config file plus the business's content — the core does not change."
 *
 * This file takes that literally. It writes a config file and a folder of content that
 * exist nowhere in the repository, into a scratch folder it removes afterwards, and stands
 * the agent up with the same functions examples/node-server.ts uses. Nothing under src/ is
 * written or patched: the core is whatever is on disk.
 *
 * The model here is the offline stand-in, which only quotes the passage retrieval found. So
 * "answers from that content" means the right passage came back, through the loop and over
 * the wire. It does not mean a language model wrote a good answer.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import {
  MemoryEventSink,
  NON_NEGOTIABLE_GUARDRAILS,
  createAgentHandler,
  type AgentEvent,
  type AgentFile,
  type ModelEvent,
  type ModelStreamRequest,
  type ResolvedAgentConfig,
} from '../src/index.js';
import { MockModelClient, stop, textDelta } from '../src/testing/mock-model.js';
import { buildOfflineAgent, buildScriptedAgent, loadAgentFile } from '../examples/load-agent.js';
import {
  NO_PASSAGE_REPLY,
  PassageQuotingModel,
  QUOTING_STAND_IN,
  SCRIPTED_STAND_IN,
  paced,
} from '../examples/offline-runtime.js';
import { readSSE } from './harness.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// A bookshop. No import, no code: the whole agent is this object and the folder below.
const CONFIG_SOURCE = `export default {
  business: { name: 'Harbor Books', description: 'An independent bookshop on the quay.' },
  persona: { name: 'Mina', tone: 'Bookish and brief.' },
  guardrails: { extraRules: ['Never promise that a title is in stock.'] },
  rag: { topK: 2 },
  http: { basePath: '/desk', allowedOrigins: ['https://harborbooks.example'] },
};
`;
const RETURNS = 'Unread books can be returned within 21 days with the receipt.';
const STORY_HOUR = 'Story hour is every Saturday at ten, upstairs by the window.';

let scratch: string;
let configPath: string;
let contentDir: string;

beforeAll(() => {
  scratch = mkdtempSync(join(ROOT, '.tmp-agent-'));
  configPath = join(scratch, 'agent.config.ts');
  contentDir = join(scratch, 'content');
  mkdirSync(join(contentDir, 'events'), { recursive: true });
  writeFileSync(configPath, CONFIG_SOURCE);
  writeFileSync(join(contentDir, 'returns.md'), `# Returns\n\n${RETURNS}\n`);
  writeFileSync(join(contentDir, 'events', 'story-hour.txt'), `${STORY_HOUR}\n`);
  writeFileSync(join(contentDir, 'stock.json'), '{"not":"content"}\n');
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Load the scratch agent the way the example server does, with events kept in memory. */
async function standUp(): Promise<ResolvedAgentConfig> {
  const file = await loadAgentFile(configPath);
  const { agent, ingest } = await buildOfflineAgent(file, {
    contentDir,
    events: new MemoryEventSink(),
  });
  // Two documents: the .md and the .txt in the sub-folder. The .json is not content.
  expect(ingest).toMatchObject({ documents: 2, ingested: 2, skipped: 0 });
  return agent;
}

async function ask(
  agent: ResolvedAgentConfig,
  message: string,
  origin: string,
  path = `${agent.http.basePath}/chat`,
): Promise<{ status: number; reply: string; events: string[] }> {
  const res = await createAgentHandler(agent)(
    new Request(`http://host${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    }),
  );
  if (res.status !== 200) return { status: res.status, reply: '', events: [] };
  const frames = await readSSE(res);
  return {
    status: 200,
    events: frames.map((f) => f.event),
    reply: frames
      .filter((f) => f.event === 'text')
      .map((f) => (f.data as { delta: string }).delta)
      .join(''),
  };
}

const HARBOR = 'https://harborbooks.example';
const ACME = 'https://acmeplumbing.example';

/** The events an agent built here has logged; each is given a MemoryEventSink. */
const logged = (agent: ResolvedAgentConfig): AgentEvent[] =>
  (agent.runtime.events as MemoryEventSink).events;
const modelCalls = (agent: ResolvedAgentConfig): unknown[] =>
  logged(agent)
    .filter((e) => e.type === 'model_call')
    .map((e) => e.payload.model);

describe('a new agent from a config file and a content folder (SPEC §9.24)', () => {
  it('answers from that folder, as that business, on the path its config names', async () => {
    const agent = await standUp();
    const requests: ModelStreamRequest[] = [];
    const model = agent.runtime.modelClient;
    agent.runtime.modelClient = {
      stream(req: ModelStreamRequest): AsyncIterable<ModelEvent> {
        requests.push(structuredClone(req));
        return model.stream(req);
      },
    };

    const answer = await ask(agent, 'Can I return a book? I have the receipt.', HARBOR);

    // The reply is the sentence that exists only in the folder this test wrote, with its file.
    expect(answer.events.at(0)).toBe('meta');
    expect(answer.events.at(-1)).toBe('done');
    expect(answer.reply).toContain('From returns.md:');
    expect(answer.reply).toContain(RETURNS);

    // What the model was sent: this config's business, persona and rule, after the fixed
    // guardrails, and the retrieved passage marked with its source.
    expect(requests).toHaveLength(1);
    const { system, messages } = requests[0]!;
    expect(system.startsWith(NON_NEGOTIABLE_GUARDRAILS)).toBe(true);
    const afterGuardrails = system.slice(NON_NEGOTIABLE_GUARDRAILS.length);
    expect(afterGuardrails).toContain('## About Harbor Books');
    expect(afterGuardrails).toContain('You are Mina, the assistant for Harbor Books.');
    expect(afterGuardrails).toContain('- Never promise that a title is in stock.');
    expect(messages).toHaveLength(1);
    const sent = messages[0]!.content as string;
    expect(sent).toContain('[chunk 1 | source: returns.md | title: "Returns"]');
    expect(sent).toContain(RETURNS);

    // The config's path and allowlist are the ones in force.
    expect((await ask(agent, 'hello', HARBOR, '/agent/chat')).status).toBe(404);
    expect((await ask(agent, 'hello', 'https://elsewhere.example')).status).toBe(403);
  });

  it('reads sub-folders and .txt files, and names the file by its path in the folder', async () => {
    const agent = await standUp();

    const answer = await ask(agent, 'When is story hour?', HARBOR);

    expect(answer.reply).toContain('From events/story-hour.txt:');
    expect(answer.reply).toContain(STORY_HOUR);
  });

  it('says so when retrieval comes back empty', async () => {
    const agent = await standUp();

    const answer = await ask(agent, 'Zeppelin maintenance?', HARBOR);

    expect(answer.reply).toBe(NO_PASSAGE_REPLY);
    expect(answer.events).toEqual(['meta', 'text', 'done']);
  });

  it('with no content folder it has nothing to quote', async () => {
    const { agent, ingest } = await buildOfflineAgent(await loadAgentFile(configPath), {
      events: new MemoryEventSink(),
    });

    expect(ingest).toBeUndefined();
    expect((await ask(agent, 'Can I return a book?', HARBOR)).reply).toBe(NO_PASSAGE_REPLY);
  });

  it('the shipped exemplar stands up the same way, beside it, and neither sees the other’s content', async () => {
    const harbor = await standUp();
    const { agent: acme, ingest } = await buildOfflineAgent(
      await loadAgentFile(join(ROOT, 'examples', 'client-agent.example.ts')),
      {
        contentDir: join(ROOT, 'examples', 'client-content.example'),
        events: new MemoryEventSink(),
      },
    );
    expect(ingest).toMatchObject({ documents: 3, ingested: 3 });
    expect(acme.business.name).toBe('Acme Plumbing');
    expect(acme.http.basePath).toBe('/agent');
    expect(acme.tools.map((t) => t.name)).toEqual([
      'capture_lead',
      'request_human_handoff',
      'book_appointment',
    ]);

    // Each answers from its own folder.
    const plumber = await ask(acme, 'Do you fix water heaters?', ACME);
    expect(plumber.reply).toContain('From services.md:');
    expect(plumber.reply).toContain('We repair and replace gas and electric water heaters.');
    expect((await ask(harbor, 'Can I return a book with the receipt?', HARBOR)).reply).toContain(
      RETURNS,
    );

    // Ask each the other's question. The stand-in quotes whatever matches best, and a
    // stray shared word is enough for that, so the claim is narrower than "it finds
    // nothing": what comes back is never the other business's content.
    const crossedA = await ask(acme, 'Can I return an unread book with the receipt?', ACME);
    expect(crossedA.reply).not.toContain(RETURNS);
    expect(crossedA.reply).not.toContain('returns.md');
    const crossedB = await ask(harbor, 'Do you fix water heaters?', HARBOR);
    expect(crossedB.reply).not.toContain('water heaters.');
    expect(crossedB.reply).not.toContain('services.md');
  });

  it('a config that brings its own model gets that model, on the runner’s stores', async () => {
    const own = new MockModelClient([[textDelta('From my own model.'), stop('end_turn')]]);
    const file: AgentFile = {
      ...(await loadAgentFile(configPath)),
      model: 'my-own-model',
      runtime: { modelClient: own },
    };

    const { agent } = await buildOfflineAgent(file, { contentDir, events: new MemoryEventSink() });
    const answer = await ask(agent, 'Can I return a book? I have the receipt.', HARBOR);

    expect(agent.runtime.modelClient).toBe(own);
    expect(answer.reply).toBe('From my own model.');
    // It answered, so the log names it: the stand-in's name is not put over the config's.
    expect(modelCalls(agent)).toEqual(['my-own-model']);
    // Retrieval still ran on the stores the runner supplied, and reached that model.
    expect(own.calls[0]!.messages[0]!.content as string).toContain(RETURNS);
  });

  it('a file that exports no config is refused with a pointer to the exemplar', async () => {
    const empty = join(scratch, 'empty.config.ts');
    writeFileSync(empty, 'export const nothing = 1;\n');

    await expect(loadAgentFile(empty)).rejects.toThrow(/must default-export an agent config/);
  });
});

describe('the offline log names what answered (SPEC §9.30)', () => {
  it('a config served offline logs the quoting stand-in, and no Claude model', async () => {
    const agent = await standUp();

    await ask(agent, 'Can I return a book? I have the receipt.', HARBOR);

    // The file names no model, so a real deployment would log the default Claude model.
    // Offline nothing of the kind is called, and the log must not say it was.
    expect(agent.model).toBe(QUOTING_STAND_IN);
    expect(modelCalls(agent)).toEqual([QUOTING_STAND_IN]);
    expect(JSON.stringify(logged(agent))).not.toMatch(/claude/i);
  });

  it('the no-config demo replies with its script and logs the scripted stand-in', async () => {
    const agent = buildScriptedAgent({ events: new MemoryEventSink() });

    const answer = await ask(agent, 'hello', 'https://anywhere.example');

    // The three frames the README's quick start shows.
    expect(answer.events).toEqual(['meta', 'text', 'text', 'text', 'done']);
    expect(answer.reply).toBe(
      'Hi! This is the DevDudeJeremy agent-core offline demo. ' +
        'Ask me anything — I reply with a canned message so you can see the SSE stream.',
    );
    expect(modelCalls(agent)).toEqual([SCRIPTED_STAND_IN]);
    expect(JSON.stringify(logged(agent))).not.toMatch(/claude/i);
  });
});

describe('the demo’s pacing', () => {
  it('waits before each piece of text, and at 0 is the model itself', async () => {
    const quoting = new PassageQuotingModel();
    expect(paced(quoting, 0)).toBe(quoting);

    vi.useFakeTimers();
    const scripted = new MockModelClient([[textDelta('one'), textDelta('two'), stop('end_turn')]]);
    const seen: ModelEvent[] = [];
    const reading = (async () => {
      for await (const event of paced(scripted, 150).stream({
        model: 'm',
        system: '',
        messages: [],
        tools: [],
        maxTokens: 1,
      })) {
        seen.push(event);
      }
    })();

    await vi.advanceTimersByTimeAsync(149);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([{ type: 'text_delta', delta: 'one' }]);
    await vi.advanceTimersByTimeAsync(150);
    await reading;
    expect(seen.map((e) => e.type)).toEqual(['text_delta', 'text_delta', 'stop']);
  });
});
