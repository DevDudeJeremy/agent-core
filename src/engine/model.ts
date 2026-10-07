/**
 * The model seam. Everything talks to `ModelClient`; only THIS file imports
 * `@anthropic-ai/sdk` (isolation rule, SPEC §3). Tests inject a scripted MockModelClient.
 * The Anthropic stream-event mapping is intentionally defensive: shapes are probed, not
 * assumed, so an SDK point release cannot silently break the loop.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { JsonSchemaTool } from '../tools/types.js';

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export type ModelEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'stop'; reason: 'end_turn' | 'tool_use' | 'max_tokens' };

export interface ModelStreamRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: JsonSchemaTool[];
  maxTokens: number;
}

export interface ModelClient {
  stream(req: ModelStreamRequest): AsyncIterable<ModelEvent>;
}

function mapStopReason(reason: unknown): 'end_turn' | 'tool_use' | 'max_tokens' {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  // 'end_turn', 'stop_sequence', null, or anything unexpected → treat as a clean end.
  return 'end_turn';
}

interface ToolAccumulator {
  id: string;
  name: string;
  json: string;
}

export class AnthropicModelClient implements ModelClient {
  constructor(private readonly client: Anthropic) {}

  static fromApiKey(
    apiKey: string,
    options?: ConstructorParameters<typeof Anthropic>[0],
  ): AnthropicModelClient {
    return new AnthropicModelClient(new Anthropic({ apiKey, ...options }));
  }

  async *stream(req: ModelStreamRequest): AsyncIterable<ModelEvent> {
    const raw = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages as unknown as Anthropic.MessageParam[],
      tools: req.tools as unknown as Anthropic.Tool[],
      stream: true,
    });

    const toolBlocks = new Map<number, ToolAccumulator>();
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';

    for await (const event of raw as AsyncIterable<Record<string, any>>) {
      const type = event?.type as string | undefined;

      if (type === 'content_block_start') {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          toolBlocks.set(Number(event.index), {
            id: String(block.id ?? ''),
            name: String(block.name ?? ''),
            json: '',
          });
        }
      } else if (type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text_delta', delta: delta.text };
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const acc = toolBlocks.get(Number(event.index));
          if (acc) acc.json += delta.partial_json;
        }
      } else if (type === 'content_block_stop') {
        const acc = toolBlocks.get(Number(event.index));
        if (acc) {
          let input: unknown = {};
          try {
            input = acc.json ? JSON.parse(acc.json) : {};
          } catch {
            input = {};
          }
          yield { type: 'tool_use', id: acc.id, name: acc.name, input };
          toolBlocks.delete(Number(event.index));
        }
      } else if (type === 'message_delta') {
        const r = event.delta?.stop_reason;
        if (r) stopReason = mapStopReason(r);
      }
      // message_start / message_stop / ping / unknown → ignored on purpose.
    }

    yield { type: 'stop', reason: stopReason };
  }
}
