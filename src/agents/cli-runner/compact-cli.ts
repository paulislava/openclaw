/**
 * One-shot Claude CLI compaction summarizer.
 *
 * `agentRuntime: claude-cli` compaction models cannot use the embedded HTTP
 * summarization path (it needs an Anthropic API key). This produces the
 * compaction summary through the CLI process itself: it reuses the shared
 * agent-core summarization prompt, runs a fresh, tool-less, print-mode CLI call
 * on the `claude-cli` backend, and lifts the summary text out of CliOutput.
 *
 * Scope: this module produces the summary TEXT via the CLI, then persists it
 * through the SAME successor-transcript / checkpoint machinery the embedded
 * path uses (`SessionManager.appendCompaction` → `rotateTranscriptAfterCompaction`
 * → checkpoint store). The CLI-produced summary is fed into the pre-computed
 * `{ summary, firstKeptEntryId, tokensBefore }` shape that embedded persistence
 * already consumes, so Task 4 routing just calls this one function.
 */
import {
  createFileBackedCompactionCheckpointStore,
  readSessionLeafStateFromTranscriptAsync,
  resolveCompactionCheckpointTranscriptPosition,
  resolveSessionCompactionCheckpointReason,
} from "../../gateway/session-compaction-checkpoints.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { CompactEmbeddedAgentSessionParams } from "../embedded-agent-runner/compact.types.js";
import {
  rotateTranscriptAfterCompaction,
  shouldRotateCompactionTranscript,
} from "../embedded-agent-runner/compaction-successor-transcript.js";
import { log } from "../embedded-agent-runner/logger.js";
import type { EmbeddedAgentCompactResult } from "../embedded-agent-runner/types.js";
import { buildCompactionSummaryPrompt } from "../runtime/index.js";
import { estimateTokens, SessionManager } from "../sessions/index.js";
import {
  loadCompactionSummarizationInput as loadCompactionSummarizationInputImpl,
  type CompactionSummarizationInput,
} from "./compact-cli-input.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.runtime.js";
import { prepareCliRunContext as prepareCliRunContextImpl } from "./prepare.runtime.js";

/** CLI backend id/runtime that owns Claude CLI compaction; routing gates on it. */
export const CLAUDE_CLI_PROVIDER = "claude-cli";

/** Default per-run timeout for a one-shot compaction CLI call. */
const DEFAULT_COMPACTION_TIMEOUT_MS = 120_000;

/** Reuses the embedded checkpoint store so CLI + embedded persistence stay identical. */
const compactionCheckpointStore = createFileBackedCompactionCheckpointStore();

const compactCliDeps = {
  prepareCliRunContext: prepareCliRunContextImpl,
  executePreparedCliRun: executePreparedCliRunImpl,
  loadCompactionSummarizationInput: loadCompactionSummarizationInputImpl,
  persistCompactionSummary: persistCompactionSummaryImpl,
};

const compactCliDefaultDeps = { ...compactCliDeps };

/** Overrides CLI/compaction dependencies for one-shot compaction tests. */
export function setCompactCliTestDeps(overrides: Partial<typeof compactCliDeps>): void {
  Object.assign(compactCliDeps, overrides);
}

/** Restores the real CLI/compaction dependencies (test cleanup only). */
export function resetCompactCliTestDeps(): void {
  Object.assign(compactCliDeps, compactCliDefaultDeps);
}

function nothingToCompact(): EmbeddedAgentCompactResult {
  return { ok: true, compacted: false, reason: "no summarizable history" };
}

/**
 * Produces a compaction summary for a `claude-cli` session through a one-shot
 * CLI run. `maybeCompactAgentHarnessSession` is the sole gatekeeper: it only
 * calls this once the resolved provider/runtime is known to be `claude-cli`, so
 * this always returns a concrete compaction result (never `undefined`) and
 * failures propagate to the caller instead of silently re-routing to embedded.
 */
export async function compactViaClaudeCli(
  params: CompactEmbeddedAgentSessionParams,
): Promise<EmbeddedAgentCompactResult> {
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
    // The CLI only produced the summary TEXT; persist it through the same
    // successor-transcript / checkpoint machinery the embedded path uses so the
    // caller (Task 4 routing) gets a fully-populated compaction result.
    return await compactCliDeps.persistCompactionSummary({
      params,
      summary,
      firstKeptEntryId: input.firstKeptEntryId,
      tokensBefore: input.tokensBefore,
    });
  } finally {
    await prepared.preparedBackend.cleanup?.();
  }
}

/** Sums per-message token estimates for the remaining post-compaction context. */
function estimateRemainingTokens(
  messages: ReturnType<SessionManager["buildSessionContext"]>["messages"],
): number {
  let total = 0;
  for (const message of messages) {
    try {
      total += estimateTokens(message);
    } catch {
      // A malformed message must not abort persistence; skip its estimate.
    }
  }
  return total;
}

/**
 * Persists a pre-computed compaction summary into the session using the same
 * embedded machinery: append the compaction entry to the transcript, rotate the
 * successor transcript when configured, and record the compaction checkpoint.
 * Mirrors `compactEmbeddedAgentSessionDirect`'s persistence tail, only the
 * summary source differs (CLI instead of the embedded HTTP summarizer).
 */
async function persistCompactionSummaryImpl(input: {
  params: CompactEmbeddedAgentSessionParams;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}): Promise<EmbeddedAgentCompactResult> {
  const { params, summary, firstKeptEntryId, tokensBefore } = input;
  const sessionManager = SessionManager.open(params.sessionFile);

  // Capture the pre-compaction transcript identity BEFORE appending so the
  // checkpoint can fork the exact original branch, matching the embedded path.
  const checkpointSnapshot = await compactionCheckpointStore.captureSnapshot({
    sessionManager,
    sessionFile: params.sessionFile,
  });

  sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore);
  const tokensAfter = estimateRemainingTokens(sessionManager.buildSessionContext().messages);
  const postCompactionLeafId = sessionManager.getLeafId() ?? undefined;

  let activeSessionId = params.sessionId;
  let activeSessionFile = params.sessionFile;
  let activeLeafId = postCompactionLeafId;
  let rotatedSessionId: string | undefined;
  let rotatedSessionFile: string | undefined;
  if (shouldRotateCompactionTranscript(params.config)) {
    try {
      const rotation = await rotateTranscriptAfterCompaction({
        sessionManager,
        sessionFile: params.sessionFile,
      });
      if (rotation.rotated) {
        rotatedSessionId = rotation.sessionId;
        rotatedSessionFile = rotation.sessionFile;
        activeSessionId = rotation.sessionId ?? activeSessionId;
        activeSessionFile = rotation.sessionFile ?? activeSessionFile;
        activeLeafId = rotation.leafId ?? activeLeafId;
      }
    } catch (err) {
      log.warn("[compaction] claude-cli successor transcript rotation failed", {
        errorMessage: formatErrorMessage(err),
      });
    }
  }

  if (params.config && params.sessionKey && checkpointSnapshot) {
    try {
      const transcriptState = await readSessionLeafStateFromTranscriptAsync(activeSessionFile);
      const checkpointPosition = resolveCompactionCheckpointTranscriptPosition({
        preferredLeafId: activeLeafId,
        transcriptState,
      });
      await compactionCheckpointStore.persistCheckpoint({
        cfg: params.config,
        sessionKey: params.sessionKey,
        sessionId: activeSessionId,
        reason: resolveSessionCompactionCheckpointReason({ trigger: params.trigger }),
        snapshot: checkpointSnapshot,
        summary,
        firstKeptEntryId,
        tokensBefore,
        tokensAfter,
        postSessionFile: activeSessionFile,
        postLeafId: checkpointPosition.leafId,
        postEntryId: checkpointPosition.entryId,
      });
    } catch (err) {
      log.warn("[compaction] failed to persist claude-cli compaction checkpoint", {
        errorMessage: formatErrorMessage(err),
      });
    }
  }

  return {
    ok: true,
    compacted: true,
    result: {
      summary,
      firstKeptEntryId,
      tokensBefore,
      tokensAfter,
      ...(rotatedSessionId ? { sessionId: rotatedSessionId } : {}),
      ...(rotatedSessionFile ? { sessionFile: rotatedSessionFile } : {}),
    },
  };
}
