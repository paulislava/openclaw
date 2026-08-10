// Exercises one-shot CLI compaction: prompt is built from the shared agent-core
// summarizer, the CLI runs fresh/no-tools/print, and the summary text is lifted
// out of CliOutput into an EmbeddedAgentCompactResult. The CLI process is always
// mocked; no `claude` binary is spawned.
import { describe, expect, it, vi } from "vitest";
import type { CliOutput } from "../cli-output.js";
import type { CompactEmbeddedAgentSessionParams } from "../embedded-agent-runner/compact.types.js";
import type { AgentMessage } from "../runtime/index.js";
import { compactViaClaudeCli, setCompactCliTestDeps } from "./compact-cli.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

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
  const prepared = { marker: "prepared-context" } as unknown as PreparedCliRunContext;
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
  setCompactCliTestDeps({
    prepareCliRunContext,
    executePreparedCliRun,
    loadCompactionSummarizationInput,
  });
  return {
    prepared,
    prepareCliRunContext,
    executePreparedCliRun,
    loadCompactionSummarizationInput,
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
});
