import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompactionModel } from "../../../packages/agent-core/src/harness/compaction/compaction.test-support.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { attachCompactionAccountingRecorder } from "../embedded-agent-runner/run/compaction-accounting-bridge.js";
import { runIsolatedCompletion } from "../isolated-completion.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { compactViaClaudeCli } from "./compact-cli.js";

// mock-isolation: this boundary tests real planning and append; process isolation has its own suite.
vi.mock("../isolated-completion.js", () => ({ runIsolatedCompletion: vi.fn() }));
// mock-isolation: callers supply an already resolved model; discovery must not run in this fixture.
vi.mock("../embedded-agent-runner/model.js", () => ({ resolveModelAsync: vi.fn() }));
// mock-isolation: provider binding is already prepared by the compaction orchestrator.
vi.mock("../cli-backends.js", () => ({ resolveCliRuntimeCanonicalProvider: () => "anthropic" }));

describe("Claude CLI compaction", () => {
  const isolated = vi.mocked(runIsolatedCompletion);
  beforeEach(() => {
    isolated.mockResolvedValue({
      text: "## Goal\nKeep the plan\n\n## Next Steps\n1. Continue",
      provider: "anthropic",
      model: "claude-sonnet-5",
      owner: { kind: "cli", id: "claude-cli" },
    });
  });
  afterEach(() => vi.clearAllMocks());

  async function fixture() {
    const manager = SessionManager.inMemory("/tmp/cli-compaction");
    for (let i = 0; i < 4; i++) {
      await manager.appendMessageAsync({
        role: "user",
        content: "task " + i + " ".repeat(200),
        timestamp: i * 2 + 1,
      });
      await manager.appendMessageAsync(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "reply " + i }] }),
      );
    }
    let active = true;
    const runtimeContext: ContextEngineRuntimeContext = {};
    const recordCompaction = vi.fn();
    const recordUsage = vi.fn();
    attachCompactionAccountingRecorder(runtimeContext, {
      hostOwnsCompactionLifecycle: true,
      memoryTranscript: {
        sessionManager: manager,
        sessionTarget: {
          agentId: "main",
          sessionId: "session",
          sessionKey: "agent:main:cli",
          storePath: "/tmp/cli-compaction/agent.sqlite",
        },
        assertActive: () => {
          if (!active) {
            throw new Error("source retired");
          }
        },
      },
      recordCompaction,
      recordUsage,
    });
    return {
      manager,
      recordCompaction,
      recordUsage,
      retire: () => {
        active = false;
      },
      params: {
        sessionId: "session",
        sessionKey: "agent:main:cli",
        sessionFile: "agent:main:cli",
        workspaceDir: "/tmp/cli-compaction",
        provider: "anthropic",
        model: "claude-sonnet-5",
        runtimeModel: {
          ...createCompactionModel({ id: "claude-sonnet-5" }),
          provider: "anthropic",
        },
        config: { agents: { defaults: { compaction: { keepRecentTokens: 10 } } } },
        trigger: "manual" as const,
        contextEngineRuntimeContext: runtimeContext,
      },
    };
  }

  it("summarizes through fresh isolated CLI inference and commits the shared plan once", async () => {
    const f = await fixture();
    const result = await compactViaClaudeCli(f.params);
    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(isolated).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-5",
        agentHarnessRuntimeOverride: "claude-cli",
        outputTextPolicy: "strict-visible",
        prompt: expect.stringContaining("<conversation>"),
        systemPrompt: expect.stringContaining("summarization"),
      }),
    );
    expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
    expect(f.recordCompaction).toHaveBeenCalledTimes(1);
    expect(f.recordUsage).not.toHaveBeenCalled();
  });

  it("does not commit or retry a failed summary through HTTP", async () => {
    const f = await fixture();
    isolated.mockRejectedValue(new Error("429 quota exceeded"));
    expect(await compactViaClaudeCli(f.params)).toMatchObject({
      ok: false,
      compacted: false,
      reason: expect.stringContaining("429"),
    });
    expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
    expect(isolated).toHaveBeenCalledTimes(1);
  });

  it("rechecks the source owner after the CLI answers and refuses the append", async () => {
    const f = await fixture();
    isolated.mockImplementation(async () => {
      f.retire();
      return {
        text: "summary",
        provider: "anthropic",
        model: "claude-sonnet-5",
        owner: { kind: "cli", id: "claude-cli" },
      };
    });
    expect(await compactViaClaudeCli(f.params)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("source retired"),
    });
    expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
  });
});
