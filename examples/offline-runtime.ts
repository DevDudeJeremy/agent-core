/**
 * The stand-ins that let an agent run with no keys, no network and no database: memory
 * stores, the word-hashing embedder, and a "model" that only quotes. They are for demos and
 * tests. Nothing here is a language model, and nothing here should meet a real visitor.
 */
import {
  ConsoleEventSink,
  FeatureHashEmbeddings,
  createMemoryStores,
  type AgentRuntime,
  type EventSink,
  type ModelClient,
  type ModelEvent,
  type ModelStreamRequest,
} from '../src/index.js';

export interface Passage {
  source: string;
  title: string;
  text: string;
}

const CHUNK_HEADER = /^\[chunk \d+ \| source: (.+) \| title: "(.*)"\]$/;

/**
 * The first passage in the `<context>` block the loop puts ahead of the visitor's message
 * (see formatContextBlock in src/prompts/system.ts), or null when there is no block.
 */
export function firstPassage(message: string): Passage | null {
  const end = message.indexOf('\n</context>');
  if (!message.startsWith('<context>\n') || end < 0) return null;

  let header: RegExpExecArray | null = null;
  const body: string[] = [];
  for (const line of message.slice(0, end).split('\n')) {
    const match = CHUNK_HEADER.exec(line);
    if (match && header) break; // the second passage starts here
    if (match) header = match;
    else if (header) body.push(line);
  }
  if (!header) return null;
  return { source: header[1]!, title: header[2]!, text: body.join('\n').trim() };
}

export const NO_PASSAGE_REPLY = "I don't have that in the content I was given.";

/**
 * What an offline agent's `model` is set to while a stand-in answers. Every model call is
 * logged with the agent's model, and offline no Claude model is called, so the log should
 * not name one.
 */
export const QUOTING_STAND_IN = 'offline-passage-quoting-stand-in';
export const SCRIPTED_STAND_IN = 'offline-scripted-stand-in';

/**
 * Stands in for the model offline. It generates nothing: it replies with the best-matching
 * passage that retrieval found, line by line, and names the file it came from. With no
 * passage it says so. That is enough to watch a business's own content come back through
 * the loop and over the wire. It says nothing about how a real model would answer.
 */
export class PassageQuotingModel implements ModelClient {
  async *stream(req: ModelStreamRequest): AsyncIterable<ModelEvent> {
    const last = req.messages.at(-1);
    const passage = typeof last?.content === 'string' ? firstPassage(last.content) : null;

    if (!passage) {
      yield { type: 'text_delta', delta: NO_PASSAGE_REPLY };
    } else {
      yield { type: 'text_delta', delta: `From ${passage.source}:` };
      for (const line of passage.text.split('\n')) {
        if (line.trim()) yield { type: 'text_delta', delta: `\n${line.trim()}` };
      }
    }
    yield { type: 'stop', reason: 'end_turn' };
  }
}

/**
 * Wrap a model so it waits `ms` before each piece of text. The stand-ins answer at once,
 * which would put a whole reply in one network read; paced, the frames can be seen arriving.
 * The demo server uses it. Tests leave the pace at 0, which returns the model untouched.
 */
export function paced(model: ModelClient, ms: number): ModelClient {
  if (!(ms > 0)) return model;
  return {
    async *stream(req: ModelStreamRequest): AsyncIterable<ModelEvent> {
      for await (const event of model.stream(req)) {
        if (event.type === 'text_delta') await new Promise((resolve) => setTimeout(resolve, ms));
        yield event;
      }
    },
  };
}

export interface OfflineRuntimeOptions {
  /** Milliseconds to wait before each piece of text. Default 0: answer at once. */
  paceMs?: number;
  /** Where events go. Default: one JSON line per event on stdout. */
  events?: EventSink;
}

/** A complete runtime made only of stand-ins. */
export function createOfflineRuntime(options: OfflineRuntimeOptions = {}): AgentRuntime {
  const { vectorStore, conversations } = createMemoryStores();
  return {
    modelClient: paced(new PassageQuotingModel(), options.paceMs ?? 0),
    embeddings: new FeatureHashEmbeddings(),
    vectorStore,
    conversations,
    events: options.events ?? new ConsoleEventSink(),
  };
}
