# HTTP/SSE contract — agent-core ⇄ chat widget

**protocolVersion 1 · frozen**

This is the whole surface a chat widget (or any other client) sees. agent-core ships no UI;
a front end talks to it **only** through this contract. Treat every identifier here as
public API: event names, JSON shapes, status codes and headers do not change without a
`protocolVersion` bump. `test/handler.test.ts` asserts the status codes, response headers
and frame order described here.

## 1. Base URL

The widget is configured with the agent API **base URL**, e.g.
`https://agent.example.com/agent`. It is only a URL, so it is safe to expose to the
browser. The server's base path defaults to `/agent` (configurable); the configured URL
always points at the **full base**, and the widget appends the paths below.

## 2. Endpoints

**`GET {base}/health`** → `200` `{"ok":true,"version":"<pkg version>","protocolVersion":1}`.
No auth. For uptime checks. It carries `Access-Control-Allow-Origin: *` whatever the
allowlist says, so a page on any origin can read it: it is public and holds no secret.

**`POST {base}/chat`** — `Content-Type: application/json`:

```json
{
  "message": "string, required, 1..2000 chars",
  "conversationId": "uuid string, optional — omit to start a new conversation",
  "page": "string, optional — path the visitor is on",
  "visitor": { "name": "optional", "email": "optional" }
}
```

None of the body's four strings (`message`, `page`, `visitor.name`, `visitor.email`) may
hold U+0000, or a surrogate that is not half of a well-formed pair. Postgres stores
neither as text, so a body holding one is refused with `400 bad_request` (§4) before a
conversation is loaded or created, whatever store is behind the handler. A well-formed
pair, which is any character above U+FFFF, is text, and so is every other character.

Success → `200` with `Content-Type: text/event-stream`, `Cache-Control: no-store`,
`X-Accel-Buffering: no`.

## 3. SSE events (protocolVersion 1)

Each frame is `event: <name>` + `data: <single-line JSON>`. Keepalive comment lines
(`: ping`) may appear at any time — EventSource-style parsers ignore them natively.
**Order guarantee:** `meta` first → any mix of `text` / `tool` / `handoff` → exactly one
terminal `done` **or** `error`, then the stream closes. One exception: if the turn fails
before a conversation has been loaded or created (the store is down, say), there is no
conversation id to announce, and the stream is `200` with `error` as its only frame.

| event     | data                                                                 | widget behavior |
| --------- | -------------------------------------------------------------------- | --------------- |
| `meta`    | `{"protocolVersion":1,"conversationId":"<uuid>"}`                    | First frame, except as noted above. Persist `conversationId` (sessionStorage) and resend it on every subsequent message. |
| `text`    | `{"delta":"..."}`                                                    | Append to the current assistant bubble. |
| `tool`    | `{"name":"<tool>","status":"started"\|"completed"\|"failed"\|"pending_approval"}` | Optional activity indicator. Never contains tool inputs. `pending_approval` → show "a team member will confirm". |
| `handoff` | `{"reason":"..."}`                                                   | Show the handed-off state ("a human will follow up"). |
| `done`    | `{"finishReason":"end_turn"\|"max_turns"}`                           | Terminal. |
| `error`   | `{"code":"...","message":"..."}`                                     | Terminal; show a friendly retry state. |

## 4. Non-stream errors

JSON body `{"error":{"code":"...","message":"..."}}` with: `400 bad_request` (missing or
oversized `message`, malformed JSON, a string holding U+0000 or an unpaired surrogate) ·
`403 origin_forbidden` (Origin not in allowlist) ·
`404` unknown path under the base · `405` wrong method · `429 rate_limited` (includes
`Retry-After` header; default limit 20 req/min/IP) · `500 server_error`. `OPTIONS`
preflight → `204` with CORS headers when the Origin is allowed.

The last of those 400 cases was added in version 0.3.0, within protocolVersion 1: no
event name, JSON shape, status code or header is new. What changed is the answer to those
bodies. Before 0.3.0 the handler accepted them and the answer depended on the store. Some
of them were answered, with `meta`, `text`, `done`: every one of them on the in-memory
stores, and on the Supabase stores a `page` or `visitor` field like that when it was sent
into a conversation that already existed. Those are a `400` now. The rest already failed
on the Supabase stores, as a `200` stream ending in `error`. The README's operating notes
list each case.

## 5. Server-side env (agent host — never exposed to the browser)

`ANTHROPIC_API_KEY` · `AGENT_MODEL` (optional model override) · `VOYAGE_API_KEY`
(embeddings) · `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` · `AGENT_ALLOWED_ORIGINS`
(comma-separated allowlist the CORS check enforces). These live on the agent deployment,
never in the website's own environment, never in the browser.
