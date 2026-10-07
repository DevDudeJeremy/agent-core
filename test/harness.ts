/**
 * Shared test helpers: build a fully offline agent, drive runTurn while collecting SSE
 * frames, and parse an SSE Response body into frames.
 */
import {
  defineAgent,
  FeatureHashEmbeddings,
  MemoryEventSink,
  createMemoryStores,
  type AgentConfig,
  type AgentEvent,
  type ModelClient,
  type ResolvedAgentConfig,
} from '../src/index.js';
import { runTurn } from '../src/index.js';
import type { SseFrame } from '../src/index.js';

export interface Harness {
  agent: ResolvedAgentConfig;
  sink: MemoryEventSink;
  hookEvents: AgentEvent[];
  vectorStore: ReturnType<typeof createMemoryStores>['vectorStore'];
  conversations: ReturnType<typeof createMemoryStores>['conversations'];
}

export function buildAgent(
  modelClient: ModelClient,
  overrides: Partial<AgentConfig> = {},
): Harness {
  const { vectorStore, conversations } = createMemoryStores();
  const sink = new MemoryEventSink();
  const hookEvents: AgentEvent[] = [];

  const agent = defineAgent({
    business: { name: 'Test Co', description: 'A business used in the agent-core test suite.' },
    persona: { name: 'Testy', tone: 'Calm and concise.' },
    rag: { enabled: false },
    http: { allowedOrigins: ['https://ok.example'] },
    onEvent: (e) => {
      hookEvents.push(e);
    },
    ...overrides,
    runtime: {
      modelClient,
      embeddings: new FeatureHashEmbeddings(),
      vectorStore,
      conversations,
      events: sink,
      ...(overrides.runtime ?? {}),
    },
  });

  return { agent, sink, hookEvents, vectorStore, conversations };
}

/** Run a single turn, collecting every SSE frame the loop emits. */
export async function collectTurn(
  agent: ResolvedAgentConfig,
  message: string,
  conversationId?: string,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  await runTurn({ agent, message, conversationId, sse: (f) => frames.push(f) });
  return frames;
}

export interface ParsedFrame {
  event: string;
  data: unknown;
}

/** Parse an SSE Response body into frames, ignoring keepalive comment lines. */
export async function readSSE(res: Response): Promise<ParsedFrame[]> {
  const text = await res.text();
  const frames: ParsedFrame[] = [];
  for (const block of text.split('\n\n')) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;
    let event = 'message';
    let data = '';
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    frames.push({ event, data: data ? JSON.parse(data) : null });
  }
  return frames;
}
