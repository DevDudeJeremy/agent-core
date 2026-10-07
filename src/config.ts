/**
 * AgentConfig → ResolvedAgentConfig. `defineAgent()` validates the serializable shape with
 * zod, fills every default, and validates the tool registry. `fromEnv()` builds a
 * production runtime — and is the ONLY place `process.env` is read, at call time, so
 * importing this package with zero env set never throws.
 */
import { z } from 'zod';
import type { ModelClient } from './engine/model.js';
import { AnthropicModelClient } from './engine/model.js';
import type { EmbeddingProvider } from './rag/embed.js';
import { VoyageEmbeddings } from './rag/embed.js';
import type { ConversationStore, VectorStore } from './stores/types.js';
import type { AgentEvent, EventSink } from './engine/events.js';
import { createSupabaseStores } from './stores/supabase.js';
import type { ToolDefinition } from './tools/types.js';
import { validateToolRegistry } from './tools/types.js';
import { captureLead } from './tools/capture-lead.js';
import { requestHandoff } from './tools/request-handoff.js';
import type { Reranker } from './rag/retrieve.js';

/** Keep in sync with package.json `version`. Surfaced by GET {base}/health. */
export const VERSION = '0.1.0';
export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_MODEL = 'claude-haiku-4-5';

export const DEFAULTS = {
  maxTokens: 1024,
  maxTurns: 6,
  historyWindow: 20,
  maxMessageChars: 2000,
  topK: 4,
  basePath: '/agent',
  rateLimit: { windowMs: 60_000, max: 20 },
} as const;

export interface AgentRuntime {
  modelClient: ModelClient;
  embeddings: EmbeddingProvider;
  vectorStore: VectorStore;
  conversations: ConversationStore;
  events: EventSink;
}

export interface AgentConfig {
  business: { name: string; description: string; website?: string };
  persona: { name: string; tone: string; language?: string };
  model?: string;
  maxTokens?: number;
  limits?: { maxTurns?: number; historyWindow?: number; maxMessageChars?: number };
  guardrails?: { extraRules?: string[] };
  tools?: ToolDefinition[];
  rag?: { enabled?: boolean; topK?: number; reranker?: Reranker };
  http?: {
    basePath?: string;
    allowedOrigins: string[];
    rateLimit?: { windowMs: number; max: number };
    clientKey?: (req: Request) => string;
  };
  runtime: AgentRuntime;
  onEvent?: (e: AgentEvent) => void | Promise<void>;
}

export interface ResolvedAgentConfig {
  version: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  business: { name: string; description: string; website?: string };
  persona: { name: string; tone: string; language?: string };
  model: string;
  maxTokens: number;
  limits: { maxTurns: number; historyWindow: number; maxMessageChars: number };
  guardrails: { extraRules: string[] };
  tools: ToolDefinition[];
  rag: { enabled: boolean; topK: number; reranker?: Reranker };
  http: {
    basePath: string;
    allowedOrigins: string[];
    rateLimit: { windowMs: number; max: number };
    clientKey: (req: Request) => string;
  };
  runtime: AgentRuntime;
  onEvent?: (e: AgentEvent) => void | Promise<void>;
}

/** Validates only the serializable fields; runtime/tools/hooks are checked structurally. */
const serializableSchema = z.object({
  business: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    website: z.string().optional(),
  }),
  persona: z.object({
    name: z.string().min(1),
    tone: z.string().min(1),
    language: z.string().optional(),
  }),
  model: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  limits: z
    .object({
      maxTurns: z.number().int().positive().optional(),
      historyWindow: z.number().int().positive().optional(),
      maxMessageChars: z.number().int().positive().optional(),
    })
    .optional(),
  guardrails: z.object({ extraRules: z.array(z.string()).optional() }).optional(),
  rag: z
    .object({ enabled: z.boolean().optional(), topK: z.number().int().positive().optional() })
    .optional(),
  http: z
    .object({
      basePath: z.string().min(1).optional(),
      allowedOrigins: z.array(z.string()),
      rateLimit: z
        .object({ windowMs: z.number().int().positive(), max: z.number().int().positive() })
        .optional(),
    })
    .optional(),
});

function defaultClientKey(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

export function defineAgent(config: AgentConfig): ResolvedAgentConfig {
  serializableSchema.parse({
    business: config.business,
    persona: config.persona,
    model: config.model,
    maxTokens: config.maxTokens,
    limits: config.limits,
    guardrails: config.guardrails,
    rag: config.rag ? { enabled: config.rag.enabled, topK: config.rag.topK } : undefined,
    http: config.http
      ? {
          basePath: config.http.basePath,
          allowedOrigins: config.http.allowedOrigins,
          rateLimit: config.http.rateLimit,
        }
      : undefined,
  });

  if (!config.http || !Array.isArray(config.http.allowedOrigins)) {
    throw new Error('AgentConfig.http.allowedOrigins is required (the CORS allowlist).');
  }
  if (!config.runtime) {
    throw new Error('AgentConfig.runtime is required (modelClient, embeddings, stores, events).');
  }

  const tools = config.tools ?? [captureLead, requestHandoff];
  validateToolRegistry(tools);

  return {
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    business: config.business,
    persona: config.persona,
    model: config.model ?? DEFAULT_MODEL,
    maxTokens: config.maxTokens ?? DEFAULTS.maxTokens,
    limits: {
      maxTurns: config.limits?.maxTurns ?? DEFAULTS.maxTurns,
      historyWindow: config.limits?.historyWindow ?? DEFAULTS.historyWindow,
      maxMessageChars: config.limits?.maxMessageChars ?? DEFAULTS.maxMessageChars,
    },
    guardrails: { extraRules: config.guardrails?.extraRules ?? [] },
    tools,
    rag: {
      enabled: config.rag?.enabled ?? true,
      topK: config.rag?.topK ?? DEFAULTS.topK,
      reranker: config.rag?.reranker,
    },
    http: {
      basePath: config.http.basePath ?? DEFAULTS.basePath,
      allowedOrigins: config.http.allowedOrigins,
      rateLimit: config.http.rateLimit ?? { ...DEFAULTS.rateLimit },
      clientKey: config.http.clientKey ?? defaultClientKey,
    },
    runtime: config.runtime,
    onEvent: config.onEvent,
  };
}

/**
 * Build a production runtime from environment variables. Throws a clear, named error the
 * FIRST time it is called with a missing var — never at import. Every `process.env` read in
 * this package lives inside this function body.
 */
export function fromEnv(): { runtime: AgentRuntime; model?: string; allowedOrigins: string[] } {
  const need = (name: string): string => {
    const value = process.env[name];
    if (!value || !value.trim()) {
      throw new Error(`Missing required environment variable: ${name}. See .env.example.`);
    }
    return value;
  };

  const anthropicKey = need('ANTHROPIC_API_KEY');
  const voyageKey = need('VOYAGE_API_KEY');
  const supabaseUrl = need('SUPABASE_URL');
  const supabaseKey = need('SUPABASE_SERVICE_ROLE_KEY');
  const model = process.env.AGENT_MODEL?.trim() || undefined;
  const allowedOrigins = (process.env.AGENT_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const { vectorStore, conversations, events } = createSupabaseStores(supabaseUrl, supabaseKey);

  const runtime: AgentRuntime = {
    modelClient: AnthropicModelClient.fromApiKey(anthropicKey),
    embeddings: new VoyageEmbeddings({ apiKey: voyageKey }),
    vectorStore,
    conversations,
    events,
  };

  return { runtime, model, allowedOrigins };
}
