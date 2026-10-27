import type { CompleteSimpleFn } from "@openclaw/llm-core";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveCompactionInstructions } from "../agent-hooks/compaction-instructions.js";
import { resolveCliRuntimeCanonicalProvider } from "../cli-backends.js";
import type { CompactEmbeddedAgentSessionParams } from "../embedded-agent-runner/compact.types.js";
import {
  buildBeforeCompactionHookMetrics,
  runCompactionHooks,
  runPostCompactionSideEffects,
} from "../embedded-agent-runner/compaction-hooks.js";
import { resolveCompactionTimeoutMs } from "../embedded-agent-runner/compaction-safety-timeout.js";
import { resolveModelAsync } from "../embedded-agent-runner/model.js";
import { declarePromptHistoryRewrite } from "../embedded-agent-runner/prompt-cache-observability.js";
import type { EmbeddedAgentCompactResult } from "../embedded-agent-runner/types.js";
import { describeFailoverError, hasModelFallbackStop } from "../failover-error.js";
import { runIsolatedCompletion } from "../isolated-completion.js";
import {
  compact,
  buildSessionContext,
  estimateContextTokens,
  estimateTokens,
} from "../runtime/index.js";
import { wrapUntrustedPromptDataBlock } from "../sanitize-for-prompt.js";
import { unwrapCoreResult } from "../sessions/agent-session-utils.js";
import { estimateCompactedRequestTokens } from "../sessions/compaction/request-budget.js";
import {
  withSessionCompactionPersistenceAsync,
  type CompactionAppendPersistenceAsync,
} from "../sessions/session-compaction-persistence.js";
import { withSessionManagerWrite } from "../sessions/session-manager-write-admission.js";
import { normalizeUsage } from "../usage.js";
import { loadCompactionSummarizationInput } from "./compact-cli-input.js";

export const CLAUDE_CLI_PROVIDER = "claude-cli";

/** A fresh tool-less CLI completion supplies text; the session owner commits the shared plan. */
export async function compactViaClaudeCli(
  params: CompactEmbeddedAgentSessionParams,
  seedCompaction?: CompactionAppendPersistenceAsync,
): Promise<EmbeddedAgentCompactResult> {
  try {
    const {
      sessionManager,
      sessionTarget,
      assertActive,
      preparation,
      accounting,
      requestBudget,
      requestTokenLimit,
    } = await loadCompactionSummarizationInput(params);
    if (!preparation) {
      return { ok: true, compacted: false, reason: "Nothing to compact (session too small)" };
    }
    const modelProvider =
      resolveCliRuntimeCanonicalProvider({ runtime: CLAUDE_CLI_PROVIDER, config: params.config }) ??
      "anthropic";
    const resolved =
      params.runtimeModel?.provider === modelProvider && params.runtimeModel.id === params.model
        ? { model: params.runtimeModel }
        : await resolveModelAsync(
            modelProvider,
            params.model ?? "",
            params.agentDir,
            params.config,
            {
              workspaceDir: params.workspaceDir,
              skipAgentDiscovery: true,
              allowBundledStaticCatalogFallback: true,
              agentRuntimeId: CLAUDE_CLI_PROVIDER,
            },
          );
    assertActive();
    if (!resolved.model) {
      throw new Error(`Unknown compaction model: ${modelProvider}/${params.model ?? ""}`);
    }
    const model = resolved.model;
    const hookRunner = accounting?.hostOwnsCompactionLifecycle ? null : getGlobalHookRunner();
    const messagesBefore = sessionManager.buildSessionContext().messages;
    const hookContext = {
      hookRunner,
      sessionId: params.sessionId,
      sessionKey: sessionTarget.sessionKey,
      sessionAgentId: sessionTarget.agentId,
      workspaceDir: params.workspaceDir,
      messageProvider: params.messageProvider,
      assertActive,
      onHookMessages: params.onCompactionHookMessages,
    };
    await runCompactionHooks({
      ...hookContext,
      phase: "before",
      metrics: buildBeforeCompactionHookMetrics({
        originalMessages: messagesBefore,
        currentMessages: messagesBefore,
        observedTokenCount: params.currentTokenCount,
        estimateTokensFn: estimateTokens,
      }),
    });
    const configuredThinking = params.config?.agents?.defaults?.compaction?.thinkingLevel;
    const thinkLevel =
      configuredThinking === "inherit"
        ? (params.thinkLevel ?? "off")
        : (configuredThinking ?? params.thinkLevel ?? "off");
    const completeSimple: CompleteSimpleFn = async (_model, context, options) => {
      assertActive();
      const prompt = context.messages
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("\n"),
        )
        .join("\n\n");
      const output = await runIsolatedCompletion({
        config: params.config,
        agentId: sessionTarget.agentId,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        provider: modelProvider,
        model: params.model ?? model.id,
        authProfileId: params.authProfileId,
        agentHarnessRuntimeOverride: CLAUDE_CLI_PROVIDER,
        systemPrompt: context.systemPrompt ?? "",
        prompt,
        thinkLevel,
        timeoutMs: resolveCompactionTimeoutMs(params.config),
        abortSignal: options?.signal,
        assertCurrent: assertActive,
        outputTextPolicy: "strict-visible",
        ...(typeof options?.maxTokens === "number" ? { answerTokenBudget: options.maxTokens } : {}),
      });
      assertActive();
      const usage = normalizeUsage(output.usage);
      if (usage) {
        accounting?.recordUsage?.(usage);
      }
      return {
        role: "assistant",
        content: [{ type: "text", text: output.text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    };
    const focus = params.customInstructions?.trim();
    const result = unwrapCoreResult(
      await compact(
        preparation,
        model,
        undefined,
        undefined,
        focus
          ? wrapUntrustedPromptDataBlock({
              label: "Compaction focus",
              text: resolveCompactionInstructions(focus, undefined),
            })
          : undefined,
        params.abortSignal,
        undefined,
        undefined,
        { completeSimple },
      ),
    );
    const projected = buildSessionContext([
      ...sessionManager.getBranch(),
      {
        type: "compaction",
        id: "cli-compaction-projection",
        parentId: sessionManager.getLeafId(),
        timestamp: new Date().toISOString(),
        ...result,
      },
    ]).messages;
    if (
      requestBudget &&
      requestTokenLimit !== undefined &&
      estimateCompactedRequestTokens(projected, requestBudget) > requestTokenLimit
    ) {
      throw new Error("The finalized compaction exceeds the foreground request budget.");
    }
    const tokensAfter = requestBudget
      ? estimateCompactedRequestTokens(projected, { ...requestBudget, pendingTokens: 0 })
      : estimateContextTokens(projected).tokens;
    await withSessionManagerWrite(sessionManager, () =>
      withSessionTranscriptWriteAssertion(sessionTarget, assertActive, () =>
        withSessionCompactionPersistenceAsync(
          sessionManager,
          seedCompaction ?? accounting?.withCompactionPersistenceAsync,
          () => {
            assertActive();
            return sessionManager.appendCompactionAsync(
              result.summary,
              result.firstKeptEntryId,
              result.tokensBefore,
              result.details,
              false,
              undefined,
              tokensAfter,
            );
          },
        ),
      ),
    );
    accounting?.recordCompaction?.({
      tokensBefore: result.tokensBefore,
      tokensAfter,
      compactionKind: "context-engine",
      details: result.details,
    });
    if (!accounting?.recordCompaction) {
      declarePromptHistoryRewrite({ ...sessionTarget, reason: "compaction" });
    }
    if (!accounting?.memoryTranscript && !accounting?.hostOwnsCompactionLifecycle) {
      await runPostCompactionSideEffects({
        ...params,
        agentId: sessionTarget.agentId,
        assertActive,
      });
    }
    await runCompactionHooks({
      ...hookContext,
      phase: "after",
      sessionFile: params.sessionFile,
      messageCountAfter: projected.length,
      tokensAfter,
      compactedCount: Math.max(0, messagesBefore.length - projected.length),
      summaryLength: result.summary.length,
      tokensBefore: result.tokensBefore,
      firstKeptEntryId: result.firstKeptEntryId,
    });
    return { ok: true, compacted: true, result: { ...result, tokensAfter, sessionTarget } };
  } catch (error) {
    params.abortSignal?.throwIfAborted();
    if (hasModelFallbackStop(error)) {
      throw error;
    }
    const failure = describeFailoverError(error);
    return {
      ok: false,
      compacted: false,
      reason: formatErrorMessage(error),
      failure: {
        reason: failure.reason,
        status: failure.status,
        code: failure.code,
        rawError: failure.rawError ?? failure.message,
      },
    };
  }
}
