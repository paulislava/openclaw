/**
 * Loads the canonical compaction summarization input for a session transcript.
 *
 * Mirrors the embedded path's `session.compact()` staging: open the transcript,
 * take the active branch, and run the shared `prepareCompaction` planner to get
 * the exact message subset that would be summarized, plus the cut boundary and
 * pre-compaction token estimate. Kept as a narrow seam so the one-shot CLI
 * summarizer and the successor-transcript wiring (Task 3) share one message
 * source instead of re-deriving the cut point.
 */
import type { CompactEmbeddedAgentSessionParams } from "../embedded-agent-runner/compact.types.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  DEFAULT_COMPACTION_SETTINGS,
  prepareCompaction,
  SessionManager,
  type CompactionSettings,
} from "../sessions/index.js";

/** Prepared message subset and cut boundary for a compaction summary. */
export type CompactionSummarizationInput = {
  messagesToSummarize: AgentMessage[];
  firstKeptEntryId: string;
  tokensBefore: number;
  previousSummary?: string;
};

function resolveCompactionSettings(params: CompactEmbeddedAgentSessionParams): CompactionSettings {
  const compaction = params.config?.agents?.defaults?.compaction;
  const reserveTokens =
    typeof compaction?.reserveTokens === "number" && compaction.reserveTokens > 0
      ? Math.floor(compaction.reserveTokens)
      : DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const keepRecentTokens =
    typeof compaction?.keepRecentTokens === "number" && compaction.keepRecentTokens > 0
      ? Math.floor(compaction.keepRecentTokens)
      : DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
  return { enabled: true, reserveTokens, keepRecentTokens };
}

/** Loads the summarizable message subset for the session's active branch. */
export async function loadCompactionSummarizationInput(
  params: CompactEmbeddedAgentSessionParams,
): Promise<CompactionSummarizationInput> {
  const sessionManager = SessionManager.open(params.sessionFile);
  const preparation = prepareCompaction(
    sessionManager.getBranch(),
    resolveCompactionSettings(params),
  );
  if (!preparation) {
    return { messagesToSummarize: [], firstKeptEntryId: "", tokensBefore: 0 };
  }
  return {
    messagesToSummarize: preparation.messagesToSummarize,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    ...(preparation.previousSummary ? { previousSummary: preparation.previousSummary } : {}),
  };
}
