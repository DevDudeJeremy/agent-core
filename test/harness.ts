/**
 * Shared test helpers: build a fully offline agent, drive runTurn while collecting SSE
 * frames, parse an SSE Response body into frames, and read a streamed body up to a marker.
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
  return parseSSE(await res.text());
}

/** Parse SSE text into frames, ignoring keepalive comment lines. */
export function parseSSE(text: string): ParsedFrame[] {
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

/**
 * A reader over a streamed body that hands back text. It waits on the stream and on nothing
 * else: `until()` never resolves if its marker never arrives.
 */
export function textReader(body: ReadableStream<Uint8Array>): {
  until(marker: string): Promise<string>;
  toEnd(): Promise<string>;
} {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  return {
    /** Read until `marker` has arrived. Resolves with everything read so far. */
    async until(marker: string): Promise<string> {
      while (!seen.includes(marker)) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`stream ended before "${marker}" arrived; got: ${seen}`);
        seen += decoder.decode(value, { stream: true });
      }
      return seen;
    },
    /** Read to the end. Resolves with everything read, from the first byte. */
    async toEnd(): Promise<string> {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return (seen += decoder.decode());
        seen += decoder.decode(value, { stream: true });
      }
    },
  };
}
