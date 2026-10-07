/**
 * Minimal node:http ⇄ fetch(Request/Response) adapter so you can run the agent locally.
 *
 *   npx tsx examples/node-server.ts
 *
 * With the required env vars present it builds a production runtime via fromEnv(). With no
 * env it runs a LOUD "OFFLINE DEMO MODE": memory stores + a scripted MockModelClient, so a
 * `curl -N` POST to /agent/chat returns a complete, valid SSE conversation with zero network.
 */
import { createServer, type IncomingMessage } from 'node:http';
import {
  ConsoleEventSink,
  FeatureHashEmbeddings,
  createAgentHandler,
  createMemoryStores,
  defineAgent,
  fromEnv,
  type ResolvedAgentConfig,
} from '../src/index.js';
import { MockModelClient, stop, textDelta } from '../src/testing/mock-model.js';

const PORT = Number(process.env.PORT ?? 8787);

const hasEnv = Boolean(
  process.env.ANTHROPIC_API_KEY && process.env.VOYAGE_API_KEY && process.env.SUPABASE_URL,
);

function buildAgent(): ResolvedAgentConfig {
  if (hasEnv) {
    const { runtime, model, allowedOrigins } = fromEnv();
    return defineAgent({
      business: { name: 'Demo Co', description: 'agent-core online demo.' },
      persona: { name: 'Demo Assistant', tone: 'Friendly and concise.' },
      model,
      // Real keys, so no wildcard: only origins listed in AGENT_ALLOWED_ORIGINS may call from
      // a browser. Unset means none. Requests with no Origin header (curl) still work.
      http: { allowedOrigins },
      runtime,
    });
  }

  console.log('');
  console.log('  ┌─────────────────────────────────────────────────┐');
  console.log('  │  OFFLINE DEMO MODE — no env, no network, no DB  │');
  console.log('  │  Memory stores + scripted MockModelClient.      │');
  console.log('  └─────────────────────────────────────────────────┘');
  console.log('');

  const { vectorStore, conversations } = createMemoryStores();
  const modelClient = new MockModelClient(
    [
      [
        textDelta('Hi! '),
        textDelta('This is the DevDudeJeremy agent-core offline demo. '),
        textDelta('Ask me anything — I reply with a canned message so you can see the SSE stream.'),
        stop('end_turn'),
      ],
    ],
    { repeatLast: true },
  );

  return defineAgent({
    business: {
      name: 'Demo Co',
      description: 'A demo business for the agent-core offline showcase.',
    },
    persona: { name: 'Demo Assistant', tone: 'Friendly, concise, and helpful.' },
    rag: { enabled: false },
    http: { allowedOrigins: ['*'] },
    runtime: {
      modelClient,
      embeddings: new FeatureHashEmbeddings(),
      vectorStore,
      conversations,
      events: new ConsoleEventSink(),
    },
  });
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = req.method ?? 'GET';
  const init: RequestInit = { method, headers };
  if (chunks.length > 0 && method !== 'GET' && method !== 'HEAD') {
    init.body = Buffer.concat(chunks).toString('utf8');
  }
  return new Request(`http://localhost:${PORT}${req.url ?? '/'}`, init);
}

const agent = buildAgent();
const handler = createAgentHandler(agent);

const server = createServer(async (req, res) => {
  const response = await handler(await toRequest(req));
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.flushHeaders();
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  }
  res.end();
});

server.listen(PORT, () => {
  const base = agent.http.basePath;
  console.log(`agent-core listening on http://localhost:${PORT}${base}`);
  console.log(`  health:  curl http://localhost:${PORT}${base}/health`);
  console.log(
    `  chat:    curl -N -X POST http://localhost:${PORT}${base}/chat ` +
      `-H 'content-type: application/json' -d '{"message":"hello"}'`,
  );
});
