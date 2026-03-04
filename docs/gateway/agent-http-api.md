---
summary: "Call any configured agent directly via a simple HTTP POST endpoint"
read_when:
  - Integrating external tools or scripts that need to call an OpenClaw agent over HTTP
  - Building automations without writing a WebSocket client
title: "Agent HTTP API"
---

# Agent HTTP API

OpenClaw's Gateway can serve a lightweight HTTP endpoint for invoking agents directly.

- `POST /v1/agent`
- Same port as the Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/v1/agent`

This endpoint runs the exact same agent codepath as `openclaw agent` and the Gateway WebSocket `agent` RPC, so all routing, permissions, and configuration apply as usual.

This endpoint is **disabled by default**. Enable it in config first.

## Authentication

Uses the Gateway auth configuration. Send a bearer token:

- `Authorization: Bearer <token>`

Notes:

- When `gateway.auth.mode="token"`, use `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`).
- When `gateway.auth.mode="password"`, use `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`).
- If `gateway.auth.rateLimit` is configured and too many auth failures occur, the endpoint returns `429` with `Retry-After`.

## Security boundary (important)

Treat this endpoint as a **full operator-access** surface for the gateway instance.

- A valid Gateway token/password grants full operator-level access to the agent.
- Requests run through the same control-plane agent path as trusted operator actions.
- If the configured agent policy allows sensitive tools, this endpoint can use them.
- Keep this endpoint on loopback/tailnet/private ingress only; do not expose it to the public internet.

See [Security](/gateway/security) and [Remote access](/gateway/remote).

## Enabling the endpoint

Set `gateway.http.endpoints.agent.enabled` to `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        agent: { enabled: true },
      },
    },
  },
}
```

## Disabling the endpoint

Set `gateway.http.endpoints.agent.enabled` to `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        agent: { enabled: false },
      },
    },
  },
}
```

## Request

`POST /v1/agent`

```json
{
  "message": "What is the weather like today?",
  "agentId": "main",
  "sessionKey": "my-session",
  "thinking": "low",
  "timeout": 60,
  "extraSystemPrompt": "Be concise."
}
```

### Fields

| Field               | Type   | Required | Description                                                                       |
| ------------------- | ------ | -------- | --------------------------------------------------------------------------------- |
| `message`           | string | **Yes**  | The user message to send to the agent.                                            |
| `agentId`           | string | No       | Target agent ID (default: `main`, or resolved from `x-openclaw-agent-id` header). |
| `sessionKey`        | string | No       | Session key to use. If omitted, a stateless session is created per-request.       |
| `thinking`          | string | No       | Thinking level hint: `"low"`, `"medium"`, or `"high"`.                            |
| `timeout`           | number | No       | Max seconds to wait for the agent response.                                       |
| `extraSystemPrompt` | string | No       | Extra text injected into the system prompt for this request only.                 |

### Headers

| Header                                  | Description                                                        |
| --------------------------------------- | ------------------------------------------------------------------ |
| `Authorization: Bearer <token>`         | **Required.** Gateway bearer token.                                |
| `x-openclaw-agent-id: <agentId>`        | Optional. Selects the target agent (overridden by body `agentId`). |
| `x-openclaw-session-key: <sessionKey>`  | Optional. Sets the session key (overridden by body `sessionKey`).  |
| `x-openclaw-message-channel: <channel>` | Optional. Sets the message channel context (e.g. `webchat`).       |

## Response

### Success (`200 OK`)

```json
{
  "runId": "agent_<uuid>",
  "status": "ok",
  "result": {
    "text": "The weather today is sunny with a high of 72°F."
  }
}
```

| Field         | Type   | Description                                                                |
| ------------- | ------ | -------------------------------------------------------------------------- |
| `runId`       | string | Unique identifier for this agent run.                                      |
| `status`      | `"ok"` | Indicates a successful run.                                                |
| `result.text` | string | The agent's text reply. Empty string if the agent produced no text output. |

### Error responses

| Status | Body                                                                 | Meaning                                                        |
| ------ | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| `400`  | `{ "error": { "message": "...", "type": "invalid_request_error" } }` | Missing or invalid request body (e.g. `message` not provided). |
| `401`  | `{ "error": { "message": "Unauthorized", "type": "unauthorized" } }` | Missing or invalid bearer token.                               |
| `405`  | —                                                                    | Method not allowed (only `POST` is accepted).                  |
| `429`  | `{ "error": { ... } }`                                               | Auth rate limit exceeded.                                      |
| `500`  | `{ "error": { "message": "internal error", "type": "api_error" } }`  | Unexpected server error.                                       |

## Session behavior

By default the endpoint is **stateless per request**: a new session key is generated for each call so runs do not share history.

To maintain a persistent session across multiple requests, pass a stable `sessionKey` in the request body (or `x-openclaw-session-key` header). Repeated calls with the same key share the same agent session and conversation history.

## Choosing an agent

Priority order for agent selection:

1. `agentId` field in the request body.
2. `x-openclaw-agent-id` request header.
3. Falls back to the default agent (`main`).

## Example: curl

```bash
curl -s -X POST http://localhost:18789/v1/agent \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Summarize the latest news",
    "agentId": "main",
    "thinking": "low"
  }'
```

## Example: Python

```python
import requests

response = requests.post(
    "http://localhost:18789/v1/agent",
    headers={"Authorization": "Bearer YOUR_TOKEN"},
    json={
        "message": "What is 2 + 2?",
        "agentId": "main",
    },
)
data = response.json()
print(data["result"]["text"])
```

## Example: Node.js

```js
const res = await fetch("http://localhost:18789/v1/agent", {
  method: "POST",
  headers: {
    Authorization: "Bearer YOUR_TOKEN",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ message: "Hello, agent!" }),
});
const { result } = await res.json();
console.log(result.text);
```

## Relationship to other APIs

| API                                                  | Path                        | Notes                                                    |
| ---------------------------------------------------- | --------------------------- | -------------------------------------------------------- |
| **Agent HTTP API** (this doc)                        | `POST /v1/agent`            | Simple direct agent call; JSON in, JSON out.             |
| [OpenAI Chat Completions](/gateway/openai-http-api)  | `POST /v1/chat/completions` | OpenAI-compatible format; supports streaming SSE.        |
| [OpenResponses API](/gateway/openresponses-http-api) | `POST /v1/responses`        | OpenAI Responses API format; supports tool definitions.  |
| [Tools Invoke API](/gateway/tools-invoke-http-api)   | `POST /tools/invoke`        | Run a single tool directly; no full agent turn.          |
| [Hooks](/automation/hooks)                           | `POST /hooks/<path>`        | Event-driven webhook dispatch.                           |
| Gateway WebSocket                                    | `ws://<host>:<port>`        | Full protocol with streaming events and agent lifecycle. |
