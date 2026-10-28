import { once } from "node:events";
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ current: true }));
vi.mock("./http-auth-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-auth-utils.js")>()),
  authorizeGatewayHttpRequestOrReply: async ({
    req,
    res,
  }: {
    req: IncomingMessage;
    res: ServerResponse;
  }) => {
    if (req.headers.authorization !== "Bearer test") {
      res.writeHead(401).end();
      return null;
    }
    return {
      assertCurrent: () => {
        if (!state.current) {
          if (!res.headersSent) res.writeHead(401).end();
          throw new Error("authority expired");
        }
      },
    };
  },
}));
vi.mock("./http-request-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-request-authority.js")>()),
  finishGatewayHttpAuthorityError: (_res: unknown, error: unknown) =>
    error instanceof Error && error.message === "authority expired",
}));

const { handleLockHttpRequest, handleLockEventsHttpRequest } = await import("./lock-http.js");
const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  vi.unstubAllEnvs();
  state.current = true;
});

describe("lock HTTP authority", () => {
  it("rejects missing token and does not post after authority expires while reading the body", async () => {
    let posts = 0;
    const backend = await listen(
      createServer((_req, res) => {
        posts++;
        res.end("{}");
      }),
    );
    vi.stubEnv("ASSISTANT_LOCK_BASE", backend);
    const gateway = await listen(
      createServer((req, res) => {
        void handleLockHttpRequest(req, res, {
          auth: { mode: "token", token: "test", allowTailscale: false },
        });
      }),
    );
    expect((await fetch(`${gateway}/api/lock`)).status).toBe(401);
    const response = new Promise<number>((resolve, reject) => {
      const req = request(
        `${gateway}/api/lock`,
        { method: "POST", headers: { authorization: "Bearer test" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.write('{"action":');
      setTimeout(() => {
        state.current = false;
        req.end('"on"}');
      }, 30);
    });
    expect(await response).toBe(401);
    expect(posts).toBe(0);
  });

  it("keeps SSE open after request end and suppresses events after authority expires", async () => {
    let upstream: import("node:http").ServerResponse | undefined;
    const backend = await listen(
      createServer((_req, res) => {
        upstream = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
      }),
    );
    vi.stubEnv("ASSISTANT_LOCK_BASE", backend);
    const gateway = await listen(
      createServer((req, res) => {
        void handleLockEventsHttpRequest(req, res, {
          auth: { mode: "token", token: "test", allowTailscale: false },
        });
      }),
    );
    const response = await fetch(`${gateway}/api/lock/events`, {
      headers: { authorization: "Bearer test" },
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
    state.current = false;
    upstream!.write("data: revoked\n\n");
    const next = await reader.read().catch(() => ({ done: true, value: undefined }));
    expect(next.done).toBe(true);
  });
});
