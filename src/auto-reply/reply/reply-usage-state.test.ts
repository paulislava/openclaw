import { afterEach, describe, expect, it, vi } from "vitest";

const usageMocks = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn(),
  resolveUsageProviderId: vi.fn(),
}));

const harnessMocks = vi.hoisted(() => ({
  resolveAgentHarnessPolicy: vi.fn(),
}));

const syntheticAuthMocks = vi.hoisted(() => ({
  resolveProviderSyntheticAuthWithPlugin: vi.fn(),
}));

vi.mock("../../infra/provider-usage.js", () => ({
  loadProviderUsageSummary: usageMocks.loadProviderUsageSummary,
  resolveUsageProviderId: usageMocks.resolveUsageProviderId,
}));

vi.mock("../../agents/harness/policy.js", () => ({
  resolveAgentHarnessPolicy: harnessMocks.resolveAgentHarnessPolicy,
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin,
}));

import {
  resolveReplyProviderUsageWindows,
  clearReplyUsageStateForTest,
  consumeReplyUsageState,
  recordReplyUsageState,
} from "./reply-usage-state.js";

afterEach(() => {
  vi.useRealTimers();
  clearReplyUsageStateForTest();
  usageMocks.loadProviderUsageSummary.mockReset();
  usageMocks.resolveUsageProviderId.mockReset();
  harnessMocks.resolveAgentHarnessPolicy.mockReset();
  syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin.mockReset();
});

describe("reply usage state handoff", () => {
  it("requires exact run correlation", () => {
    const snapshot = { provider: "openai", model: "gpt-5.5" };

    recordReplyUsageState("run-a", snapshot);

    expect(consumeReplyUsageState()).toBeUndefined();
    expect(consumeReplyUsageState("run-b")).toBeUndefined();
    expect(consumeReplyUsageState("run-a")).toBe(snapshot);
  });

  it("ignores snapshots without a run id", () => {
    recordReplyUsageState(undefined, { provider: "openai" });

    expect(consumeReplyUsageState()).toBeUndefined();
  });

  it("expires snapshots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    recordReplyUsageState("run-a", { provider: "openai" });

    vi.setSystemTime(5 * 60_000 + 1);

    expect(consumeReplyUsageState("run-a")).toBeUndefined();
  });
});

describe("reply provider usage windows", () => {
  it("uses Codex synthetic auth for OpenAI Codex runtime quota windows", async () => {
    usageMocks.resolveUsageProviderId.mockReturnValue("openai");
    harnessMocks.resolveAgentHarnessPolicy.mockReturnValue({ runtime: "codex" });
    usageMocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: 100,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [
            { label: "3h", usedPercent: 20, resetAt: 200 },
            { label: "Week", usedPercent: 70, resetAt: 300 },
          ],
        },
      ],
    });

    const windows = await resolveReplyProviderUsageWindows({
      config: {},
      provider: "openai",
      model: "gpt-5.5",
      authMode: "api-key",
      agentId: "main",
      sessionKey: "telegram:1",
      authProfileId: "openai:codex",
      workspaceDir: "/workspace",
    });

    expect(windows).toEqual([
      { label: "3h", usedPercent: 20, resetAt: 200 },
      { label: "Week", usedPercent: 70, resetAt: 300 },
    ]);
    expect(usageMocks.resolveUsageProviderId).toHaveBeenCalledWith("openai", {
      credentialType: "token",
    });
    expect(usageMocks.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: ["openai"],
        auth: [
          {
            provider: "openai",
            token: "codex-app-server",
            authProfileId: "openai:codex",
            hookProvider: "codex",
          },
        ],
        timeoutMs: 8000,
        skipPluginAuthWithoutCredentialSource: undefined,
      }),
    );
  });

  it("uses Codex synthetic auth when the resolved provider is codex", async () => {
    usageMocks.resolveUsageProviderId.mockReturnValue("openai");
    harnessMocks.resolveAgentHarnessPolicy.mockReturnValue(undefined);
    usageMocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: 100,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "Week", usedPercent: 50, resetAt: 300 }],
        },
      ],
    });

    const windows = await resolveReplyProviderUsageWindows({
      config: {},
      provider: "codex",
      model: "gpt-5.5",
      authMode: "api-key",
      agentId: "main",
      sessionKey: "telegram:1",
      workspaceDir: "/workspace",
    });

    expect(windows).toEqual([{ label: "Week", usedPercent: 50, resetAt: 300 }]);
    expect(usageMocks.resolveUsageProviderId).toHaveBeenCalledWith("codex", {
      credentialType: "token",
    });
    expect(usageMocks.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: [
          {
            provider: "openai",
            token: "codex-app-server",
            hookProvider: "codex",
          },
        ],
      }),
    );
  });

  it("uses Codex synthetic auth for codex provider when runtime policy is auto", async () => {
    usageMocks.resolveUsageProviderId.mockReturnValue("openai");
    harnessMocks.resolveAgentHarnessPolicy.mockReturnValue({ runtime: "auto" });
    usageMocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: 100,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "Week", usedPercent: 16, resetAt: 300 }],
        },
      ],
    });

    const windows = await resolveReplyProviderUsageWindows({
      config: {},
      provider: "codex",
      model: "gpt-5.5",
      authMode: "api-key",
      agentId: "main",
      sessionKey: "telegram:1",
      workspaceDir: "/workspace",
    });

    expect(windows).toEqual([{ label: "Week", usedPercent: 16, resetAt: 300 }]);
    expect(usageMocks.resolveUsageProviderId).toHaveBeenCalledWith("codex", {
      credentialType: "token",
    });
    expect(usageMocks.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: [
          {
            provider: "openai",
            token: "codex-app-server",
            hookProvider: "codex",
          },
        ],
      }),
    );
  });

  it("uses Claude CLI synthetic auth for Anthropic quota windows", async () => {
    usageMocks.resolveUsageProviderId.mockReturnValue("anthropic");
    harnessMocks.resolveAgentHarnessPolicy.mockReturnValue({ runtime: "claude-cli" });
    syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin.mockReturnValue({
      apiKey: "claude-cli-token",
      source: "Claude CLI native auth",
      mode: "oauth",
    });
    usageMocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: 100,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [{ label: "5h", usedPercent: 25, resetAt: 200 }],
        },
      ],
    });

    const windows = await resolveReplyProviderUsageWindows({
      config: {},
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      authMode: "oauth",
      agentId: "main",
      sessionKey: "telegram:1",
      authProfileId: "anthropic:claude-cli",
      workspaceDir: "/workspace",
    });

    expect(windows).toEqual([{ label: "5h", usedPercent: 25, resetAt: 200 }]);
    expect(syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin).toHaveBeenCalledWith({
      provider: "claude-cli",
      config: {},
      workspaceDir: "/workspace",
      env: process.env,
      context: {
        config: {},
        provider: "claude-cli",
      },
    });
    expect(usageMocks.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: ["anthropic"],
        auth: [
          {
            provider: "anthropic",
            token: "claude-cli-token",
            authProfileId: "anthropic:claude-cli",
            hookProvider: "claude-cli",
          },
        ],
        timeoutMs: 8000,
        skipPluginAuthWithoutCredentialSource: undefined,
      }),
    );
  });

  it("uses Claude CLI synthetic auth when the resolved provider is claude-cli", async () => {
    usageMocks.resolveUsageProviderId.mockReturnValue("anthropic");
    harnessMocks.resolveAgentHarnessPolicy.mockReturnValue(undefined);
    syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin.mockReturnValue({
      apiKey: "claude-cli-token",
      source: "Claude CLI native auth",
      mode: "oauth",
    });
    usageMocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: 100,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [
            { label: "5h", usedPercent: 25, resetAt: 200 },
            { label: "Week", usedPercent: 60, resetAt: 300 },
          ],
        },
      ],
    });

    const windows = await resolveReplyProviderUsageWindows({
      config: {},
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      authMode: "oauth",
      agentId: "main",
      sessionKey: "telegram:1",
      authProfileId: "anthropic:claude-cli",
      workspaceDir: "/workspace",
    });

    expect(windows).toEqual([
      { label: "5h", usedPercent: 25, resetAt: 200 },
      { label: "Week", usedPercent: 60, resetAt: 300 },
    ]);
    expect(usageMocks.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: ["anthropic"],
        auth: [
          {
            provider: "anthropic",
            token: "claude-cli-token",
            authProfileId: "anthropic:claude-cli",
            hookProvider: "claude-cli",
          },
        ],
        timeoutMs: 8000,
      }),
    );
  });

  it("uses Claude CLI synthetic auth even when request shaping reports api-key auth", async () => {
    usageMocks.resolveUsageProviderId.mockReturnValue("anthropic");
    harnessMocks.resolveAgentHarnessPolicy.mockReturnValue(undefined);
    syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin.mockReturnValue({
      apiKey: "claude-cli-token",
      source: "Claude CLI native auth",
      mode: "oauth",
    });
    usageMocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: 100,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [{ label: "Week", usedPercent: 60, resetAt: 300 }],
        },
      ],
    });

    const windows = await resolveReplyProviderUsageWindows({
      config: {},
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      authMode: "api-key",
      agentId: "main",
      sessionKey: "telegram:1",
      workspaceDir: "/workspace",
    });

    expect(windows).toEqual([{ label: "Week", usedPercent: 60, resetAt: 300 }]);
    expect(usageMocks.resolveUsageProviderId).toHaveBeenCalledWith("claude-cli", {
      credentialType: "token",
    });
    expect(usageMocks.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: [
          {
            provider: "anthropic",
            token: "claude-cli-token",
            hookProvider: "claude-cli",
          },
        ],
        timeoutMs: 8000,
      }),
    );
  });
});
