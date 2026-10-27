import { beforeEach, expect, it, vi } from "vitest";
import { readClaudeCliUsageCredential } from "./cli-usage-credentials.js";

const io = vi.hoisted(() => ({ execFile: vi.fn(), readFile: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: io.execFile,
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  readFile: io.readFile,
}));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, default: { ...actual, userInfo: () => ({ username: "fixture-user" }) } };
});
const record = (accessToken: string, expiresAt = Date.now() + 60_000) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken,
      expiresAt,
      refreshToken: "never-return-or-refresh",
      subscriptionType: "max",
      rateLimitTier: "default_max_20x",
    },
  });
beforeEach(() => {
  io.readFile.mockReset();
  io.execFile.mockReset();
});

it("reads fresh file access only, honoring the native config root", async () => {
  io.readFile.mockResolvedValue(record("synthetic-file-access"));
  expect(
    await readClaudeCliUsageCredential({
      platform: "linux",
      env: { CLAUDE_CONFIG_DIR: "/fixture/claude" },
    }),
  ).toEqual({
    token: "synthetic-file-access",
    subscriptionType: "max",
    rateLimitTier: "default_max_20x",
  });
  expect(io.readFile).toHaveBeenCalledWith("/fixture/claude/.credentials.json", "utf8");
  expect(io.execFile).not.toHaveBeenCalled();
});

it.each([record("expired", Date.now() - 1), "{}", "not json"])(
  "refuses expired or invalid material without attempting refresh",
  async (raw) => {
    io.readFile.mockResolvedValue(raw);
    expect(
      await readClaudeCliUsageCredential({ platform: "linux", env: { HOME: "/fixture" } }),
    ).toBeUndefined();
    expect(io.execFile).not.toHaveBeenCalled();
  },
);

it("prefers the current login user's fresh Keychain entry over an arbitrary duplicate", async () => {
  io.execFile.mockImplementation((_file, _args, _options, callback) => {
    callback(null, record("synthetic-scoped-access"));
  });
  expect(await readClaudeCliUsageCredential({ platform: "darwin", env: {} })).toMatchObject({
    token: "synthetic-scoped-access",
  });
  expect(io.execFile).toHaveBeenCalledTimes(1);
  expect(io.execFile.mock.calls[0]?.[1]).toEqual([
    "find-generic-password",
    "-s",
    "Claude Code-credentials",
    "-a",
    "fixture-user",
    "-w",
  ]);
  expect(io.readFile).not.toHaveBeenCalled();
});

it("uses the fresh unscoped Keychain entry when the scoped duplicate is expired", async () => {
  io.execFile.mockImplementation((_file, args, _options, callback) => {
    callback(
      null,
      record(
        args.includes("-a") ? "expired-scoped" : "synthetic-fresh-access",
        args.includes("-a") ? Date.now() - 1 : Date.now() + 60_000,
      ),
    );
  });
  expect(await readClaudeCliUsageCredential({ platform: "darwin", env: {} })).toMatchObject({
    token: "synthetic-fresh-access",
  });
  expect(io.execFile).toHaveBeenCalledTimes(2);
});

it("does no native reads after the usage deadline expires", async () => {
  const controller = new AbortController();
  controller.abort(new Error("usage deadline"));
  await expect(readClaudeCliUsageCredential({ signal: controller.signal })).rejects.toThrow(
    "usage deadline",
  );
  expect(io.execFile).not.toHaveBeenCalled();
  expect(io.readFile).not.toHaveBeenCalled();
});
