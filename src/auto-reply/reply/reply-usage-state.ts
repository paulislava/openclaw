import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import { deriveContextPromptTokens, type NormalizedUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProviderAuth } from "../../infra/provider-usage.auth.js";
import {
  loadProviderUsageSummary,
  resolveUsageProviderId,
  type UsageWindow,
} from "../../infra/provider-usage.js";
import type { PluginHookReplyUsageState } from "../../plugins/hook-types.js";
import { resolveProviderSyntheticAuthWithPlugin } from "../../plugins/provider-runtime.js";
import {
  buildCodexSyntheticUsageAuth,
  shouldUseCodexSyntheticUsageForRuntime,
} from "../../status/codex-synthetic-usage.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";

const TTL_MS = 5 * 60_000;
const REPLY_PROVIDER_USAGE_TIMEOUT_MS = 1200;
const REPLY_CODEX_SYNTHETIC_USAGE_TIMEOUT_MS = 8000;
const REPLY_CLAUDE_CLI_SYNTHETIC_USAGE_TIMEOUT_MS = 8000;
const CLAUDE_CLI_USAGE_PROVIDER = "anthropic";
const CLAUDE_CLI_SYNTHETIC_USAGE_HOOK_PROVIDER = "claude-cli";
const CODEX_SYNTHETIC_USAGE_HOOK_PROVIDER = "codex";

function normalizedProviderId(provider?: string): string | undefined {
  const normalized = provider?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizedConcreteHarness(runtime?: string): string | undefined {
  const normalized = runtime?.trim().toLowerCase();
  if (!normalized || normalized === "auto" || normalized === "default") {
    return undefined;
  }
  return normalized;
}

const store = new Map<string, { snapshot: PluginHookReplyUsageState; expiresAt: number }>();

export function buildReplyUsageState(params: {
  config: OpenClawConfig;
  provider?: string;
  model?: string;
  fallbackExhausted?: boolean;
  winnerProvider?: string;
  winnerModel?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  fallbackUsed?: boolean;
  agentId: string;
  sessionId: string;
  chatType?: string;
  authMode?: string;
  overrideSource?: string;
  requestedProvider?: string;
  requestedModel?: string;
  compactionCount?: number;
  cwd?: string;
  contextTokenBudget?: number;
  contextUsedTokens?: number;
  providerUsageWindows?: UsageWindow[];
  promptTokens?: number;
  usage?: NormalizedUsage;
  lastCallUsage?: NormalizedUsage;
  durationMs?: number;
}): PluginHookReplyUsageState {
  const resolvedProvider = params.fallbackExhausted ? undefined : params.winnerProvider;
  const resolvedModel = params.fallbackExhausted ? undefined : params.winnerModel;
  const hasBillableUsageBuckets =
    params.usage &&
    (params.usage.input !== undefined ||
      params.usage.output !== undefined ||
      params.usage.cacheRead !== undefined ||
      params.usage.cacheWrite !== undefined);
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
    turnUsd: hasBillableUsageBuckets
      ? estimateUsageCost({
          usage: params.usage,
          cost: resolveModelCostConfig({
            provider: params.provider,
            model: params.model,
            config: params.config,
          }),
        })
      : undefined,
    durationMs: params.durationMs,
    cwd: params.cwd,
    identity: resolveAgentIdentity(params.config, params.agentId),
    compactionCount: params.compactionCount,
    contextTokenBudget:
      typeof params.contextTokenBudget === "number" && Number.isFinite(params.contextTokenBudget)
        ? params.contextTokenBudget
        : undefined,
    contextUsedTokens:
      typeof params.contextUsedTokens === "number" && Number.isFinite(params.contextUsedTokens)
        ? params.contextUsedTokens
        : deriveContextPromptTokens({
            lastCallUsage: params.lastCallUsage,
            promptTokens: params.promptTokens,
            usage: params.usage,
          }),
    providerUsageWindows: params.providerUsageWindows,
    usage: params.usage
      ? {
          input: params.usage.input,
          output: params.usage.output,
          cacheRead: params.usage.cacheRead,
          cacheWrite: params.usage.cacheWrite,
          total: params.usage.total,
        }
      : undefined,
    lastUsage: params.lastCallUsage
      ? {
          input: params.lastCallUsage.input,
          output: params.lastCallUsage.output,
          cacheRead: params.lastCallUsage.cacheRead,
          cacheWrite: params.lastCallUsage.cacheWrite,
          total: params.lastCallUsage.total,
        }
      : undefined,
  };
}

function shouldUseClaudeCliSyntheticUsageForRuntime(params: {
  provider?: string;
  effectiveHarness?: string;
}): boolean {
  const provider = params.provider?.trim().toLowerCase();
  const harness = params.effectiveHarness?.trim().toLowerCase();
  return (
    provider === CLAUDE_CLI_USAGE_PROVIDER && harness === CLAUDE_CLI_SYNTHETIC_USAGE_HOOK_PROVIDER
  );
}

function buildClaudeCliSyntheticUsageAuth(params: {
  config: OpenClawConfig;
  authProfileId?: string;
  workspaceDir?: string;
}): ProviderAuth | undefined {
  const synthetic = resolveProviderSyntheticAuthWithPlugin({
    provider: CLAUDE_CLI_SYNTHETIC_USAGE_HOOK_PROVIDER,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: process.env,
    context: {
      config: params.config,
      provider: CLAUDE_CLI_SYNTHETIC_USAGE_HOOK_PROVIDER,
    },
  });
  const token = synthetic?.apiKey?.trim();
  if (!token) {
    return undefined;
  }
  return {
    provider: CLAUDE_CLI_USAGE_PROVIDER,
    token,
    ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
    hookProvider: CLAUDE_CLI_SYNTHETIC_USAGE_HOOK_PROVIDER,
  };
}

export async function resolveReplyProviderUsageWindows(params: {
  config: OpenClawConfig;
  provider?: string;
  model?: string;
  authMode?: string;
  agentId?: string;
  sessionKey?: string;
  authProfileId?: string;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<UsageWindow[] | undefined> {
  const normalizedAuthMode = params.authMode?.trim().toLowerCase();
  const requestedCredentialType =
    normalizedAuthMode?.startsWith("api-key") || normalizedAuthMode?.startsWith("api key")
      ? "api_key"
      : normalizedAuthMode?.startsWith("token") || normalizedAuthMode === "auth-profile"
        ? "token"
        : normalizedAuthMode?.startsWith("oauth")
          ? "oauth"
          : params.provider?.trim().toLowerCase() === "openai"
            ? "oauth"
            : undefined;
  try {
    const harnessPolicy =
      params.provider && params.model
        ? resolveAgentHarnessPolicy({
            config: params.config,
            provider: params.provider,
            modelId: params.model,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
          })
        : undefined;
    const normalizedRuntimeProvider = normalizedProviderId(params.provider);
    const effectiveHarness =
      normalizedConcreteHarness(harnessPolicy?.runtime) ??
      (normalizedRuntimeProvider === CLAUDE_CLI_SYNTHETIC_USAGE_HOOK_PROVIDER
        ? CLAUDE_CLI_SYNTHETIC_USAGE_HOOK_PROVIDER
        : normalizedRuntimeProvider === CODEX_SYNTHETIC_USAGE_HOOK_PROVIDER
          ? CODEX_SYNTHETIC_USAGE_HOOK_PROVIDER
        : undefined);
    const useCodexSyntheticUsage =
      shouldUseCodexSyntheticUsageForRuntime({
        provider: params.provider,
        effectiveHarness,
      });
    const useClaudeCliRuntime =
      effectiveHarness === CLAUDE_CLI_SYNTHETIC_USAGE_HOOK_PROVIDER;
    const credentialType =
      useCodexSyntheticUsage || useClaudeCliRuntime ? "token" : requestedCredentialType;
    const usageProvider = resolveUsageProviderId(params.provider, { credentialType });
    if (!usageProvider) {
      return undefined;
    }
    const useClaudeCliSyntheticUsage =
      credentialType !== "api_key" &&
      shouldUseClaudeCliSyntheticUsageForRuntime({
        provider: usageProvider,
        effectiveHarness,
      });
    const syntheticAuth = useCodexSyntheticUsage
      ? buildCodexSyntheticUsageAuth({ authProfileId: params.authProfileId })
      : useClaudeCliSyntheticUsage
        ? buildClaudeCliSyntheticUsageAuth({
            config: params.config,
            authProfileId: params.authProfileId,
            workspaceDir: params.workspaceDir,
          })
        : undefined;
    const summary = await loadProviderUsageSummary({
      config: params.config,
      providers: [usageProvider],
      auth: syntheticAuth ? [syntheticAuth] : undefined,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      timeoutMs: useCodexSyntheticUsage
        ? REPLY_CODEX_SYNTHETIC_USAGE_TIMEOUT_MS
        : useClaudeCliSyntheticUsage
          ? REPLY_CLAUDE_CLI_SYNTHETIC_USAGE_TIMEOUT_MS
        : REPLY_PROVIDER_USAGE_TIMEOUT_MS,
      skipPluginAuthWithoutCredentialSource: syntheticAuth ? undefined : true,
    });
    const provider = summary.providers.find((entry) => entry.provider === usageProvider);
    return provider && !provider.error && provider.windows.length > 0
      ? provider.windows
      : undefined;
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

export function clearReplyUsageStateForTest(): void {
  store.clear();
}
