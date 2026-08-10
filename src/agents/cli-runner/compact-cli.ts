/**
 * One-shot Claude CLI compaction summarizer.
 *
 * `agentRuntime: claude-cli` compaction models cannot use the embedded HTTP
 * summarization path (it needs an Anthropic API key). This produces the
 * compaction summary through the CLI process itself: it reuses the shared
 * agent-core summarization prompt, runs a fresh, tool-less, print-mode CLI call
 * on the `claude-cli` backend, and lifts the summary text out of CliOutput.
 *
 * Scope: this module owns producing the summary TEXT only. Persisting the
 * summary into the successor transcript / checkpoint machinery is the caller's
 * job (Task 3) — it consumes the `result` payload returned here, which mirrors
 * the shape produced by `session.compact()` in the embedded path.
 */
import type { CompactEmbeddedAgentSessionParams } from "../embedded-agent-runner/compact.types.js";
import type { EmbeddedAgentCompactResult } from "../embedded-agent-runner/types.js";
import { buildCompactionSummaryPrompt } from "../runtime/index.js";
import {
  loadCompactionSummarizationInput as loadCompactionSummarizationInputImpl,
  type CompactionSummarizationInput,
} from "./compact-cli-input.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.runtime.js";
import { prepareCliRunContext as prepareCliRunContextImpl } from "./prepare.runtime.js";

/** CLI backend id that owns Claude CLI compaction. */
const CLAUDE_CLI_PROVIDER = "claude-cli";

/** Default per-run timeout for a one-shot compaction CLI call. */
const DEFAULT_COMPACTION_TIMEOUT_MS = 120_000;

const compactCliDeps = {
  prepareCliRunContext: prepareCliRunContextImpl,
  executePreparedCliRun: executePreparedCliRunImpl,
  loadCompactionSummarizationInput: loadCompactionSummarizationInputImpl,
};

/** Overrides CLI/compaction dependencies for one-shot compaction tests. */
export function setCompactCliTestDeps(overrides: Partial<typeof compactCliDeps>): void {
  Object.assign(compactCliDeps, overrides);
}

function nothingToCompact(): EmbeddedAgentCompactResult {
  return { ok: true, compacted: false, reason: "no summarizable history" };
}

/**
 * Produces a compaction summary for a `claude-cli` session through a one-shot
 * CLI run. Returns `undefined` only when the provider is not a Claude CLI
 * backend, so routing (Task 4) can fall through to another summarizer.
 */
export async function compactViaClaudeCli(
  params: CompactEmbeddedAgentSessionParams,
): Promise<EmbeddedAgentCompactResult | undefined> {
  const input: CompactionSummarizationInput =
    await compactCliDeps.loadCompactionSummarizationInput(params);
  if (input.messagesToSummarize.length === 0) {
    return nothingToCompact();
  }

  const { systemPrompt, promptText } = buildCompactionSummaryPrompt(input.messagesToSummarize, {
    ...(params.customInstructions ? { customInstructions: params.customInstructions } : {}),
    ...(input.previousSummary ? { previousSummary: input.previousSummary } : {}),
  });

  const prepared = await compactCliDeps.prepareCliRunContext({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    config: params.config,
    trigger: "user",
    // Fresh one-shot: side-question mode skips history/context/MCP and forces a
    // new CLI session; disableTools keeps it a pure summarization turn.
    executionMode: "side-question",
    disableTools: true,
    oneShotCliRun: true,
    provider: CLAUDE_CLI_PROVIDER,
    model: params.model,
    prompt: promptText,
    extraSystemPrompt: systemPrompt,
    thinkLevel: params.thinkLevel ?? "off",
    authProfileId: params.authProfileId,
    timeoutMs: DEFAULT_COMPACTION_TIMEOUT_MS,
    runId: params.runId ?? `compaction-${params.sessionId}`,
    abortSignal: params.abortSignal,
  });

  try {
    const output = await compactCliDeps.executePreparedCliRun(prepared);
    const summary = output.text.trim();
    if (!summary) {
      return {
        ok: false,
        compacted: false,
        reason: "claude-cli compaction produced no summary text",
      };
    }
    return {
      ok: true,
      compacted: true,
      result: {
        summary,
        firstKeptEntryId: input.firstKeptEntryId,
        tokensBefore: input.tokensBefore,
      },
    };
  } finally {
    await prepared.preparedBackend?.cleanup?.();
  }
}
