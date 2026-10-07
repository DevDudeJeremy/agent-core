/**
 * The derivation exemplar: one business's agent, as one config file. Copy it to
 * `agent.config.ts` in a client agent and fill it in (business, persona, tools, allowed
 * origins). It demonstrates every commonly-set field. After copying, repoint the two
 * imports below: `./src/index.js` if the copy sits at the package root, or the package name
 * if agent-core is installed as a dependency.
 *
 * The file is everything the agent is except its runtime, so it loads with no keys:
 *
 *   npx tsx examples/node-server.ts --config examples/client-agent.example.ts \
 *     --content examples/client-content.example
 *
 * serves it offline and answers from that folder. On a deployment host the same file becomes
 * a production agent in one call: `createAgentHandler(defineAgentFromEnv(config))` behind
 * your platform's adapter. That call builds the runtime from the env vars and lets
 * `AGENT_MODEL` and `AGENT_ALLOWED_ORIGINS` override what is written here.
 * examples/node-server.ts does exactly that for Node when the env vars are set.
 *
 * A config may also bring part of the runtime with it, as `runtime: { modelClient }` for
 * instance: `AgentFile` allows it.
 */
import { captureLead, requestHandoff, bookAppointment } from '../src/index.js';
import type { AgentFile, Reranker } from '../src/index.js';

// Reranker hook: default is identity. Swap in a cross-encoder (Voyage/Cohere) per client.
const reranker: Reranker = async (_query, candidates) => candidates;

const config: AgentFile = {
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
  // model: left out, so it is claude-haiku-4-5 unless AGENT_MODEL says otherwise.
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
    allowedOrigins: ['https://acmeplumbing.example'],
    rateLimit: { windowMs: 60_000, max: 20 },
  },
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
};

export default config;
