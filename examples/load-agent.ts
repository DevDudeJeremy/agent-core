/**
 * Turn a config file into a running agent with no keys. This is the whole of what "a new
 * agent is one config file plus the business's content" needs outside the core, offline:
 * load the file, give it the stand-in runtime, and read its content folder into the store.
 * With real keys the core does the same job in one call, `defineAgentFromEnv(file)`.
 *
 * examples/node-server.ts uses these functions; so does test/new-agent.test.ts.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ConsoleEventSink,
  FeatureHashEmbeddings,
  createMemoryStores,
  defineAgent,
  ingestDocuments,
  type AgentFile,
  type AgentRuntime,
  type IngestResult,
  type ResolvedAgentConfig,
} from '../src/index.js';
import { MockModelClient, stop, textDelta } from '../src/testing/mock-model.js';
import { readDocs } from '../scripts/read-docs.js';
import {
  QUOTING_STAND_IN,
  SCRIPTED_STAND_IN,
  createOfflineRuntime,
  paced,
  type OfflineRuntimeOptions,
} from './offline-runtime.js';

/** Import a config file and hand back its default export. */
export async function loadAgentFile(path: string): Promise<AgentFile> {
  const url = pathToFileURL(resolve(path)).href;
  const module = (await import(/* @vite-ignore */ url)) as { default?: unknown };
  if (!module.default || typeof module.default !== 'object') {
    throw new Error(
      `${path} must default-export an agent config (see examples/client-agent.example.ts).`,
    );
  }
  return module.default as AgentFile;
}

/** Put a config and a runtime together. A runtime part the file supplies is the one used. */
export function mountAgent(file: AgentFile, runtime: AgentRuntime): ResolvedAgentConfig {
  return defineAgent({ ...file, runtime: { ...runtime, ...file.runtime } });
}

export interface OfflineAgentOptions extends OfflineRuntimeOptions {
  /** A folder of `.md` / `.txt` to read into the agent's store before it serves anything. */
  contentDir?: string;
}

/**
 * Build an agent that needs no keys: the config, on the offline stand-ins, with the content
 * folder ingested. `ingest` is undefined when no folder was given.
 */
export async function buildOfflineAgent(
  file: AgentFile,
  options: OfflineAgentOptions = {},
): Promise<{ agent: ResolvedAgentConfig; ingest?: IngestResult }> {
  // Unless the file brought a model of its own, the quoting stand-in is what answers, and
  // the agent is named for it: the event log must not credit a Claude model with the reply.
  const named = file.runtime?.modelClient ? file : { ...file, model: QUOTING_STAND_IN };
  const agent = mountAgent(named, createOfflineRuntime(options));
  if (!options.contentDir) return { agent };

  const ingest = await ingestDocuments({
    docs: readDocs(options.contentDir),
    embeddings: agent.runtime.embeddings,
    store: agent.runtime.vectorStore,
  });
  return { agent, ingest };
}

/**
 * The agent `npm run demo` serves when it is given no config: no retrieval, any origin, and
 * a scripted reply that never changes. It exists to show the SSE stream.
 */
export function buildScriptedAgent(options: OfflineRuntimeOptions = {}): ResolvedAgentConfig {
  const { vectorStore, conversations } = createMemoryStores();
  const scripted = new MockModelClient(
    [
      [
        textDelta('Hi! '),
        textDelta('This is the DevDudeJeremy agent-core offline demo. '),
        textDelta('Ask me anything — I reply with a canned message so you can see the SSE stream.'),
        stop('end_turn'),
      ],
    ],
    { repeatLast: true },
  );

  return defineAgent({
    business: {
      name: 'Demo Co',
      description: 'A demo business for the agent-core offline showcase.',
    },
    persona: { name: 'Demo Assistant', tone: 'Friendly, concise, and helpful.' },
    model: SCRIPTED_STAND_IN,
    rag: { enabled: false },
    http: { allowedOrigins: ['*'] },
    runtime: {
      modelClient: paced(scripted, options.paceMs ?? 0),
      embeddings: new FeatureHashEmbeddings(),
      vectorStore,
      conversations,
      events: options.events ?? new ConsoleEventSink(),
    },
  });
}
