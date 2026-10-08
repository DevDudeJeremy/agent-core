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
npm test        # 180 tests, with fetch replaced by a function that throws
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

That reply is canned, and the frames are paced a little so you can watch them arrive. To
see an agent that is nothing but a config file and a folder of content, stop the server
and start it again with both:

```bash
npm run demo -- --config examples/client-agent.example.ts --content examples/client-content.example
```

Then ask it something the folder covers:

```bash
curl -N -X POST http://localhost:8787/agent/chat \
  -H 'content-type: application/json' -d '{"message":"Do you fix water heaters?"}'
```

```text
event: meta
data: {"protocolVersion":1,"conversationId":"<uuid>"}

event: text
data: {"delta":"From services.md:"}

event: text
data: {"delta":"\nServices > Water heaters"}

event: text
data: {"delta":"\nWe repair and replace gas and electric water heaters. Most replacements are done the same day."}

event: done
data: {"finishReason":"end_turn"}
```

No model wrote that. Offline, a stand-in takes the model's place, and all it does is quote
the passage retrieval ranked first and name the file it came from. That's enough to watch
a business's own content come back through the loop and over the wire with no key.
"Ranked first" means shared words here, so ask it something off-topic and it may still
quote you something. Swap the config and the folder for another business and you have
another agent, with nothing under `src/` touched:
[`test/new-agent.test.ts`](test/new-agent.test.ts) does exactly that with a bookshop it
makes up on the spot.

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
| `npm run demo` | The local Node server, in offline demo mode when no env is set. `-- --config <file> --content <dir>` serves that agent; `--pace <ms>` sets how fast the offline stand-ins talk (default 150, `0` for all at once). |
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
| [`supabase/migrations/`](supabase/migrations/) | The schema, and hybrid retrieval fused with Reciprocal Rank Fusion in one SQL function. The second file is that function as it stands. |
| [`src/stores/memory.ts`](src/stores/memory.ts) | The in-memory stores the tests run on, with the same fusion arithmetic and the same keyword rule. |
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
  imports the Anthropic SDK; most tests inject a scripted `MockModelClient`, and one runs
  the real client through the real SDK against a replay of the documented stream.
- **Plain Messages API, not an agent framework.** The job is a short, bounded,
  auditable tool loop with a fixed set of actions. That's a call about matching the tool
  to the job, not a default.
- **Retrieval without a framework.** Four small files: chunk, embed, retrieve, ingest.
  pgvector cosine search and Postgres full-text search each hand over at most 12
  passages, and the two rankings are fused with RRF (k = 60) inside one SQL function, so
  retrieval is one round trip. A reranker hook sits after it. Vectors find paraphrases
  that full-text misses. Full-text finds exact terms (a product name, a part number) that
  vectors blur, under one rule: the keyword half gives a passage a vote only when the
  passage holds **more than half** of the message's meaningful words. The message is
  read as plain words, with stop words dropped and the rest matched by stem. Passages
  that qualify are ordered by how many of the words they hold, then by `ts_rank`. That is
  how a part number the vector half missed reaches the model in
  [`test/postgres.test.ts`](test/postgres.test.ts).
  The rule is that strict because of the fusion's own arithmetic. With two lists of 12 at
  k = 60, a passage in both lists outranks every passage in only one, whatever the
  ranks, so a keyword half that let in every passage sharing a word would turn the
  fusion into "whatever is in both lists wins". The price is that it is often silent:
  when no passage holds more than half of the words, which is the usual case on a long,
  chatty message, the vector half decides alone. And it counts every word the same. It
  can't tell which word is the subject: ask the example content "Can you repair my boiler
  the same day?" and the keyword vote goes to the water-heater passage, for "repair" and
  "day", not to the one about boilers.
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

`npm test` runs 180 tests in thirteen files and needs no network — and that isn't on the
honour system. [`test/setup.ts`](test/setup.ts) replaces the global `fetch` with a
function that throws, so a test that reached for a paid service through `fetch` would
fail instead of going online. (Four files swap in a stub of their own for some tests,
then put the thrower back.)

Offline tests only work because stand-ins take the place of the real services, and a
stand-in is worth exactly as much as you're honest about it. So here are the seven, with
what each one **cannot** prove:

| Stand-in | Replaces | What it cannot prove |
| --- | --- | --- |
| `MockModelClient` (scripted turns) | Claude, in most tests | Anything about the real stream. It drives the loop; the real client has the next row. |
| A replay of Anthropic's documented stream, through the real SDK | The Anthropic API | That the live service sends this today, or accepts these requests. The stream is written out from the published streaming reference, event for event. It is not a recording of a call. |
| A stand-in that only quotes (`examples/offline-runtime.ts`) | Claude, in the config demo and its test | That a model answers well from a passage. It shows the right passage came back, and nothing about language. |
| `FeatureHashEmbeddings` (deterministic word hashing) | Voyage embeddings | Retrieval quality. It proves the pipeline and the fusion arithmetic, not that the best passage ranks first on real text. `VoyageEmbeddings` itself is typechecked and never called. |
| Memory stores | Supabase (pgvector + Postgres) | Anything about stemming, how Postgres ranks, how a server indexes a stored passage, or what the database refuses: the memory stores accept a message holding a NUL character or an unpaired surrogate, and through Supabase that message fails the turn. The memory store repeats the fusion arithmetic, the keyword half's majority rule, Postgres's own stop words and both bounds on what is read of a message. It does not stem, and among passages holding the same words it orders by a plain count where Postgres uses `ts_rank`. One test runs the same fixtures through both and asserts where they part ways. |
| PGlite (Postgres with pgvector, compiled to WebAssembly, in the test process) | A Supabase project's database | Anything about Supabase's own layer. The SQL is really executed, but there is no PostgREST in front of it, the roles are made by the test to stand for Supabase's, and the Postgres version is PGlite's, 18.3, which is one server and not the one a project runs. |
| A recording `fetch` stub with canned replies | The Supabase HTTP API | That PostgREST accepts the requests. It proves the order and bodies of what supabase-js sends for `upsertDocument`, `appendMessage` and the event sink, and that a store which is down is tried once and given up on by a deadline. One call, `ddj_match_chunks`, is answered by the real function instead of a canned reply. |

What each file checks:

| File | Checks |
| --- | --- |
| `test/conversation.test.ts` | Text streams in order and is saved; a tool call is validated, run and answered; bad tool input fails without stopping the loop; a model that never stops is cut off at `maxTurns`; exactly the newest `historyWindow` messages reach the model, and the window never opens on an assistant turn; a tool the agent was not given is never run, the model is told, and the turn carries on; an error before a conversation exists is logged with no conversation id, and the `onEvent` hook hears of an error even when the sink is down; the exact sequence of logged events; tool inputs never appear on the wire. |
| `test/gates.test.ts` | A `human-approval` tool is never run, an `approval_required` event carries its input, and the model is told it is queued. |
| `test/handoff.test.ts` | A `request_human_handoff` call logs `handoff_requested`, sets the conversation to `handed_off` and sends a `handoff` frame with the reason, checked on the loop's frames and on the wire; the turn still ends with `done`. With no such call, with a different tool running, or with invalid input, nothing is handed off. |
| `test/retrieve.test.ts` | A vector-only match and a keyword-only match both surface; the fused scores match the RRF formula for known ranks; k = 60 and 12 candidates per channel are pinned as literals, in the memory store's results, and in the text of the SQL function in force, along with the one expression that reads the message (its cut at 10,000 characters and its rule for unbroken runs), `strip` on the stored side, the keyword order with its collation, and the majority comparison; the first migration file is byte-identical to its recorded hash, and no file defines the function twice; the reranker can reorder; `topK` holds; re-ingesting unchanged content makes no embedding call and no write; changed content replaces that document's chunks. |
| `test/chunk.test.ts` | Chunking is deterministic, respects the size limit and the overlap, never crosses a heading, and prefixes each chunk with its heading path. |
| `test/prompt.test.ts` | The fixed guardrails always come first; business rules come after; the context block is marked untrusted and names its sources. |
| `test/handler.test.ts` | The HTTP contract: frame order, response headers, and 400 / 403 / 404 / 405 / 429 / 500 responses; a failure mid-stream ends with an `error` frame; a store that is down before a conversation exists gives a stream whose only frame is `error`; the first `text` frame reaches the reader while the model is still mid-reply; `health` is readable from any origin while `chat` keeps the allowlist. |
| `test/anthropic-client.test.ts` | `AnthropicModelClient` through the real SDK, against the documented stream: text deltas arrive in order; a tool call is put back together from its `input_json_delta` fragments; each stop reason maps; the request is the one the Messages API documents. Then the loop on top of it: a two-request tool round trip whose second request carries the `tool_result`; a tool call cut off by `max_tokens` is not run; an `error` event mid-stream and a refused key each end the turn with an `error` frame; and the first frame reaches the HTTP reader while the upstream response is still open. The SDK's own `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_CUSTOM_HEADERS` end up on the request, as the variables section says. |
| `test/postgres.test.ts` | On Postgres with pgvector, one server (PGlite, PostgreSQL 18.3): both migrations apply in name order, twice; a vector-only and a keyword-only match both surface with the RRF scores for hand-set ranks; each channel is cut at 12, and the keyword cut keeps the twelve passages holding the most words. The keyword half: a passage holding more than half of the words gets a vote and one holding exactly half does not; the order is words held, then rank, then document in byte order, then chunk; a part number the vector half missed is among the four passages returned, and a paraphrase the vector half ranks first is not outvoted, each with the two earlier rules run on the same fixture as a control; nothing typed is read as search syntax. A message is read through two bounds, its first 10,000 characters and nothing in an unbroken run of 100 or more, and none of the messages tried raises: megabytes of text, and every length from 1 to 1,100 of a letter that grows when lower-cased, alone and after a word. A passage the server indexed wrongly does not stop the function answering. Over 16,000 seeded message-and-passage pairs the function admits exactly the passages that a count made outside it says hold more than half; a message with no meaningful word matches nothing. Upgrading applies the second file, and running the first again goes back. A role that may not bypass row-level security reads and writes nothing, and one that may does both; the constraints the stores lean on hold. The same fixtures run through the memory store, and each difference is asserted, down to its stop-word list against Postgres's own; the memory store counts an unbroken run in characters, not in the units of a JavaScript string. On the shipped example content, three full-sentence questions and one with a phone number in it each get one keyword vote, for the passage that answers; the boiler question's vote goes to the water-heater passage, and with the vector ranks set by hand that lifts it over the boiler passage, where the 0.1.x function on the same fixture puts the boiler passage first. With the word-hash stand-in for embeddings and nothing set by hand, that question brings back the water-heater passage first and not the boiler passage, in both stores. |
| `test/new-agent.test.ts` | A config file and a content folder that the test writes become an agent that answers from that folder, as that business, on the path its config names; the shipped example stands up the same way beside it and neither sees the other's content; a config can bring its own model. Offline, the event log names the stand-in that answered, never a Claude model, and the no-config demo's reply is the one the quick start shows. |
| `test/from-env.test.ts` | The production path, with made-up values in the environment: `defineAgentFromEnv` lets the host's `AGENT_MODEL` and `AGENT_ALLOWED_ORIGINS` win when they are set and the config's stand when they are not; a blank `AGENT_MODEL` counts as unset; with no allowlist anywhere a browser is refused; a runtime part the config supplies is the one used, whatever else has to be built, and a key is asked for only when the environment has to build its part; a missing variable is named. The store's deadline is the one asked for: through `fromEnv`, through `defineAgentFromEnv`, and in the ingest script, which gives it 60 seconds. A dry-run ingest needs no environment at all. |
| `test/supabase-store.test.ts` | Against the recording stub: `upsertDocument` writes a `pending:` marker, replaces the chunks, then writes the real content hash; a failed chunk insert throws and the real hash is never written; ingest runs a document again while its stored hash is the marker; `appendMessage` throws when its `last_active_at` update fails; an event with no conversation is sent as NULL; a read that cannot connect is tried once, and a request that never answers is dropped at the deadline; the network kill switch is back afterwards. |
| `test/lockfile.test.ts` | `vite` is a direct devDependency, nothing is recorded as peer-only in the lockfile, and the native binaries for macOS, Linux and Windows are listed. This is what keeps a plain `npm install` from stripping the lockfile. Every package comes from `registry.npmjs.org` with an integrity hash, and only `esbuild` and `fsevents` are flagged as running a script at install. The declared `@supabase/supabase-js` range starts at the first release that has the two options the store sets. `package.json` and both root entries of the lockfile carry the version the package exports as `VERSION`. |

### What the offline suite does not cover

The offline suite can't reach these four. It tests three of them against a stand-in and
only typechecks the fourth, and a stand-in is not the service: each needs one live check
before a first real deployment.

1. **The Anthropic API.** One live call through `AnthropicModelClient.stream` that ends in
   a tool call, and one conversation longer than `historyWindow`. The suite proves the
   client against the stream Anthropic documents. Only a call proves the service still
   sends it, and accepts the model id and the tool schemas this package generates.
2. **Voyage.** The real response shape and a 1024-dimension vector. This is the one the
   suite only typechecks. Then put a set of real questions with known answers through
   `retrieve()` and read what comes back: nothing here measures retrieval quality with
   Voyage embeddings.
3. **Supabase's API in front of the SQL.** The stores reach Postgres through PostgREST. The
   suite runs the SQL and checks what supabase-js sends, and joins the two for a single
   call. Run one ingest and one retrieval against a real project: the `[…]` vector literal
   on insert and as the RPC argument, the upsert, and a failed chunk insert leaving the
   document to be ingested again. That project's Postgres build is its own, too. The
   keyword half's two bounds on a message have been run on the builds named under
   "Applying the migrations", and a project's build need not be one of them, so send one
   message holding an unbroken word of 700 `Ⱥ` through the function and see that it comes
   back without an error.
4. **Row-level security as deployed.** The suite shows that a role which may not bypass
   it reads nothing. After applying the migrations, confirm with the project's own anon key
   that no `agent_` table can be read.

## Using it for a real agent

Six steps, and none of them is "edit the core":

1. Copy [`examples/client-agent.example.ts`](examples/client-agent.example.ts) to
   `agent.config.ts` and fill in the business, persona, tools and allowed origins. Repoint
   its two imports: `'../src/index.js'` becomes `'./src/index.js'` when the copy sits at
   the package root. The file holds everything but the runtime, so you can try it before
   any key exists: `npm run demo -- --config agent.config.ts --content ./knowledge`.
2. Copy `.env.example` to `.env` **on the deployment host** and fill it in. Secrets never
   go in the repository.
3. Apply the migrations to the Supabase project the agent will use (see below).
4. Put the business's content (`.md` / `.txt`) in a folder and ingest it:

   ```bash
   npm run ingest -- --dir ./knowledge            # embeds and upserts (needs env)
   npm run ingest -- --dir ./knowledge --dry-run  # chunk counts only
   ```

   Ingest is idempotent. A content hash is checked before embedding, so unchanged files
   cost nothing; a changed file replaces all of that document's chunks.
5. Mount it behind your platform's adapter:
   `createAgentHandler(defineAgentFromEnv(config))`. That one call builds the production
   runtime from the environment and applies the host's two overrides (the table below).
   [`examples/node-server.ts`](examples/node-server.ts) does that for Node when you pass
   it `--config` with the env set.
6. Point the chat widget at the agent's base URL
   ([`docs/http-contract.md`](docs/http-contract.md)).

### Environment variables

Server-side only. Never expose them to the browser. Env is read only inside `fromEnv()`,
when it is called, so importing the package with nothing set never throws.
`defineAgentFromEnv(config)` calls it and applies the two overrides in this table; call
`fromEnv()` yourself and it only hands them back.

A key marked required is asked for only when the environment has to build that part of
the runtime. A config that brings its own `modelClient` needs no `ANTHROPIC_API_KEY`, its
own `embeddings` no `VOYAGE_API_KEY`, and all three stores neither Supabase variable.
`fromEnv()` on its own needs all four.

Five reads aren't this package's. Even with the key passed in, the Anthropic SDK looks at
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_LOG`
and `ANTHROPIC_WEBHOOK_SIGNING_KEY` when that client is built. A host that sets one of the
first three is changing where the agent's model calls go, or what they carry.

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Anthropic Messages API. |
| `AGENT_MODEL` | no | Model override. When set it wins over the config's `model`; with neither, `claude-haiku-4-5`. |
| `VOYAGE_API_KEY` | yes | Voyage embeddings for RAG. |
| `SUPABASE_URL` | yes | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service-role key. Full access, server-side only. |
| `AGENT_ALLOWED_ORIGINS` | no | Comma-separated CORS allowlist. When set it replaces the config's `http.allowedOrigins`; unset, the config's list stands. With no list in either, every browser origin is refused. |

### Applying the migrations

[`supabase/migrations/`](supabase/migrations/) holds two files, and they are files only.
Nothing in this repository applies them. Apply every file yourself, in name order, to the
project the agent will use, with the Supabase CLI or dashboard.

1. `20260705000000_agent_core.sql`: the tables, the indexes, row-level security and the
   first retrieval function. It is frozen as published. A test holds its hash, and a
   change is always a new file.
2. `20261007000000_agent_core_keyword_majority.sql`: one statement, which replaces the
   retrieval function with the one described above (0.2.0). No table, column or index
   changes, and nothing has to be ingested again.

The agent connects with the service-role key, so row-level security is enabled on every
table with **no policies**: there is no anonymous or signed-in access path. The embedding
dimension (1024) must match `EMBEDDING_DIM` in `src/rag/embed.ts`.

**Upgrading from 0.1.x.** Apply the second file. What changes: a full-sentence question
can now get a keyword match, because a passage needs more than half of the message's
meaningful words where 0.1.x needed every one. What stops working: in 0.1.x a quoted
phrase had to appear as a phrase, a leading minus excluded a word, and `or` meant
"either". None of that is syntax now. A visitor could type those; if you call the
function directly you may have relied on them.

The second file also bounds what the keyword half reads of a message, twice: the first
10,000 characters, and nothing in an unbroken run of 100 characters or more. A run is
broken by a space, a tab, a line feed or a carriage return. Inside those bounds no word
comes within reach of Postgres's limit on the length of a word (2,046 bytes, counted
after the word is lower-cased), so there is nothing for a message to raise on. That
sentence is about the length of a word and nothing else: a message can still fail a turn
for another reason, and "Operating it" has one (a NUL character or an unpaired
surrogate). It is the reasoning, and it has been run. In the suite: on PostgreSQL 18.3,
the suite's own database. Outside the suite, on throwaway servers: on PostgreSQL 15.14,
15.19, 16.10, 16.15, 17.6, 17.11 and 18.6 (Debian builds with pgvector). On each of the
seven, the suite's seventeen boundary messages gave the answers they give in the suite,
and 30,000 more built to press on that limit (one unbroken run of up to 3,000 letters,
alone or after a word) went through the function without one raising. On any other build
it rests on the reasoning. The vector half still gets the whole message.

**A known fault in 0.1.x, which the second file fixes.** The 0.1.x keyword half has
neither bound, and two kinds of message make it raise. A raise is one failed turn for
the visitor who sent it. Retrieval runs after the conversation is opened and the message
stored, so those rows and their events are written. Then the turn ends with an `error`
frame and an `error` event: no reply is stored and the model is not called.

- A message of megabytes: `value is too big in tsquery`, seen in the suite's database.
  The HTTP layer's limit of 2,000 keeps a visitor from it.
- A message carrying one unbroken word of 683 to 1,023 of certain letters (`Ⱥ` U+023A,
  `Ⱦ` U+023E): `word is too long in tsquery`. This one is inside the HTTP layer's limit.
  It raises on PostgreSQL 15.14, 16.10 and 17.6, and in the suite's database (18.3). It
  does not on 15.19, 16.15, 17.11 or 18.6. Outside the suite that is two builds of each
  of 15, 16 and 17, where the earlier one raises and the later one does not, and one
  build of 18. Builds between those were not run.

There is no patch for 0.1.x: the fix is the second migration.

**Going back.** Run the first file again. Its function is `create or replace` and the
file is written to run twice, so that restores the 0.1.x keyword half and touches no row.
It also restores the fault above: after going back, those two kinds of message can make
the keyword half raise again.

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
- The keyword half of retrieval votes only for a passage holding more than half of the
  message's meaningful words (since 0.2.0). What that means in practice:
  - It is silent when no passage does, and the vector half decides alone. On a long,
    chatty message that is the usual case.
  - Exactly half is not enough. The count follows Postgres's own splitting: "AR-4420" is
    two words, "call-out" is two, and "won't" leaves `won`. Each one raises the bar.
  - Every word counts the same, so a passage that shares a question's common words can
    take the vote from the passage that answers it. On the example content the boiler
    question does exactly that. The boiler passage then never outranks the water-heater
    passage, whatever the vector half does: the water-heater passage is in both lists,
    and the boiler passage is in one at most and sometimes in none. Whether the boiler
    passage is among the four the model reads depends entirely on the vector half. In
    the test that pins this ([`test/postgres.test.ts`](test/postgres.test.ts)) the vector
    ranks are set by hand with the boiler passage first, and there both are in the four;
    the same test runs the 0.1.x function on that fixture, where the boiler passage is
    first. With the offline word-hash stand-in, which does not stem "boilers" to
    "boiler", it is not in the four, and the memory store does not return it at all; the
    same file pins that as well. With Voyage embeddings it has not been measured.
  - Nothing a visitor types is search syntax. That changed from 0.1.x, where a quoted
    phrase had to appear as a phrase, a leading minus excluded a word and `or` meant
    "either".
  - The keyword half reads the first 10,000 characters of a message and skips any
    unbroken run of 100 or more. A pasted address, key or blob of that length is
    skipped, not searched. The vector half gets all of it. "Applying the migrations"
    says why, and names the servers this has been run on.
  - A stored passage is not bounded. The first migration indexes a chunk as it is, and
    Postgres builds differ on a chunk holding one unbroken word of 683 of `Ⱥ`. The
    suite's database keeps a copy of the word in the chunk's index entry, and so do
    PostgreSQL 15.14, 16.10 and 17.6; 15.19, 16.15, 17.11 and 18.6 drop the word. Either
    way, a message sharing a word with that chunk is answered: in the suite, and on all
    seven of those servers, run outside it. That is all that was run about such a chunk.
    No real document holds such a word, and a visitor can't put one in.
  - What is measured. In the suite, on one server (PostgreSQL 18.3, in the test
    process): the rule itself. Outside the suite: the two bounds, the stored-passage
    case and the order of documents, on seven throwaway PostgreSQL servers, builds 15.14
    to 18.6; and the function through PostgREST on a Supabase stack running 17.11, with
    both files applied by the Supabase CLI, 20 of 20 checks. What is not: a Supabase
    project's own build; retrieval quality with Voyage embeddings, with a Claude answer,
    on a real business's content, or on real customers' phrasing. A first deployment
    owes those checks (see the live checks above).
- A message holding a NUL character or an unpaired surrogate fails the turn, and the
  handler does not refuse it first. Run outside the suite, through the HTTP handler on a
  Supabase stack (PostgreSQL 17.11): `{"message":"a\u0000b"}` and
  `{"message":"a\ud800b"}` each get HTTP 200 and two frames, `meta` then `error`
  (`server_error`). The conversation is opened, storing the message is what fails, and
  the model is not called. An ordinary message there gets `meta`, `text`, `done`. This
  is the store, not retrieval, and the store's code has not changed since 0.1.x. The
  in-memory stores accept both bodies and answer `meta`, `text`, `done`, so the offline
  suite can't show it.
- A reply can come back empty. If the model runs out of `maxTokens` part-way through a
  tool call, the call is dropped, rightly, and the turn ends with `done` and no text. The
  `model_call` event for that turn says `stopReason: "max_tokens"`. If those show up,
  raise `maxTokens`.
- A store that is down fails fast. Each request to Supabase is tried once and given two
  seconds, so the visitor gets an `error` frame while they're still there.
  `defineAgentFromEnv(config, { storeTimeoutMs })` changes the deadline; the ingest script
  uses 60 seconds, because one request carries every chunk of a document.
- `GET {base}/health` can be read from any origin. It is public and holds no secret. The
  chat endpoint keeps the allowlist.

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
examples/            a Node server, a config loader, the offline stand-ins, and one
                     example agent: a config file and its content folder
scripts/             the content ingest CLI and the folder reader it shares
supabase/migrations/ the schema, then the retrieval function as it stands
docs/                the design spec and the HTTP/SSE contract
.github/workflows/   the CI gate: the quick start's commands on three systems
```

## License

MIT © [DevDudeJeremy LLC](https://devdudejeremy.com) — see [LICENSE](LICENSE).

## Want something like this?

I build AI agents and integrations like this for clients —
**[devdudejeremy.com](https://devdudejeremy.com)**.
