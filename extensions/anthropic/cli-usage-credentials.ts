import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type ClaudeCliUsageCredential = {
  token: string;
  expires: number;
  subscriptionType?: string;
  rateLimitTier?: string;
};

function parseCredential(raw: string, now: number): ClaudeCliUsageCredential | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    const oauth =
      isRecord(parsed) && isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : undefined;
    if (
      !oauth ||
      typeof oauth.accessToken !== "string" ||
      !oauth.accessToken.trim() ||
      typeof oauth.expiresAt !== "number" ||
      !Number.isFinite(oauth.expiresAt) ||
      oauth.expiresAt <= now
    ) {
      return undefined;
    }
    return {
      token: oauth.accessToken.trim(),
      expires: oauth.expiresAt,
      ...(typeof oauth.subscriptionType === "string"
        ? { subscriptionType: oauth.subscriptionType }
        : {}),
      ...(typeof oauth.rateLimitTier === "string" ? { rateLimitTier: oauth.rateLimitTier } : {}),
    };
  } catch {
    return undefined;
  }
}

async function readKeychain(account: string | undefined, now: number, signal?: AbortSignal) {
  const args = [
    "find-generic-password",
    "-s",
    "Claude Code-credentials",
    ...(account ? ["-a", account] : []),
    "-w",
  ];
  const raw = await new Promise<string | undefined>((resolve) => {
    execFile(
      "/usr/bin/security",
      args,
      { encoding: "utf8", timeout: 1_500, maxBuffer: 64 * 1024, signal },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
  return raw ? parseCredential(raw, now) : undefined;
}

/** Read-only usage evidence. Claude exclusively owns refresh, login, and persistence. */
export async function readClaudeCliUsageCredential(
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; signal?: AbortSignal } = {},
): Promise<Omit<ClaudeCliUsageCredential, "expires"> | undefined> {
  options.signal?.throwIfAborted();
  const env = options.env ?? process.env;
  const now = Date.now();
  let credential: ClaudeCliUsageCredential | undefined;
  if ((options.platform ?? process.platform) === "darwin") {
    let username: string | undefined;
    try {
      username = os.userInfo().username;
    } catch {
      /* The unscoped item remains available. */
    }
    credential = username ? await readKeychain(username, now, options.signal) : undefined;
    // Prefer the current user's live item over an arbitrary duplicate from a prior root run.
    credential ??= await readKeychain(undefined, now, options.signal);
  }
  options.signal?.throwIfAborted();
  if (!credential) {
    const home = env.HOME?.trim() || os.homedir();
    const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
    try {
      credential = parseCredential(
        await readFile(path.join(configDir, ".credentials.json"), "utf8"),
        now,
      );
    } catch {
      /* Missing or unreadable native login provides no usage credential. */
    }
  }
  options.signal?.throwIfAborted();
  if (!credential || credential.expires <= Date.now()) {
    return undefined;
  }
  const { expires: _expires, ...usage } = credential;
  return usage;
}
