import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import { logWarn } from "../logger.js";
import { defaultRuntime } from "../runtime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { resolveGatewayRequestContext } from "./http-utils.js";

export const AGENT_HTTP_PATH = "/v1/agent";

type AgentHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type AgentHttpRequest = {
  message?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
  thinking?: unknown;
  timeout?: unknown;
  extraSystemPrompt?: unknown;
};

function coerceRequest(val: unknown): AgentHttpRequest {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as AgentHttpRequest;
}

function resolveAgentResponseText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "";
  }
  return payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Handle POST /v1/agent requests.
 *
 * Request body:
 *   { message, agentId?, sessionKey?, thinking?, timeout?, extraSystemPrompt? }
 *
 * - `timeout` (number, seconds) is forwarded as a string to the agent command.
 *
 * Response body:
 *   { runId, status: "ok", result: { text } }
 *
 * Returns false if the path does not match, true if it was handled.
 */
export async function handleAgentHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AgentHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: AGENT_HTTP_PATH,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? 1024 * 1024,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  const payload = coerceRequest(handled.body);
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!message) {
    sendJson(res, 400, {
      error: {
        message: 'Missing required field: "message".',
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const agentIdOverride =
    typeof payload.agentId === "string" ? payload.agentId.trim() || undefined : undefined;
  const sessionKeyOverride =
    typeof payload.sessionKey === "string" ? payload.sessionKey.trim() || undefined : undefined;
  const thinking =
    typeof payload.thinking === "string" ? payload.thinking.trim() || undefined : undefined;
  const timeout = typeof payload.timeout === "number" ? String(payload.timeout) : undefined;
  const extraSystemPrompt =
    typeof payload.extraSystemPrompt === "string"
      ? payload.extraSystemPrompt.trim() || undefined
      : undefined;

  const { agentId, sessionKey, messageChannel } = resolveGatewayRequestContext({
    req,
    model: agentIdOverride ? `openclaw:${agentIdOverride}` : undefined,
    sessionPrefix: "agent-http",
    defaultMessageChannel: "webchat",
    useMessageChannelHeader: true,
  });

  const runId = `agent_${randomUUID()}`;
  const deps = createDefaultDeps();

  try {
    const result = await agentCommandFromIngress(
      {
        message,
        agentId,
        sessionKey: sessionKeyOverride ?? sessionKey,
        thinking,
        timeout,
        extraSystemPrompt,
        deliver: false,
        messageChannel,
        bestEffortDeliver: false,
        runId,
        // HTTP API callers are authenticated operator clients for this gateway context.
        senderIsOwner: true,
      },
      defaultRuntime,
      deps,
    );

    const text = resolveAgentResponseText(result);

    sendJson(res, 200, {
      runId,
      status: "ok",
      result: { text },
    });
  } catch (err) {
    logWarn(`agent-http: agent run failed: ${String(err)}`);
    sendJson(res, 500, {
      error: { message: "internal error", type: "api_error" },
    });
  }

  return true;
}
