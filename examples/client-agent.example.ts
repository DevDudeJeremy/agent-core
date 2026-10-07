/**
 * The derivation exemplar. Copy this to `agent.config.ts` in a client agent and fill it in
 * (business, persona, tools, allowed origins). It demonstrates every commonly-set field.
 * After copying, repoint the two imports below: `./src/index.js` if the copy sits at the
 * package root, or the package name if agent-core is installed as a dependency.
 * `fromEnv()` builds the production runtime from the deployment host's env vars.
 *
 * Then mount `createAgentHandler(agent)` behind your platform's adapter (see
 * examples/node-server.ts for the Node shape).
 */
import {
  defineAgent,
  fromEnv,
  captureLead,
  requestHandoff,
  bookAppointment,
} from '../src/index.js';
import type { Reranker } from '../src/index.js';

const { runtime, model, allowedOrigins } = fromEnv();

// Reranker hook: default is identity. Swap in a cross-encoder (Voyage/Cohere) per client.
const reranker: Reranker = async (_query, candidates) => candidates;

export const agent = defineAgent({
  business: {
    name: 'Acme Plumbing',
    description: 'Family-run plumbing and heating serving the Tri-City area since 1998.',
    website: 'https://acmeplumbing.example',
  },
  persona: {
    name: 'Ace',
    tone: 'Warm, practical, and to the point. Sound like a helpful front-desk pro, not a salesperson.',
    language: 'en',
  },
  model, // undefined → defaults to claude-haiku-4-5
  maxTokens: 1024,
  limits: { maxTurns: 6, historyWindow: 20, maxMessageChars: 2000 },
  guardrails: {
    // ADDITIVE only — these land after the non-negotiable safety block, never replacing it.
    extraRules: [
      'Never quote an exact price. Give a typical range and offer a callback for a firm quote.',
      'For emergencies (flooding, gas smell), tell the visitor to call the emergency line immediately.',
    ],
  },
  tools: [captureLead, requestHandoff, bookAppointment],
  rag: { enabled: true, topK: 4, reranker },
  http: {
    basePath: '/agent',
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : ['https://acmeplumbing.example'],
    rateLimit: { windowMs: 60_000, max: 20 },
  },
  runtime,
  onEvent: async (e) => {
    // Wire the human-in-the-loop + lead signals to Slack / email / CRM here.
    if (
      e.type === 'approval_required' ||
      e.type === 'handoff_requested' ||
      e.type === 'lead_captured'
    ) {
      // await notifyTeam(e);
    }
  },
});

export default agent;
