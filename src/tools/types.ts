/**
 * The pluggable, gated tool interface. A tool declares a zod input schema and a `gate`.
 * The engine loop enforces the gate STRUCTURALLY: a `human-approval` tool's `run()` is
 * never invoked at runtime (see engine/conversation.ts). Tools are the only way the agent
 * takes an action.
 */
import { z } from 'zod';
import type { AgentEvent } from '../engine/events.js';

export interface ToolContext {
  conversationId: string;
  emit(e: AgentEvent): Promise<void>;
}

export type ToolResult =
  { ok: true; summary: string; data?: unknown } | { ok: false; error: string };

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: S;
  gate: 'none' | 'human-approval';
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

/** The Anthropic-shaped tool the ModelClient receives. */
export interface JsonSchemaTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** snake_case, 1–64 chars, matching the Anthropic tool-name constraint. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function assertValidToolName(name: string): void {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid tool name "${name}": must be snake_case matching ${TOOL_NAME_PATTERN} (start with a-z, ≤64 chars).`,
    );
  }
}

/** Identity helper that validates the tool name at definition time and preserves types. */
export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): ToolDefinition<S> {
  assertValidToolName(def.name);
  return def;
}

/** Reject duplicate or malformed tool names before an agent goes live. */
export function validateToolRegistry(tools: ToolDefinition[]): void {
  const seen = new Set<string>();
  for (const t of tools) {
    assertValidToolName(t.name);
    if (seen.has(t.name)) {
      throw new Error(`Duplicate tool name in registry: "${t.name}".`);
    }
    seen.add(t.name);
  }
}

/**
 * Convert a zod schema to the JSON Schema Anthropic's tools API expects. zod v4's built-in
 * `z.toJSONSchema()` produces a draft-2020-12 object schema; we strip the `$schema`
 * pointer (Anthropic wants a bare object schema) and guarantee an object at the root.
 * Refinements (e.g. "at least one contact field") are dropped from the schema but still
 * enforced at parse time by the loop's `safeParse`.
 */
export function zodToInputSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>;
  delete js.$schema;
  if (js.type !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: true };
  }
  return js;
}

export function toJsonSchemaTool(tool: ToolDefinition): JsonSchemaTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: zodToInputSchema(tool.inputSchema),
  };
}
