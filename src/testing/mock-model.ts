/**
 * MockModelClient — a scripted ModelClient for offline tests and the demo. Constructed with
 * a list of "turns", each an array of ModelEvents (text deltas / tool_use / stop). Each
 * `stream()` call replays the next turn. `calls` records a deep-cloned snapshot of every
 * request at call time (messages are mutated between turns by the loop, so cloning matters).
 *
 * Exported via the package's "./testing" subpath.
 */
import type { ModelClient, ModelEvent, ModelStreamRequest } from '../engine/model.js';

export type ScriptedTurn = ModelEvent[];

export interface MockModelOptions {
  /** When the script runs out, repeat the last turn (drives the maxTurns test). */
  repeatLast?: boolean;
}

export class MockModelClient implements ModelClient {
  private index = 0;
  readonly calls: ModelStreamRequest[] = [];

  constructor(
    private readonly turns: ScriptedTurn[],
    private readonly options: MockModelOptions = {},
  ) {}

  async *stream(req: ModelStreamRequest): AsyncIterable<ModelEvent> {
    this.calls.push({ ...req, messages: structuredClone(req.messages) });

    let turn = this.turns[this.index];
    if (!turn) {
      turn =
        this.options.repeatLast && this.turns.length > 0
          ? this.turns[this.turns.length - 1]!
          : [{ type: 'stop', reason: 'end_turn' }];
    }
    this.index++;

    for (const ev of turn) {
      yield ev;
    }
  }
}

// Small builders for readable scripts.
export const textDelta = (delta: string): ModelEvent => ({ type: 'text_delta', delta });
export const toolUse = (id: string, name: string, input: unknown): ModelEvent => ({
  type: 'tool_use',
  id,
  name,
  input,
});
export const stop = (reason: 'end_turn' | 'tool_use' | 'max_tokens'): ModelEvent => ({
  type: 'stop',
  reason,
});
