# agent-core

[![License: MIT](https://img.shields.io/badge/License-MIT-BA0C2F.svg)](LICENSE)

**The reusable brain for on-site AI agents — the part that's the same every time, built
once and tested without a single API key.**

Put a support bot, a booking bot and a lead-capture bot side by side and they look like
three products. Underneath, they share a brain: a loop that talks to the model and runs
tools, retrieval over the business's own content, a short list of things the agent is
actually allowed to do, and a clean way to stop guessing and get a person. Build that
fresh for every client and you end up with a drawer of one-offs nobody wants to maintain.

**agent-core** is that brain, built once: a streaming Claude tool-use loop, hybrid
retrieval, tools that can be held for a human's approval, and an HTTP/SSE API for a chat
widget to talk to. A new agent is one config file plus the business's content — the core
does not change.

And you can check it yourself, offline. Installing needs the npm registry and nothing
else; after that it typechecks, tests and builds with **no API keys, no network and no
database**. Clone it and run the quick start below — no keys, no accounts.

Built by [Jeremy Warren](https://devdudejeremy.com) (DevDudeJeremy LLC) with a Claude
agent team: a written spec ([`docs/SPEC.md`](docs/SPEC.md)), a build agent and a separate
review agent, with tests gating every change.

## Quick start — no keys, no accounts

Needs npm and Node 22 (22.12 or newer), Node 24, or Node 26 and later. `.nvmrc` pins 22.

```bash
npm ci          # or npm install: both leave package-lock.json untouched
npm run check   # tsc --noEmit over src, tests, examples and scripts
npm test        # 50 tests, with fetch replaced by a function that throws
npm run build   # tsc -> dist/
```

Then run the agent itself — a scripted model and in-memory stores stand in for the paid
services:

```bash
npm run demo
```

It prints an `OFFLINE DEMO MODE` banner and listens on port 8787. From another terminal:

```bash
curl -N -X POST http://localhost:8787/agent/chat \
  -H 'content-type: application/json' -d '{"message":"hello"}'
```

What comes back is a complete server-sent-event conversation — the same frames a chat
widget would get:

```text
event: meta
data: {"protocolVersion":1,"conversationId":"<uuid>"}

event: text
data: {"delta":"Hi! "}

event: text
data: {"delta":"This is the DevDudeJeremy agent-core offline demo. "}

event: text
data: {"delta":"Ask me anything — I reply with a canned message so you can see the SSE stream."}

event: done
data: {"finishReason":"end_turn"}
```

And the chunker will happily chew on this repo's own docs — no embedding call, no keys:

```bash
npm run ingest -- --dir docs --dry-run
```

All the scripts:

| Script | What it does |
| --- | --- |
| `npm run check` | `tsc --noEmit` over src, tests, examples and scripts. |
| `npm test` | The offline suite, once. |
| `npm run test:watch` | The suite in watch mode. |
| `npm run build` | `tsc` to `dist/` (`src` only). |
| `npm run demo` | The local Node server, in offline demo mode when no env is set. |
| `npm run ingest -- --dir <path> [--dry-run]` | Chunk, embed and store content. `--dry-run` only counts chunks. |
| `npm run format` | Prettier over the code and JSON (single quotes, 100 columns). |
| `npm run format:check` | Exits non-zero if `format` would change a file. |

## Where to look first

If you only read seven files, read these:

| File | What it shows |
| --- | --- |
| [`src/engine/model.ts`](src/engine/model.ts) | The `ModelClient` seam. The only file that imports `@anthropic-ai/sdk`; it turns Anthropic's stream events (including `input_json_delta` fragments) into three plain events. |
| [`src/engine/conversation.ts`](src/engine/conversation.ts) | The bounded loop: retrieve, stream, run or gate each tool call, stop at `maxTurns`. |
| [`src/tools/types.ts`](src/tools/types.ts) | Tools declared with a Zod schema and a `gate`. |
| [`supabase/migrations/20260705000000_agent_core.sql`](supabase/migrations/20260705000000_agent_core.sql) | The schema, and hybrid retrieval fused with Reciprocal Rank Fusion in one SQL function. |
| [`src/stores/memory.ts`](src/stores/memory.ts) | The in-memory stores the tests run on, with the same fusion arithmetic. |
| [`test/gates.test.ts`](test/gates.test.ts) | The test that a gated tool never runs. |
| [`docs/SPEC.md`](docs/SPEC.md) | The design spec: decisions, rejected alternatives, acceptance criteria. |

## Architecture

One request, start to finish (`POST /agent/chat`):

```text
widget ──POST {message, conversationId?}──▶ createAgentHandler(agent)
  1. CORS allowlist · rate limit · validate body (Zod)
  2. ConversationStore: load or create the conversation; append the user message
  3. RAG: embed the message → VectorStore.query (vector + full-text, RRF-fused)
          → optional reranker → top-K chunks
  4. Compose: system prompt + history window
          + the user message with an untrusted <context> block (never persisted)
  5. Loop, at most maxTurns:
       ModelClient.stream() ──▶ SSE `text` deltas
       tool_use ──▶ gate 'none'            validate input (Zod) → run() → tool_result
                    gate 'human-approval'  never run; log `approval_required`;
                                           tell the model it is queued
  6. Persist the reply · SSE `done` · every step written to the EventSink
```

The choices behind it — the spec records what the big ones were chosen over:

- **One function, no server.** `createAgentHandler(agent)` returns
  `(req: Request) => Promise<Response>` and uses only web-standard APIs, so it is meant
  to mount on Node, Cloudflare Workers, Vercel, Deno or Bun behind a thin adapter. Only
  the Node adapter is written and has been run
  ([`examples/node-server.ts`](examples/node-server.ts)); the others are untried.
- **The model is behind an interface.** Everything talks to `ModelClient`. One file
  imports the Anthropic SDK; the tests inject a scripted `MockModelClient`.
- **Plain Messages API, not an agent framework.** The job is a short, bounded,
  auditable tool loop with a fixed set of actions. That's a call about matching the tool
  to the job, not a default.
- **Retrieval without a framework.** Four small files: chunk, embed, retrieve, ingest.
  pgvector cosine search and Postgres full-text search each return their top 12, and the
  two rankings are fused with RRF (k = 60) inside one SQL function, so retrieval is one
  round trip. A reranker hook sits after it. Full-text finds exact terms (a product name,
  a policy number) that vectors blur; vectors find paraphrases that full-text misses.
- **Gates are enforced in code, not in the prompt.** A prompt can be talked out of a
  rule; a loop that never calls a gated tool's `run()` can't. A tool marked
  `human-approval` is never executed by the loop. Its input is recorded as an
  `approval_required` event for a person to act on, and the model is told the request is
  queued.
- **Guardrails that config cannot remove.** A fixed block is always first in the system
  prompt (grounding, untrusted input, scope, actions). Per-business rules are added after
  it. Retrieved text is wrapped as untrusted data.
- **Stores are injected.** `VectorStore`, `ConversationStore` and `EventSink` each have a
  complete in-memory implementation and a Supabase one. Only one file imports
  `@supabase/supabase-js`.
- **Streaming over SSE.** It is plain HTTP, so it passes through serverless platforms,
  proxies and CDNs. The wire format is frozen in
  [`docs/http-contract.md`](docs/http-contract.md).
- **Three runtime dependencies:** `@anthropic-ai/sdk`, `@supabase/supabase-js`, `zod`.

[`docs/SPEC.md`](docs/SPEC.md) has the full reasoning. `SPEC §n` in a code comment or a
test name points at a section of it.

## How the tests work

`npm test` runs 50 tests in nine files and needs no network — and that isn't on the
honour system. [`test/setup.ts`](test/setup.ts) replaces the global `fetch` with a
function that throws, so a test that reached for a paid service through `fetch` would
fail instead of going online. (One file swaps in a recording stub for its own tests, then
puts the thrower back.)

Offline tests only work because stand-ins take the place of the real services, and a
stand-in is worth exactly as much as you're honest about it. So here are the four, with
what each one **cannot** prove:

| Stand-in | Replaces | What it cannot prove |
| --- | --- | --- |
| `MockModelClient` (scripted turns) | Claude | Anything about the real stream. `AnthropicModelClient` is typechecked but never called by a test. |
| `FeatureHashEmbeddings` (deterministic word hashing) | Voyage embeddings | Retrieval quality. It proves the pipeline and the fusion arithmetic, not that the best passage ranks first on real text. |
| Memory stores | Supabase (pgvector + Postgres) | The SQL itself. The memory store repeats the fusion arithmetic with a word-count stand-in for `ts_rank`; the migration is never executed (one test reads it as text, to check its two constants). |
| A recording `fetch` stub with canned replies | The Supabase HTTP API, for two write paths | That Postgres accepts the requests. It proves the order and bodies of what supabase-js sends for `upsertDocument` and `appendMessage`; the rest of the Supabase store is typechecked only. |

What each file checks:

| File | Checks |
| --- | --- |
| `test/conversation.test.ts` | Text streams in order and is saved; a tool call is validated, run and answered; bad tool input fails without stopping the loop; a model that never stops is cut off at `maxTurns`; exactly the newest `historyWindow` messages reach the model, and the window never opens on an assistant turn; the exact sequence of logged events; tool inputs never appear on the wire. |
| `test/gates.test.ts` | A `human-approval` tool is never run, an `approval_required` event carries its input, and the model is told it is queued. |
| `test/handoff.test.ts` | A `request_human_handoff` call logs `handoff_requested`, sets the conversation to `handed_off` and sends a `handoff` frame with the reason, checked on the loop's frames and on the wire; the turn still ends with `done`. With no such call, with a different tool running, or with invalid input, nothing is handed off. |
| `test/retrieve.test.ts` | A vector-only match and a keyword-only match both surface; the fused scores match the RRF formula for known ranks; k = 60 and 12 candidates per channel are pinned as literals, in the memory store's results, and in the text of the SQL function, which the migrations must define exactly once; the reranker can reorder; `topK` holds; re-ingesting unchanged content makes no embedding call and no write; changed content replaces that document's chunks. |
| `test/chunk.test.ts` | Chunking is deterministic, respects the size limit and the overlap, never crosses a heading, and prefixes each chunk with its heading path. |
| `test/prompt.test.ts` | The fixed guardrails always come first; business rules come after; the context block is marked untrusted and names its sources. |
| `test/handler.test.ts` | The HTTP contract: frame order, response headers, and 400 / 403 / 404 / 405 / 429 / 500 responses; a failure mid-stream ends with an `error` frame; a store that is down before a conversation exists gives a stream whose only frame is `error`. |
| `test/supabase-store.test.ts` | Against the recording stub: `upsertDocument` writes a `pending:` marker, replaces the chunks, then writes the real content hash; a failed chunk insert throws and the real hash is never written; ingest runs a document again while its stored hash is the marker; `appendMessage` throws when its `last_active_at` update fails; the network kill switch is back afterwards. |
| `test/lockfile.test.ts` | `vite` is a direct devDependency, none of the bundler is recorded as peer-only in the lockfile, and the native binaries for macOS, Linux and Windows are listed. This is what keeps a plain `npm install` from stripping the lockfile. |

### What the offline suite does not cover

The offline suite can't reach these five. They are implemented and typechecked, have
never met the real world, and each needs one live check before a first real deployment:

1. **Supabase round trip.** The `[…]` vector literal must cast to `vector(1024)` on
   insert and as the RPC argument, and the RPC rows must map into `RetrievedChunk`.
   Also confirm that a store call fails promptly when the network is down, and that a
   failed chunk insert leaves the document to be ingested again: `upsertDocument`'s
   write order (a `pending:` hash, delete, insert, the real hash) is tested only
   against a stub.
2. **Ranking on real Postgres.** `ddj_match_chunks` with pgvector and
   `websearch_to_tsquery` / `ts_rank`.
3. **The Anthropic stream.** One live call through `AnthropicModelClient.stream` with a
   tool call split across several `input_json_delta` events, and one conversation longer
   than `historyWindow`, to confirm the trimmed window is accepted.
4. **Voyage.** The real response shape and a 1024-dimension vector.
5. **Row-level security.** After applying the migration, confirm that only the
   service-role key can reach any `agent_` table.

## Using it for a real agent

Six steps, and none of them is "edit the core":

1. Copy [`examples/client-agent.example.ts`](examples/client-agent.example.ts) to
   `agent.config.ts` and fill in the business, persona, tools and allowed origins. Repoint
   its two imports: `'../src/index.js'` becomes `'./src/index.js'` when the copy sits at
   the package root.
2. Copy `.env.example` to `.env` **on the deployment host** and fill it in. Secrets never
   go in the repository.
3. Apply the migration to the Supabase project the agent will use (see below).
4. Put the business's content (`.md` / `.txt`) in a folder and ingest it:

   ```bash
   npm run ingest -- --dir ./knowledge            # embeds and upserts (needs env)
   npm run ingest -- --dir ./knowledge --dry-run  # chunk counts only
   ```

   Ingest is idempotent. A content hash is checked before embedding, so unchanged files
   cost nothing; a changed file replaces all of that document's chunks.
5. Mount `createAgentHandler(agent)` behind your platform's adapter.
6. Point the chat widget at the agent's base URL
   ([`docs/http-contract.md`](docs/http-contract.md)).

### Environment variables

Server-side only. Never expose them to the browser. Env is read only inside `fromEnv()`,
when it is called, so importing the package with nothing set never throws.

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Anthropic Messages API. |
| `AGENT_MODEL` | no | Model override; defaults to `claude-haiku-4-5`. |
| `VOYAGE_API_KEY` | yes | Voyage embeddings for RAG. |
| `SUPABASE_URL` | yes | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service-role key. Full access, server-side only. |
| `AGENT_ALLOWED_ORIGINS` | for browsers | Comma-separated CORS allowlist. `fromEnv()` does not insist on it: unset means an empty list, and every browser origin is refused. |

### Applying the migration

`supabase/migrations/20260705000000_agent_core.sql` is a file only. Nothing in this
repository applies it. Apply it yourself, to the project the agent will use, with the
Supabase CLI or dashboard. The agent connects with the service-role key, so row-level
security is enabled on every table with **no policies**: there is no anonymous or
signed-in access path. The embedding dimension (1024) must match `EMBEDDING_DIM` in
`src/rag/embed.ts`.

### Operating it

Worth knowing before it's in front of real visitors:

- Every action is written as an `AgentEvent` to the runtime's `EventSink` and to the
  optional `onEvent` hook. There is no default sink: `fromEnv()` supplies the Supabase one
  (rows in `agent_events`), and `ConsoleEventSink` (one JSON line per event on stdout) is
  what the offline demo uses. Tool inputs appear only in these server-side events, never
  in the SSE stream.
- `approval_required` and `handoff_requested` are the events a person acts on. Wire
  `onEvent` to Slack, email or a CRM. Acting on an approval is outside this package.
- What visitor data to keep, and for how long, is a decision for each deployment. Nothing
  here redacts or expires it.
- One deployment per business. There is no multi-tenant mode, and the rate limiter is
  in-memory.
- **Rate limiting behind a proxy.** The default client key is the first `X-Forwarded-For`
  hop, which the caller can set, so on its own it does not limit anyone who rotates that
  header. Behind a trusted proxy, set `http.clientKey` to read the address the proxy
  vouches for. The limiter never evicts a key it has seen.
- `historyWindow` is an upper bound. The window is trimmed so the request opens on a
  visitor message, so the model may see fewer messages than the setting.

## Layout

```text
src/
  config.ts          defineAgent(), defaults, fromEnv()
  engine/            the loop, the ModelClient seam, events
  rag/               chunk, embed, retrieve, ingest
  tools/             the tool interface and three reference tools
  prompts/           guardrails and the context block
  http/              handler, SSE, CORS, rate limit
  stores/            interfaces, memory stores, Supabase stores
  testing/           MockModelClient (exported as "@ddj/agent-core/testing")
test/                the offline suite
examples/            a Node server and a filled-in agent config
scripts/ingest.ts    the content ingest CLI
supabase/migrations/ the schema and the retrieval function
docs/                the design spec and the HTTP/SSE contract
```

## License

MIT © [DevDudeJeremy LLC](https://devdudejeremy.com) — see [LICENSE](LICENSE).

## Want something like this?

I build AI agents and integrations like this for clients —
**[devdudejeremy.com](https://devdudejeremy.com)**.
