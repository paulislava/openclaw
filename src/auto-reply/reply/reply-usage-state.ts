import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import { deriveContextPromptTokens, type NormalizedUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { loadProviderUsageSummary, resolveUsageProviderId } from "../../infra/provider-usage.js";
import type { PluginHookReplyUsageState } from "../../plugins/hook-types.js";
import {
  buildCodexSyntheticUsageAuth,
  shouldUseCodexSyntheticUsageForRuntime,
  resolveUsageCredentialType,
} from "../../status/codex-synthetic-usage.js";
import { estimateAggregateUsageCost } from "../../utils/usage-format.js";

const TTL_MS = 5 * 60_000;
const MAX_REPLY_USAGE_STATE_ENTRIES = 1_024;

const store = new Map<string, { snapshot: PluginHookReplyUsageState; expiresAt: number }>();

function projectHookUsage(usage?: NormalizedUsage): PluginHookReplyUsageState["usage"] {
  if (!usage) {
    return undefined;
  }
  const { input, output, cacheRead, cacheWrite, total } = usage;
  return { input, output, cacheRead, cacheWrite, total };
}

export function buildReplyUsageState(
  params: Omit<
    PluginHookReplyUsageState,
    "resolvedRef" | "requested" | "turnUsd" | "identity" | "usage" | "lastUsage"
  > & {
    config: OpenClawConfig;
    agentDir: string;
    agentId: string;
    sessionId: string;
    fallbackExhausted?: boolean;
    winnerProvider?: string;
    winnerModel?: string;
    requestedProvider?: string;
    requestedModel?: string;
    promptTokens?: number;
    usage?: NormalizedUsage;
    lastCallUsage?: NormalizedUsage;
  },
): PluginHookReplyUsageState {
  const resolvedProvider = params.fallbackExhausted ? undefined : params.winnerProvider;
  const resolvedModel = params.fallbackExhausted ? undefined : params.winnerModel;
  return {
    provider: params.provider,
    model: params.model,
    resolvedRef:
      resolvedProvider && resolvedModel ? `${resolvedProvider}/${resolvedModel}` : undefined,
    reasoningEffort: params.reasoningEffort,
    fastMode: params.fastMode,
    fallbackUsed: params.fallbackUsed,
    agentId: params.agentId,
    sessionId: params.sessionId,
    chatType: params.chatType,
    authMode: params.authMode,
    overrideSource: params.overrideSource,
    requested:
      params.requestedProvider && params.requestedModel
        ? `${params.requestedProvider}/${params.requestedModel}`
        : undefined,
    turnUsd: estimateAggregateUsageCost({
      usage: params.usage,
      provider: params.provider,
      model: params.model,
      config: params.config,
      agentDir: params.agentDir,
    }),
    durationMs: params.durationMs,
    cwd: params.cwd,
    providerUsageWindows: params.providerUsageWindows,
    identity: resolveAgentIdentity(params.config, params.agentId),
    compactionCount: params.compactionCount,
    contextTokenBudget: asFiniteNumber(params.contextTokenBudget),
    contextUsedTokens:
      asFiniteNumber(params.contextUsedTokens) ?? deriveContextPromptTokens(params),
    usage: projectHookUsage(params.usage),
    lastUsage: projectHookUsage(params.lastCallUsage),
  };
}

export async function resolveReplyProviderUsageWindows(params: {
  config: OpenClawConfig;
  provider?: string;
  model?: string;
  authMode?: string;
  harnessId?: string;
  agentId?: string;
  sessionKey?: string;
  authProfileId?: string;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<PluginHookReplyUsageState["providerUsageWindows"]> {
  try {
    const provider = params.provider?.trim().toLowerCase();
    const runtime = resolveAgentHarnessPolicy({
      config: params.config,
      provider,
      modelId: params.model,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    }).runtime;
    const harness =
      params.harnessId ?? (provider === "claude-cli" || provider === "codex" ? provider : runtime);
    const codex = shouldUseCodexSyntheticUsageForRuntime({ provider, effectiveHarness: harness });
    const claude = harness === "claude-cli";
    const credentialType = codex || claude ? "token" : resolveUsageCredentialType(params.authMode);
    const usageProvider = resolveUsageProviderId(provider, { credentialType });
    if (!usageProvider) {
      return undefined;
    }
    // Claude's native auth marker proves presence; it is never an HTTP bearer.
    // Anthropic's usage owner chooses a supported credential without refreshing the CLI login.
    const auth = codex
      ? buildCodexSyntheticUsageAuth({ authProfileId: params.authProfileId })
      : undefined;
    const summary = await loadProviderUsageSummary({
      config: params.config,
      providers: [usageProvider],
      ...(auth ? { auth: [auth] } : {}),
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      timeoutMs: codex || claude ? 8000 : 1200,
    });
    const snapshot = summary.providers.find((entry) => entry.provider === usageProvider);
    return snapshot && !snapshot.error && snapshot.windows.length ? snapshot.windows : undefined;
  } catch {
    return undefined;
  }
}

function prune(now: number): void {
  for (const [key, value] of store) {
    if (value.expiresAt < now) {
      store.delete(key);
    }
  }
  // This handoff is best-effort metadata for an optional hook. Bound bursts so
  // completed runs cannot retain one full snapshot each for the whole TTL.
  pruneMapToMaxSize(store, MAX_REPLY_USAGE_STATE_ENTRIES);
}

export function recordReplyUsageState(
  runId: string | undefined,
  snapshot: PluginHookReplyUsageState,
): void {
  if (!runId) {
    return;
  }
  const now = Date.now();
  store.set(runId, { snapshot, expiresAt: now + TTL_MS });
  prune(now);
}

export function consumeReplyUsageState(runId?: string): PluginHookReplyUsageState | undefined {
  if (!runId) {
    return undefined;
  }
  const value = store.get(runId);
  return value && value.expiresAt >= Date.now() ? value.snapshot : undefined;
}
