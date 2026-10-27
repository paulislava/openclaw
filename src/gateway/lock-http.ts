// Gateway HTTP lock handler.
// Proxies GET/POST /api/lock (over localhost) to the assistant Flask lock server.
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeGatewayHttpRequestOrReply } from "./http-auth-utils.js";
import { finishGatewayHttpAuthorityError } from "./http-request-authority.js";

const MAX_BODY_BYTES = 4096;

function flaskBase(): string {
  return process.env.ASSISTANT_LOCK_BASE || "http://127.0.0.1:8879";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
}

async function callFlask(
  method: "GET" | "POST",
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const token = process.env.ASSISTANT_LOCK_TOKEN || "";
  const res = await fetch(`${flaskBase()}/api/lock`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  let json: unknown = null;
  try {
    json = JSON.parse(await res.text()) as unknown;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

export async function handleLockHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: Omit<Parameters<typeof authorizeGatewayHttpRequestOrReply>[0], "req" | "res">,
): Promise<boolean> {
  const requestAuth = await authorizeGatewayHttpRequestOrReply({ req, res, ...opts });
  if (!requestAuth) return true; // 401 уже записан

  const method = (req.method || "GET").toUpperCase();
  try {
    if (method === "GET") {
      requestAuth.assertCurrent();
      const out = await callFlask("GET");
      requestAuth.assertCurrent();
      sendJson(res, out.status, out.json ?? {});
      return true;
    }
    if (method === "POST") {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        requestAuth.assertCurrent();
        sendJson(res, 400, { error: "bad body" });
        return true;
      }
      requestAuth.assertCurrent();
      const action = (parsed as { action?: unknown })?.action;
      if (action !== "on" && action !== "off") {
        sendJson(res, 400, { error: "action must be on|off" });
        return true;
      }
      const out = await callFlask("POST", { action });
      requestAuth.assertCurrent();
      sendJson(res, out.status, out.json ?? {});
      return true;
    }
    requestAuth.assertCurrent();
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  } catch (error) {
    if (finishGatewayHttpAuthorityError(res, error)) return true;
    requestAuth.assertCurrent();
    sendJson(res, 502, { error: "lock backend unreachable" });
    return true;
  }
}

export async function handleLockEventsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: Omit<Parameters<typeof authorizeGatewayHttpRequestOrReply>[0], "req" | "res">,
): Promise<boolean> {
  const requestAuth = await authorizeGatewayHttpRequestOrReply({ req, res, ...opts });
  if (!requestAuth) return true; // 401 уже записан

  const token = process.env.ASSISTANT_LOCK_TOKEN || "";
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  let upstream: Response;
  try {
    requestAuth.assertCurrent();
    upstream = await fetch(`${flaskBase()}/api/lock/events`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
  } catch (error) {
    if (finishGatewayHttpAuthorityError(res, error)) return true;
    requestAuth.assertCurrent();
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "lock events backend unreachable" }));
    }
    return true;
  }
  requestAuth.assertCurrent();
  if (!upstream.ok || !upstream.body) {
    res.writeHead(upstream.status || 502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "lock events upstream error" }));
    return true;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        requestAuth.assertCurrent();
        res.write(Buffer.from(value));
      }
    }
  } catch (error) {
    if (finishGatewayHttpAuthorityError(res, error)) res.destroy();
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    res.end();
  }
  return true;
}
