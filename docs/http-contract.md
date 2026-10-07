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
No auth. For uptime checks.

**`POST {base}/chat`** — `Content-Type: application/json`:

```json
{
  "message": "string, required, 1..2000 chars",
  "conversationId": "uuid string, optional — omit to start a new conversation",
  "page": "string, optional — path the visitor is on",
  "visitor": { "name": "optional", "email": "optional" }
}
```

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
oversized `message`, malformed JSON) · `403 origin_forbidden` (Origin not in allowlist) ·
`404` unknown path under the base · `405` wrong method · `429 rate_limited` (includes
`Retry-After` header; default limit 20 req/min/IP) · `500 server_error`. `OPTIONS`
preflight → `204` with CORS headers when the Origin is allowed.

## 5. Server-side env (agent host — never exposed to the browser)

`ANTHROPIC_API_KEY` · `AGENT_MODEL` (optional model override) · `VOYAGE_API_KEY`
(embeddings) · `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` · `AGENT_ALLOWED_ORIGINS`
(comma-separated allowlist the CORS check enforces). These live on the agent deployment,
never in the website's own environment, never in the browser.
