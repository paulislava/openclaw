import { DEFAULT_COMPACTION_SETTINGS } from "../../../packages/agent-core/src/index.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { applyAgentCompactionSettingsFromConfig } from "../agent-settings.js";
import { SAFETY_MARGIN } from "../compaction-planning.js";
import type { CompactEmbeddedAgentSessionParams } from "../embedded-agent-runner/compact.types.js";
import { readCompactionAccountingRecorder } from "../embedded-agent-runner/run/compaction-accounting-bridge.js";
import { resolveAgentRunSessionTarget } from "../run-session-target.js";
import { buildSessionContext, prepareCompaction } from "../runtime/index.js";
import { unwrapCoreResult } from "../sessions/agent-session-utils.js";
import {
  assertCompactionRequestCanFit,
  estimateCompactedRequestTokens,
  estimateCompactionHistoryTokens,
  resolveCompactionRetentionBudget,
} from "../sessions/compaction/request-budget.js";
import { preflightManualSessionCompaction } from "../sessions/manual-compaction-preflight.js";
import { SessionManager } from "../sessions/session-manager.js";
import { SettingsManager } from "../sessions/settings-manager.js";

/** Uses the admitted storage owner and the same planner as embedded compaction. */
export async function loadCompactionSummarizationInput(params: CompactEmbeddedAgentSessionParams) {
  const accounting = readCompactionAccountingRecorder(params.contextEngineRuntimeContext);
  const memory = accounting?.memoryTranscript;
  const prepared = accounting?.preparedSession;
  const sessionTarget =
    memory?.sessionTarget ??
    prepared?.sessionTarget ??
    (await resolveAgentRunSessionTarget({ ...params, missingSessionKey: "resolve-existing" }));
  const assertOwner = memory?.assertActive ?? captureOwnedTranscriptWriteAssertion(sessionTarget);
  const assertActive = () => {
    params.abortSignal?.throwIfAborted();
    assertOwner();
  };
  assertActive();
  const sessionManager =
    memory?.sessionManager ??
    prepared?.sessionManager ??
    (await SessionManager.openAsync(
      sessionTarget,
      undefined,
      { compaction: true },
      params.abortSignal,
    ));
  assertActive();
  const pathEntries = sessionManager.getBranch();
  const context = buildSessionContext(pathEntries).messages;
  const settingsManager = SettingsManager.inMemory({
    compaction: { ...DEFAULT_COMPACTION_SETTINGS },
  });
  applyAgentCompactionSettingsFromConfig({
    settingsManager,
    cfg: params.config,
    contextTokenBudget: params.contextTokenBudget,
  });
  const settings = settingsManager.getCompactionSettings();
  const requestBudget = accounting?.requestBudget;
  const pendingUserIdempotencyKey = requestBudget?.pendingTokens
    ? requestBudget.pendingUserIdempotencyKey
    : undefined;
  const pendingIndex =
    accounting?.pendingUserEntryId || pendingUserIdempotencyKey
      ? pathEntries.findLastIndex(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            (accounting?.pendingUserEntryId
              ? entry.id === accounting.pendingUserEntryId
              : "idempotencyKey" in entry.message &&
                entry.message.idempotencyKey === pendingUserIdempotencyKey),
        )
      : -1;
  if (accounting?.pendingUserEntryId && pendingIndex < 0) {
    throw new Error("Compaction cannot find the admitted pending user request.");
  }
  assertCompactionRequestCanFit(context, requestBudget, true);
  const retention = requestBudget
    ? resolveCompactionRetentionBudget(requestBudget, context)
    : undefined;
  const preparation =
    params.trigger === "manual" && !requestBudget && pendingIndex < 0
      ? (() => {
          const manual = preflightManualSessionCompaction(pathEntries, settings);
          return manual.compactable ? manual.preparation : undefined;
        })()
      : unwrapCoreResult(
          prepareCompaction(
            pathEntries,
            settings,
            accounting?.pendingRequestState ??
              (params.trigger === "overflow" ? "unresolved" : undefined),
            {
              preserveFromEntryId: pathEntries[pendingIndex]?.id,
              ...(retention
                ? {
                    budget: {
                      ...retention,
                      estimateTokens: (message) =>
                        estimateCompactionHistoryTokens([message], requestBudget),
                    },
                  }
                : {}),
            },
          ),
        );
  const requestTokenLimit =
    requestBudget && retention
      ? requestBudget.fixedTokens + requestBudget.pendingTokens + retention.maxTokens
      : undefined;
  if (preparation && requestBudget && requestTokenLimit !== undefined) {
    const projected = buildSessionContext([
      ...pathEntries,
      {
        type: "compaction",
        id: "cli-compaction-projection",
        parentId: pathEntries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        summary: "",
        ...preparation,
      },
    ]).messages;
    preparation.summaryTokenBudget =
      Math.floor(
        (requestTokenLimit - estimateCompactedRequestTokens(projected, requestBudget)) /
          SAFETY_MARGIN,
      ) - 1;
  }
  return {
    sessionManager,
    sessionTarget,
    assertActive,
    accounting,
    preparation,
    requestBudget,
    requestTokenLimit,
  };
}
