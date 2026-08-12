// Proves that an explicit agents.defaults.compaction.model no longer
// short-circuits model fallback when fallback candidates are configured.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  resolveModelMock,
  sessionCompactImpl,
} from "./compact.hooks.harness.js";

const TEST_SESSION_ID = "session-1";
const TEST_SESSION_KEY = "agent:main:session-1";

let compactEmbeddedAgentSessionDirect: typeof import("./compact.js").compactEmbeddedAgentSessionDirect;

beforeAll(async () => {
  const loaded = await loadCompactHooksHarness();
  compactEmbeddedAgentSessionDirect = loaded.compactEmbeddedAgentSessionDirect;
});

beforeEach(() => {
  resetCompactHooksHarnessMocks();
});

describe("compactEmbeddedAgentSessionDirect fallback gate", () => {
  it("attempts a fallback candidate when the primary compaction attempt fails, even with an explicit compaction.model", async () => {
    resolveModelMock.mockImplementation((provider = "openai", modelId = "fake") => ({
      model: { provider, api: "responses", id: modelId, input: [] },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    }));
    sessionCompactImpl
      .mockRejectedValueOnce(Object.assign(new Error("400 invalid request body"), { status: 400 }))
      .mockResolvedValueOnce({
        summary: "fallback summary",
        firstKeptEntryId: "entry-fallback",
        tokensBefore: 120,
        details: { ok: true },
      });

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-primary",
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-primary",
              fallbacks: ["anthropic/claude-fallback"],
            },
            compaction: {
              model: "azure/compact-primary",
            },
          },
        },
      } as never,
    });

    // A fallback candidate is attempted (second compact() invocation) instead of
    // the explicit compaction.model short-circuiting straight to a single
    // direct attempt and surfacing the primary failure.
    expect(sessionCompactImpl).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.result?.summary).toBe("fallback summary");
  });

  it("rotates the SECOND fallback attempt to the fallback model instead of collapsing back to the explicit compaction.model", async () => {
    resolveModelMock.mockImplementation((provider = "openai", modelId = "fake") => ({
      model: { provider, api: "responses", id: modelId, input: [] },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    }));
    sessionCompactImpl
      .mockRejectedValueOnce(Object.assign(new Error("400 invalid request body"), { status: 400 }))
      .mockResolvedValueOnce({
        summary: "fallback summary",
        firstKeptEntryId: "entry-fallback",
        tokensBefore: 120,
        details: { ok: true },
      });

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-primary",
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-primary",
              fallbacks: ["anthropic/claude-fallback"],
            },
            compaction: {
              model: "anthropic/claude-haiku-4-5",
            },
          },
        },
      } as never,
    });

    expect(result.ok).toBe(true);
    expect(sessionCompactImpl).toHaveBeenCalledTimes(2);
    // resolveModelAsync (mocked via resolveModelMock) receives the
    // runtime-resolved provider/modelId for each compaction attempt. The
    // first attempt must honor the explicit compaction.model override; the
    // second (fallback) attempt must rotate to model.fallbacks instead of
    // collapsing back to the explicit override.
    expect(resolveModelMock.mock.calls[0]?.slice(0, 2)).toEqual(["anthropic", "claude-haiku-4-5"]);
    expect(resolveModelMock.mock.calls[1]?.slice(0, 2)).toEqual(["anthropic", "claude-fallback"]);
  });
});
