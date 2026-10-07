/**
 * AnthropicModelClient, run through the real `@anthropic-ai/sdk`. `fetch` is replaced by a
 * stub that records each request and replays a Messages stream, then the network kill
 * switch is put back.
 *
 * The streams below are written out from Anthropic's published streaming reference
 * (platform.claude.com/docs/en/build-with-claude/streaming, read 2026-10-07): the two
 * `DOCUMENTED_` ones are its "basic" and "tool use" examples, event for event. They are
 * NOT recordings of a live call.
 *
 * What this proves: that the client and the SDK turn the documented stream into the three
 * events the loop consumes, that the loop completes a tool round trip over it, and what the
 * SDK puts on the wire for each request.
 * What it cannot prove: that the live API sends this today, or accepts these requests (the
 * model id, the tool schemas). One live call does that; the README says how.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  AnthropicModelClient,
  NON_NEGOTIABLE_GUARDRAILS,
  captureLead,
  createAgentHandler,
  type ModelEvent,
} from '../src/index.js';
import { buildAgent, collectTurn, parseSSE, textReader } from './harness.js';

type WireEvent = [event: string, data: Record<string, unknown>];

const encode = (events: WireEvent[]): string =>
  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

const messageStart = (id: string): WireEvent => [
  'message_start',
  {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-haiku-4-5',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 25, output_tokens: 1 },
    },
  },
];
const textStart = (index: number): WireEvent => [
  'content_block_start',
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
];
const text = (index: number, value: string): WireEvent => [
  'content_block_delta',
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } },
];
const toolStart = (index: number, id: string, name: string): WireEvent => [
  'content_block_start',
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
];
const json = (index: number, fragment: string): WireEvent => [
  'content_block_delta',
  {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: fragment },
  },
];
const blockStop = (index: number): WireEvent => [
  'content_block_stop',
  { type: 'content_block_stop', index },
];
const ping: WireEvent = ['ping', { type: 'ping' }];
const messageEnd = (stopReason: string): WireEvent[] => [
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 15 },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
];

/** The reference's "Basic streaming request" response. */
const DOCUMENTED_TEXT: WireEvent[] = [
  messageStart('msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY'),
  textStart(0),
  ping,
  text(0, 'Hello'),
  text(0, '!'),
  blockStop(0),
  ...messageEnd('end_turn'),
];

/** The reference's "Streaming request with tool use" response. */
const DOCUMENTED_TOOL_USE: WireEvent[] = [
  messageStart('msg_014p7gG3wDgGV9EUtLvnow3U'),
  textStart(0),
  ping,
  ...['Okay', ',', ' let', "'s", ' check', ' the', ' weather', ' for'].map((t) => text(0, t)),
  ...[' San', ' Francisco', ',', ' CA', ':'].map((t) => text(0, t)),
  blockStop(0),
  toolStart(1, 'toolu_01T1x1fJ34qAmk2tNTrN7Up6', 'get_weather'),
  json(1, ''),
  json(1, '{"location":'),
  json(1, ' "San'),
  json(1, ' Francisc'),
  json(1, 'o,'),
  json(1, ' CA"}'),
  blockStop(1),
  ...messageEnd('tool_use'),
];

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const killSwitch = globalThis.fetch;
/**
 * With a key passed in, the SDK still reads these five by itself when a client is built. A
 * developer's shell may set some (a gateway, a proxy, debug logging), and the requests below
 * must not depend on that.
 */
const SDK_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_LOG',
  'ANTHROPIC_WEBHOOK_SIGNING_KEY',
];
beforeEach(() => {
  for (const name of SDK_ENV) vi.stubEnv(name, undefined);
});
afterEach(() => {
  globalThis.fetch = killSwitch;
  vi.unstubAllEnvs();
});

const streamResponse = (body: string | ReadableStream<Uint8Array>): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

/**
 * Install the recording stub and build a client over it. The SDK takes hold of `fetch` when
 * the client is constructed, so the order matters. Each request is answered by the next
 * reply in line.
 */
function clientReplaying(...replies: Array<WireEvent[] | Response>): {
  client: AnthropicModelClient;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const req = new Request(...args);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    sent.push({
      url: req.url,
      method: req.method,
      headers,
      body: JSON.parse(await req.text()) as Record<string, unknown>,
    });
    const reply = replies[sent.length - 1];
    if (!reply) throw new Error(`no reply scripted for request ${sent.length}`);
    return reply instanceof Response ? reply : streamResponse(encode(reply));
  }) as typeof fetch;
  return { client: AnthropicModelClient.fromApiKey('test-anthropic-key'), sent };
}

const REQUEST = {
  model: 'claude-haiku-4-5',
  system: 'You are a test.',
  messages: [{ role: 'user' as const, content: 'hello' }],
  tools: [
    {
      name: 'get_weather',
      description: 'Get the weather for a place.',
      input_schema: { type: 'object', properties: { location: { type: 'string' } } },
    },
  ],
  maxTokens: 512,
};

async function drain(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe('AnthropicModelClient over the documented stream (SPEC §9.20)', () => {
  it('passes text deltas through in order and ignores ping', async () => {
    const { client } = clientReplaying(DOCUMENTED_TEXT);

    expect(await drain(client.stream(REQUEST))).toEqual([
      { type: 'text_delta', delta: 'Hello' },
      { type: 'text_delta', delta: '!' },
      { type: 'stop', reason: 'end_turn' },
    ]);
  });

  it('reassembles a tool call from its input_json_delta fragments', async () => {
    const { client } = clientReplaying(DOCUMENTED_TOOL_USE);

    const events = await drain(client.stream(REQUEST));

    expect(
      events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta),
    ).toEqual([
      'Okay',
      ',',
      ' let',
      "'s",
      ' check',
      ' the',
      ' weather',
      ' for',
      ' San',
      ' Francisco',
      ',',
      ' CA',
      ':',
    ]);
    // One tool_use event, after the text, with the six fragments parsed as one object.
    expect(events.slice(-2)).toEqual([
      {
        type: 'tool_use',
        id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
        name: 'get_weather',
        input: { location: 'San Francisco, CA' },
      },
      { type: 'stop', reason: 'tool_use' },
    ]);
  });

  it.each([
    ['end_turn', 'end_turn'],
    ['tool_use', 'tool_use'],
    ['max_tokens', 'max_tokens'],
    // The loop knows three ways to stop. Every other documented reason ends the turn.
    ['stop_sequence', 'end_turn'],
    ['pause_turn', 'end_turn'],
    ['refusal', 'end_turn'],
  ])('maps stop_reason %s to %s', async (wire, mapped) => {
    const { client } = clientReplaying([
      messageStart('msg_stop'),
      textStart(0),
      text(0, 'x'),
      blockStop(0),
      ...messageEnd(wire),
    ]);

    expect((await drain(client.stream(REQUEST))).at(-1)).toEqual({ type: 'stop', reason: mapped });
  });

  it('sends the request the Messages API documents, and nothing else', async () => {
    const { client, sent } = clientReplaying(DOCUMENTED_TEXT);

    await drain(client.stream(REQUEST));

    expect(sent).toHaveLength(1);
    expect(`${sent[0]!.method} ${sent[0]!.url}`).toBe('POST https://api.anthropic.com/v1/messages');
    expect(sent[0]!.headers).toMatchObject({
      'x-api-key': 'test-anthropic-key',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });
    expect(sent[0]!.headers).not.toHaveProperty('authorization');
    expect(sent[0]!.body).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      system: 'You are a test.',
      messages: [{ role: 'user', content: 'hello' }],
      tools: REQUEST.tools,
      stream: true,
    });
  });

  it('the SDK, not this package, honours ANTHROPIC_BASE_URL when it is set', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gateway.example/anthropic');
    const { client, sent } = clientReplaying(DOCUMENTED_TEXT);

    await drain(client.stream(REQUEST));

    expect(sent[0]!.url).toBe('https://gateway.example/anthropic/v1/messages');
  });

  it('and ANTHROPIC_AUTH_TOKEN and ANTHROPIC_CUSTOM_HEADERS: both end up on the request', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'test-auth-token');
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'x-team: front-desk\nx-trace: abc123');
    const { client, sent } = clientReplaying(DOCUMENTED_TEXT);

    await drain(client.stream(REQUEST));

    expect(sent[0]!.headers).toMatchObject({
      'x-api-key': 'test-anthropic-key',
      authorization: 'Bearer test-auth-token',
      'x-team': 'front-desk',
      'x-trace': 'abc123',
    });
  });
});

describe('the loop over the real client (SPEC §9.20)', () => {
  const LEAD_TURN: WireEvent[] = [
    messageStart('msg_lead_1'),
    textStart(0),
    text(0, 'One '),
    text(0, 'moment.'),
    blockStop(0),
    toolStart(1, 'toolu_01LEAD', 'capture_lead'),
    json(1, ''),
    json(1, '{"email":'),
    json(1, ' "ada@'),
    json(1, 'example.com",'),
    json(1, ' "name": "Ada"}'),
    blockStop(1),
    ...messageEnd('tool_use'),
  ];
  const FOLLOW_UP: WireEvent[] = [
    messageStart('msg_lead_2'),
    textStart(0),
    text(0, 'Thanks, Ada. '),
    text(0, 'We will be in touch.'),
    blockStop(0),
    ...messageEnd('end_turn'),
  ];

  it('completes a two-request tool round trip, and the second request carries the tool_result', async () => {
    const { client, sent } = clientReplaying(LEAD_TURN, FOLLOW_UP);
    const { agent, sink } = buildAgent(client, { tools: [captureLead] });

    const frames = await collectTurn(agent, 'email me at ada@example.com');

    // The tool ran once, on the input the fragments spelled out.
    expect(sink.events.filter((e) => e.type === 'lead_captured').map((e) => e.payload)).toEqual([
      { email: 'ada@example.com', name: 'Ada' },
    ]);
    expect(frames.map((f) => f.event)).toEqual([
      'meta',
      'text',
      'text',
      'tool',
      'tool',
      'text',
      'text',
      'done',
    ]);
    expect(
      frames
        .filter((f) => f.event === 'text')
        .map((f) => (f.data as { delta: string }).delta)
        .join(''),
    ).toBe('One moment.Thanks, Ada. We will be in touch.');

    // Two requests. The first offers the tool, with the guardrails leading the system prompt.
    expect(sent).toHaveLength(2);
    const first = sent[0]!.body as { system: string; tools: Array<Record<string, unknown>> };
    expect(first.system.startsWith(NON_NEGOTIABLE_GUARDRAILS)).toBe(true);
    expect(first.tools).toHaveLength(1);
    expect(first.tools[0]).toMatchObject({
      name: 'capture_lead',
      input_schema: { type: 'object' },
    });
    expect(Object.keys(first.tools[0]!).sort()).toEqual(['description', 'input_schema', 'name']);

    // The second replays the assistant's turn and answers it the way the API asks: one user
    // message holding a tool_result that names the tool_use it answers.
    expect(sent[1]!.body.messages).toEqual([
      { role: 'user', content: 'email me at ada@example.com' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'One moment.' },
          {
            type: 'tool_use',
            id: 'toolu_01LEAD',
            name: 'capture_lead',
            input: { email: 'ada@example.com', name: 'Ada' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01LEAD',
            content:
              "Thanks — I've noted contact details for Ada. Someone from the team will follow up soon.",
            is_error: false,
          },
        ],
      },
    ]);
    expect(Object.keys(sent[1]!.body).sort()).toEqual(Object.keys(sent[0]!.body).sort());
  });

  it('a tool call cut off by max_tokens is not run', async () => {
    const runSpy = vi.spyOn(captureLead, 'run');
    const { client, sent } = clientReplaying([
      messageStart('msg_cut'),
      toolStart(0, 'toolu_01CUT', 'capture_lead'),
      json(0, '{"email": "ada@exa'),
      blockStop(0),
      ...messageEnd('max_tokens'),
    ]);
    const { agent, sink } = buildAgent(client, { tools: [captureLead] });

    const frames = await collectTurn(agent, 'email me');
    runSpy.mockRestore();

    expect(runSpy).not.toHaveBeenCalled();
    expect(sink.events.some((e) => e.type === 'lead_captured' || e.type === 'tool_executed')).toBe(
      false,
    );
    expect(sent).toHaveLength(1);
    expect(frames.map((f) => f.event)).toEqual(['meta', 'done']);
  });

  it('an error event in the stream ends the turn with an error frame', async () => {
    const { client } = clientReplaying([
      messageStart('msg_err'),
      textStart(0),
      text(0, 'Let me'),
      // The reference's example of an error arriving mid-stream.
      ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
    ]);
    const { agent, sink } = buildAgent(client);

    const frames = await collectTurn(agent, 'hello');

    expect(frames.map((f) => f.event)).toEqual(['meta', 'text', 'error']);
    expect(frames.at(-1)!.data).toEqual({
      code: 'server_error',
      message: 'Something went wrong handling this message.',
    });
    // The cause is logged for the operator and kept off the wire.
    const logged = sink.events.find((e) => e.type === 'error')!;
    expect(String(logged.payload.message)).toContain('Overloaded');
    expect(JSON.stringify(frames)).not.toContain('Overloaded');
  });

  it('a refused key ends the turn with an error frame after one request', async () => {
    const { client, sent } = clientReplaying(
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );
    const { agent } = buildAgent(client);

    const frames = await collectTurn(agent, 'hello');

    expect(sent).toHaveLength(1);
    expect(frames.map((f) => f.event)).toEqual(['meta', 'error']);
  });
});

describe('the real client streams (SPEC §9.21)', () => {
  it('the first text frame reaches the HTTP reader while the upstream response is still open', async () => {
    // The upstream body is fed by hand. No timers. If the client, the SDK, the loop or the
    // handler waited for the whole response before passing anything on, the first read
    // below could never resolve and this test would time out.
    const encoder = new TextEncoder();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
      },
    });
    const send = (events: WireEvent[]): void => upstream.enqueue(encoder.encode(encode(events)));

    const { client, sent } = clientReplaying(streamResponse(body));
    const { agent } = buildAgent(client);
    const res = await createAgentHandler(agent)(
      new Request('http://host/agent/chat', {
        method: 'POST',
        headers: { origin: 'https://ok.example', 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      }),
    );
    const wire = textReader(res.body!);

    send([messageStart('msg_live'), textStart(0), ping, text(0, 'Hello')]);
    const early = await wire.until('"delta":"Hello"');

    // The reader has the first frame. The model's second delta has not been sent at all.
    expect(parseSSE(early).map((f) => f.event)).toEqual(['meta', 'text']);
    expect(sent).toHaveLength(1);

    send([text(0, '!'), blockStop(0), ...messageEnd('end_turn')]);
    upstream.close();

    const all = parseSSE(await wire.toEnd());
    expect(all.map((f) => f.event)).toEqual(['meta', 'text', 'text', 'done']);
    expect(all[2]!.data).toEqual({ delta: '!' });
  }, 3000);
});
