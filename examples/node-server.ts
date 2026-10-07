/**
 * Minimal node:http ⇄ fetch(Request/Response) adapter so you can run an agent locally.
 *
 *   npx tsx examples/node-server.ts [--config <file>] [--content <dir>] [--pace <ms>]
 *
 * No flags, no env: a LOUD "OFFLINE DEMO MODE" with memory stores and a scripted
 * MockModelClient, so a `curl -N` POST to /agent/chat returns a complete, valid SSE
 * conversation with zero network.
 *
 * --config <file>: serve the agent that config file describes (see
 * examples/client-agent.example.ts). With no env it runs on the offline stand-ins and, given
 * --content <dir>, reads that folder into its store first and answers by quoting from it.
 * With the required env vars present, the same file gets a production runtime through
 * defineAgentFromEnv() instead; content is then ingested beforehand with `npm run ingest`,
 * not here.
 *
 * --pace <ms>: how long the offline stand-ins wait before each piece of text (default 150),
 * so the frames can be seen arriving one at a time. 0 answers at once.
 */
import { createServer, type IncomingMessage } from 'node:http';
import {
  createAgentHandler,
  defineAgentFromEnv,
  type AgentFile,
  type ResolvedAgentConfig,
} from '../src/index.js';
import { buildOfflineAgent, buildScriptedAgent, loadAgentFile } from './load-agent.js';

const PORT = Number(process.env.PORT ?? 8787);

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const configPath = flag('--config');
const contentDir = flag('--content');
const paceMs = Number(flag('--pace') ?? 150);

const hasEnv = Boolean(
  process.env.ANTHROPIC_API_KEY && process.env.VOYAGE_API_KEY && process.env.SUPABASE_URL,
);

function banner(secondLine: string): void {
  const lines = ['OFFLINE DEMO MODE — no env, no network, no DB', secondLine];
  const width = Math.max(...lines.map((line) => line.length));
  console.log('');
  console.log(`  ┌${'─'.repeat(width + 4)}┐`);
  for (const line of lines) console.log(`  │  ${line.padEnd(width)}  │`);
  console.log(`  └${'─'.repeat(width + 4)}┘`);
  console.log('');
}

async function buildAgent(): Promise<ResolvedAgentConfig> {
  if (hasEnv) {
    if (configPath && contentDir) {
      console.log(
        `--content is ignored with real keys. Ingest it first: npm run ingest -- --dir ${contentDir}`,
      );
    }
    // Real keys, so no wildcard: without a config, only origins listed in
    // AGENT_ALLOWED_ORIGINS may call from a browser, and unset means none. Requests with no
    // Origin header (curl) still work.
    const file: AgentFile = configPath
      ? await loadAgentFile(configPath)
      : {
          business: { name: 'Demo Co', description: 'agent-core online demo.' },
          persona: { name: 'Demo Assistant', tone: 'Friendly and concise.' },
          http: { allowedOrigins: [] },
        };
    return defineAgentFromEnv(file);
  }

  if (configPath) {
    const file = await loadAgentFile(configPath);
    const ownModel = Boolean(file.runtime?.modelClient);
    banner(
      ownModel
        ? 'Memory stores + the model the config supplies.'
        : 'Memory stores + a passage-quoting stand-in.',
    );
    const { agent, ingest } = await buildOfflineAgent(file, { contentDir, paceMs });
    console.log(`  Agent:   ${agent.persona.name}, for ${agent.business.name} (${configPath})`);
    console.log(
      ingest
        ? `  Content: ${ingest.documents} document(s), ${ingest.chunks} chunk(s) from ${contentDir}`
        : '  Content: none. Pass --content <dir> to give it something to answer from.',
    );
    console.log(
      ownModel
        ? '  Replies come from the model the config supplies.'
        : '  Replies quote the best-matching passage. No language model is called.',
    );
    console.log('');
    return agent;
  }

  banner('Memory stores + scripted MockModelClient.');
  return buildScriptedAgent({ paceMs });
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

const agent = await buildAgent();
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
