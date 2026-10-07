/**
 * @ddj/agent-core — public API.
 *
 * The reusable brain for DevDudeJeremy on-site agents: conversation loop, client-knowledge
 * RAG, gated tools, guardrails, escalation, and a frozen HTTP/SSE contract. Derive a client
 * agent by editing one config and ingesting content — no core-code changes. See README.md.
 */

// Config & agent definition
export {
  defineAgent,
  fromEnv,
  VERSION,
  PROTOCOL_VERSION,
  DEFAULT_MODEL,
  DEFAULTS,
  type AgentConfig,
  type ResolvedAgentConfig,
  type AgentRuntime,
} from './config.js';

// HTTP surface
export { createAgentHandler } from './http/handler.js';
export {
  encodeFrame,
  SSE_HEADERS,
  SSE_KEEPALIVE,
  SSE_KEEPALIVE_MS,
  type SseFrame,
} from './http/sse.js';
export { isOriginAllowed, corsHeaders } from './http/cors.js';
export {
  SlidingWindowRateLimiter,
  type RateLimiter,
  type RateLimitResult,
} from './http/rate-limit.js';

// Engine
export { runTurn, type RunTurnParams } from './engine/conversation.js';
export {
  AnthropicModelClient,
  type ModelClient,
  type ModelEvent,
  type ModelStreamRequest,
  type ChatMessage,
  type ContentBlock,
  type TextBlock,
  type ToolUseBlock,
  type ToolResultBlock,
} from './engine/model.js';
export {
  ConsoleEventSink,
  MemoryEventSink,
  makeEvent,
  type EventSink,
  type AgentEvent,
  type AgentEventType,
} from './engine/events.js';

// RAG
export {
  EMBEDDING_DIM,
  FeatureHashEmbeddings,
  VoyageEmbeddings,
  tokenize,
  type EmbeddingProvider,
  type VoyageOptions,
} from './rag/embed.js';
export { chunkMarkdown, type ChunkOptions, type TextChunk } from './rag/chunk.js';
export {
  retrieve,
  RRF_K,
  RRF_CANDIDATES,
  type Reranker,
  type RetrieveParams,
} from './rag/retrieve.js';
export {
  ingestDocuments,
  type IngestOptions,
  type IngestResult,
  type IngestDocProgress,
} from './rag/ingest.js';

// Stores
export type {
  VectorStore,
  ConversationStore,
  Conversation,
  StoredMessage,
  VisitorInfo,
  IngestDoc,
  IngestedDoc,
  EmbeddedChunk,
  RetrievedChunk,
} from './stores/types.js';
export { createMemoryStores } from './stores/memory.js';
export { createSupabaseStores } from './stores/supabase.js';

// Tools
export {
  defineTool,
  validateToolRegistry,
  assertValidToolName,
  toJsonSchemaTool,
  zodToInputSchema,
  TOOL_NAME_PATTERN,
  type ToolDefinition,
  type ToolContext,
  type ToolResult,
  type JsonSchemaTool,
} from './tools/types.js';
export { captureLead } from './tools/capture-lead.js';
export { requestHandoff } from './tools/request-handoff.js';
export { bookAppointment } from './tools/book-appointment.js';

// Prompts
export {
  NON_NEGOTIABLE_GUARDRAILS,
  buildSystemPrompt,
  formatContextBlock,
} from './prompts/system.js';
