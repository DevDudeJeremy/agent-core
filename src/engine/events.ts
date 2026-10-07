/**
 * Observability layer. Every meaningful action in the agent emits an {@link AgentEvent}
 * to the {@link EventSink} (and, from the loop, the optional `onEvent` hook). Raw tool
 * inputs appear ONLY in these server-side events — never on the SSE wire (see the HTTP
 * contract in docs/http-contract.md).
 */

export type AgentEventType =
  | 'conversation_started'
  | 'user_message'
  | 'retrieval_performed'
  | 'model_call'
  | 'tool_executed'
  | 'approval_required'
  | 'handoff_requested'
  | 'lead_captured'
  | 'assistant_message'
  | 'error';

export interface AgentEvent {
  type: AgentEventType;
  conversationId: string;
  /** ISO 8601 timestamp. */
  at: string;
  payload: Record<string, unknown>;
}

export interface EventSink {
  write(e: AgentEvent): Promise<void>;
}

/** Stamp an event with the current time. Used by the loop and the built-in tools. */
export function makeEvent(
  type: AgentEventType,
  conversationId: string,
  payload: Record<string, unknown>,
): AgentEvent {
  return { type, conversationId, at: new Date().toISOString(), payload };
}

/**
 * One JSON line per event to stdout. Cheap and greppable; the offline demo uses it. It is
 * not a default: every runtime names its sink, and `fromEnv()` supplies the Supabase one.
 */
export class ConsoleEventSink implements EventSink {
  async write(e: AgentEvent): Promise<void> {
    console.log(JSON.stringify(e));
  }
}

/** In-memory sink for tests, local dev, and the offline demo. */
export class MemoryEventSink implements EventSink {
  readonly events: AgentEvent[] = [];
  async write(e: AgentEvent): Promise<void> {
    this.events.push(e);
  }
}
