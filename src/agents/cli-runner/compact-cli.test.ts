// Exercises one-shot CLI compaction: prompt is built from the shared agent-core
// summarizer, the CLI runs fresh/no-tools/print, the summary text is lifted out
// of CliOutput, and it is persisted through the SAME successor-transcript /
// checkpoint machinery the embedded path uses. The CLI process is always mocked;
// no `claude` binary is spawned.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliOutput } from "../cli-output.js";
import type { CompactEmbeddedAgentSessionParams } from "../embedded-agent-runner/compact.types.js";
import type { AgentMessage } from "../runtime/index.js";
import { SessionManager } from "../sessions/index.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  compactViaClaudeCli,
  resetCompactCliTestDeps,
  setCompactCliTestDeps,
} from "./compact-cli.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

let tmpDir: string | undefined;

afterEach(async () => {
  resetCompactCliTestDeps();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    tmpDir = undefined;
  }
});

function userMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  } as unknown as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 2,
  } as unknown as AgentMessage;
}

function baseParams(
  overrides?: Partial<CompactEmbeddedAgentSessionParams>,
): CompactEmbeddedAgentSessionParams {
  return {
    sessionId: "sess-1",
    sessionKey: "agent:main",
    sessionFile: "/tmp/sess-1.jsonl",
    workspaceDir: "/tmp/ws",
    provider: "claude-cli",
    model: "claude-haiku-4-5",
    config: {} as CompactEmbeddedAgentSessionParams["config"],
    ...overrides,
  };
}

const SUMMARY = "## Goal\nShip the feature\n\n## Next Steps\n1. Wire routing";

function stubDeps(overrides?: {
  cliOutput?: Partial<CliOutput>;
  messages?: AgentMessage[];
  firstKeptEntryId?: string;
  tokensBefore?: number;
  previousSummary?: string;
}) {
  // preparedBackend is non-optional on PreparedCliRunContext (types.ts); stub it
  // so the real `prepared.preparedBackend.cleanup?.()` call site stays honestly
  // typed without a redundant optional chain masking a missing field here.
  const prepared = {
    marker: "prepared-context",
    preparedBackend: { cleanup: vi.fn(async () => {}) },
  } as unknown as PreparedCliRunContext;
  const prepareCliRunContext = vi.fn(
    async (_params: RunCliAgentParams): Promise<PreparedCliRunContext> => prepared,
  );
  const executePreparedCliRun = vi.fn(
    async (): Promise<CliOutput> => ({ text: SUMMARY, ...overrides?.cliOutput }),
  );
  const loadCompactionSummarizationInput = vi.fn(async () => ({
    messagesToSummarize: overrides?.messages ?? [
      userMessage("Build X"),
      assistantMessage("Done Y"),
    ],
    firstKeptEntryId: overrides?.firstKeptEntryId ?? "entry-42",
    tokensBefore: overrides?.tokensBefore ?? 1234,
    ...(overrides?.previousSummary ? { previousSummary: overrides.previousSummary } : {}),
  }));
  // Prompt-focused cases stub persistence so they never touch disk; the
  // persistence-focused cases below drive the real writer against a temp file.
  const persistCompactionSummary = vi.fn(
    async (persistInput: {
      params: CompactEmbeddedAgentSessionParams;
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
    }) => ({
      ok: true as const,
      compacted: true as const,
      result: {
        summary: persistInput.summary,
        firstKeptEntryId: persistInput.firstKeptEntryId,
        tokensBefore: persistInput.tokensBefore,
      },
    }),
  );
  setCompactCliTestDeps({
    prepareCliRunContext,
    executePreparedCliRun,
    loadCompactionSummarizationInput,
    persistCompactionSummary,
  });
  return {
    prepared,
    prepareCliRunContext,
    executePreparedCliRun,
    loadCompactionSummarizationInput,
    persistCompactionSummary,
  };
}

describe("compactViaClaudeCli", () => {
  it("builds the summarization prompt, runs a fresh/no-tools/print CLI call, and returns the summary", async () => {
    const { prepareCliRunContext, executePreparedCliRun } = stubDeps();

    const result = await compactViaClaudeCli(baseParams());

    expect(result).toBeDefined();
    expect(result?.ok).toBe(true);
    expect(result?.compacted).toBe(true);
    expect(result?.result?.summary).toBe(SUMMARY);
    expect(result?.result?.firstKeptEntryId).toBe("entry-42");
    expect(result?.result?.tokensBefore).toBe(1234);

    // Fresh, tool-less, side-question one-shot forced onto the claude-cli backend.
    expect(prepareCliRunContext).toHaveBeenCalledTimes(1);
    const prepareArgs = prepareCliRunContext.mock.calls[0][0];
    expect(prepareArgs.provider).toBe("claude-cli");
    expect(prepareArgs.executionMode).toBe("side-question");
    expect(prepareArgs.disableTools).toBe(true);
    // The user prompt carries the serialized conversation; the system prompt is
    // the shared summarization system prompt.
    expect(prepareArgs.prompt).toContain("<conversation>");
    expect(prepareArgs.prompt).toContain("## Goal");
    expect(prepareArgs.extraSystemPrompt).toContain("context summarization assistant");

    expect(executePreparedCliRun).toHaveBeenCalledTimes(1);
    expect(executePreparedCliRun).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "prepared-context" }),
    );
  });

  it("cleans up the prepared backend after the run", async () => {
    const cleanup = vi.fn(async () => {});
    const { prepared } = stubDeps();
    (prepared as unknown as { preparedBackend: { cleanup: () => Promise<void> } }).preparedBackend =
      { cleanup };

    await compactViaClaudeCli(baseParams());

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("returns a failure result when the CLI produces no summary text", async () => {
    stubDeps({ cliOutput: { text: "   " } });

    const result = await compactViaClaudeCli(baseParams());

    expect(result?.ok).toBe(false);
    expect(result?.compacted).toBe(false);
    expect(result?.reason).toBeTruthy();
  });

  it("returns compacted:false when there is nothing to summarize", async () => {
    stubDeps({ messages: [] });

    const result = await compactViaClaudeCli(baseParams());

    expect(result?.ok).toBe(true);
    expect(result?.compacted).toBe(false);
  });

  it("persists the CLI summary into a successor transcript and populates the result", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "compact-cli-persist-"));
    // Real transcript so persistence exercises the embedded successor-transcript
    // writer end to end (append compaction entry -> rotate successor file).
    const manager = SessionManager.create(tmpDir, tmpDir);
    manager.appendMessage({ role: "user", content: "old user", timestamp: 1 });
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "old assistant" }],
        timestamp: 2,
      }),
    );
    const firstKeptId = manager.appendMessage({
      role: "user",
      content: "kept user",
      timestamp: 3,
    });
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "kept assistant" }],
        timestamp: 2,
      }),
    );
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) {
      throw new Error("expected session file");
    }

    // Real persistence dep; only the CLI and input source are stubbed.
    setCompactCliTestDeps({
      prepareCliRunContext: vi.fn(
        async (): Promise<PreparedCliRunContext> =>
          ({
            marker: "prepared",
            preparedBackend: { cleanup: vi.fn(async () => {}) },
          }) as unknown as PreparedCliRunContext,
      ),
      executePreparedCliRun: vi.fn(async (): Promise<CliOutput> => ({ text: SUMMARY })),
      loadCompactionSummarizationInput: vi.fn(async () => ({
        messagesToSummarize: [userMessage("old user"), assistantMessage("old assistant")],
        firstKeptEntryId: firstKeptId,
        tokensBefore: 5000,
      })),
    });

    const result = await compactViaClaudeCli(
      baseParams({
        sessionFile,
        config: {
          agents: { defaults: { compaction: { truncateAfterCompaction: true } } },
        } as CompactEmbeddedAgentSessionParams["config"],
      }),
    );

    expect(result?.ok).toBe(true);
    expect(result?.compacted).toBe(true);
    expect(result?.result?.summary).toBe(SUMMARY);
    expect(result?.result?.firstKeptEntryId).toBe(firstKeptId);
    expect(result?.result?.tokensBefore).toBe(5000);
    // Persistence populates tokensAfter and the rotated successor identity.
    expect(typeof result?.result?.tokensAfter).toBe("number");
    const successorFile = result?.result?.sessionFile;
    expect(successorFile).toBeTruthy();
    expect(successorFile).not.toBe(sessionFile);

    // The original transcript now carries the appended compaction entry.
    const originalEntries = SessionManager.open(sessionFile).getEntries();
    expect(originalEntries.some((entry) => entry.type === "compaction")).toBe(true);

    // The successor transcript surfaces the CLI summary as its compaction summary.
    const successor = SessionManager.open(successorFile as string);
    const summaryMessage = successor
      .buildSessionContext()
      .messages.find((message) => message.role === "compactionSummary");
    expect(summaryMessage).toBeDefined();
    expect((summaryMessage as { summary?: string }).summary).toBe(SUMMARY);
  });

  it("appends the compaction entry even when successor rotation is disabled", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "compact-cli-noroll-"));
    const manager = SessionManager.create(tmpDir, tmpDir);
    manager.appendMessage({ role: "user", content: "old user", timestamp: 1 });
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "old assistant" }],
        timestamp: 2,
      }),
    );
    const firstKeptId = manager.appendMessage({
      role: "user",
      content: "kept user",
      timestamp: 3,
    });
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) {
      throw new Error("expected session file");
    }

    setCompactCliTestDeps({
      prepareCliRunContext: vi.fn(
        async (): Promise<PreparedCliRunContext> =>
          ({
            marker: "prepared",
            preparedBackend: { cleanup: vi.fn(async () => {}) },
          }) as unknown as PreparedCliRunContext,
      ),
      executePreparedCliRun: vi.fn(async (): Promise<CliOutput> => ({ text: SUMMARY })),
      loadCompactionSummarizationInput: vi.fn(async () => ({
        messagesToSummarize: [userMessage("old user")],
        firstKeptEntryId: firstKeptId,
        tokensBefore: 2048,
      })),
    });

    // No truncateAfterCompaction: the active transcript stays in place.
    const result = await compactViaClaudeCli(baseParams({ sessionFile }));

    expect(result?.ok).toBe(true);
    expect(result?.compacted).toBe(true);
    expect(result?.result?.sessionFile).toBeUndefined();
    const entries = SessionManager.open(sessionFile).getEntries();
    const compaction = entries.find((entry) => entry.type === "compaction");
    expect(compaction).toBeDefined();
    expect((compaction as { summary?: string }).summary).toBe(SUMMARY);
  });
});
