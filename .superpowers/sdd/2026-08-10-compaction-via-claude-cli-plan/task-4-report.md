# Task 4 report — Routing claude-cli compaction into `compactViaClaudeCli`

STATUS: DONE

## Read-first findings

### Is `isCliRuntimeProvider` claude-specific or generic?
GENERIC. `src/agents/model-runtime-aliases.ts:18` `isCliRuntimeProvider` delegates to
`listCliRuntimeProviderIds` (`cli-backends.ts:230`), which returns EVERY registered CLI runtime
alias id — `claude-cli` AND `google-gemini-cli` (both present in the test fixture
`selection.test.ts:75-88`, and both real bundled backends). Likewise
`isCliRuntimeAliasForProvider` (`model-runtime-aliases.ts:38`) matches any provider→runtime binding,
not just Claude. So neither gate is Claude-specific; unconditionally routing all of them to
`compactViaClaudeCli` would have broken `google-gemini-cli` (and any future CLI runtime). The gate
therefore had to be narrowed to the **claude-cli** runtime id specifically, preserving `return
undefined` (embedded bail) for every other CLI runtime.

The canonical "this is Claude CLI" identifier is the CLI backend id string `claude-cli`
(`compact-cli.ts` already held it as the private `CLAUDE_CLI_PROVIDER`; there are ~15 other sites
comparing `normalizeProviderId(x) === "claude-cli"`). I exported that constant and reused it.

## The exact gate change (`src/agents/harness/compaction.ts`)

Added imports:
```ts
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { CLAUDE_CLI_PROVIDER, compactViaClaudeCli } from "../cli-runner/compact-cli.js";
```
Added a local predicate:
```ts
function isClaudeCliRuntimeId(id: string | undefined): boolean {
  return normalizeProviderId(id ?? "") === CLAUDE_CLI_PROVIDER;
}
```
Gate 1 (provider-alias gate, was line 115):
```ts
if (params.provider && isCliRuntimeProvider(params.provider, { config: params.config })) {
  // claude-cli summarizes AND persists through its own one-shot CLI path; every
  // other CLI runtime still bails to the embedded summarizer.
  return isClaudeCliRuntimeId(params.provider) ? await compactViaClaudeCli(params) : undefined;
}
```
Gate 2 (resolved-runtime gate, was line 130):
```ts
if (isCliRuntimeAliasForProvider({ runtime, provider: params.provider, cfg: params.config })) {
  // Same split as the provider-alias gate above: only the claude-cli backend
  // owns a CLI compaction path; other CLI runtimes fall through to embedded.
  return isClaudeCliRuntimeId(runtime) ? await compactViaClaudeCli(params) : undefined;
}
```
No new config surface — pure auto-detection off the already-resolved provider/runtime. Other CLI
runtimes keep the EXACT prior behavior (`return undefined`).

## How the doc/behavior mismatch was resolved

Task 2 shipped `compactViaClaudeCli` with JSDoc + a `| undefined` return type claiming it "returns
undefined only when the provider is not a Claude CLI backend" — but no such provider check ever
existed in `compact-cli.ts`, and no code path in it returns `undefined` (all branches return a
concrete `EmbeddedAgentCompactResult`: `nothingToCompact()`, the empty-summary failure, or
`persistCompactionSummary`).

Resolution chosen (least redundant code, honest contract): make `compaction.ts` the SOLE gatekeeper.
`compactViaClaudeCli` is now only ever called once the runtime is already known to be claude-cli, so:
- Dropped `| undefined` from its return type → `Promise<EmbeddedAgentCompactResult>`.
- Rewrote the JSDoc to state that `maybeCompactAgentHarnessSession` is the sole gatekeeper and this
  function always returns a concrete result (failures propagate, never silently re-route to embedded).

No defensive in-function provider re-check was added — it would be dead code given the gate, and the
repo guide explicitly disfavors defensive branches for states the caller already guarantees.

## Harness-failure → fallback interop (confirmed, no new plumbing)

Traced all three consumers of `maybeCompactAgentHarnessSession`'s return value:

- `compact.queued.ts:311` → result is truthy → `shouldFallbackAfterHarnessCompaction(harnessResult)`
  (`:66`) = `isRecoverableNativeHarnessBindingFailure` (`harness/compaction-recovery.ts:24`). A
  `{ok:false, reason:"claude-cli compaction produced no summary text"}` is NOT a recoverable binding
  reason (those are `missing_thread_binding`/`stale_thread_binding`/"thread not found"/"no thread
  binding"), so `shouldFallback` is false → the failure result is returned directly. NOT swallowed,
  does NOT fall through to embedded/context-engine.
- `compact.queued.ts:559` (secondary `after_context_engine` path) — unaffected; that path requires
  `internalHarness.compactAfterContextEngine`, and the CLI gates return before harness selection.
- `command/cli-compaction.ts:406` → `!result?.compacted` true, reason is neither a below-target skip
  (`isBelowCompactionTargetReason`) nor an intentional auto-compaction skip nor a recoverable binding
  failure → propagates as a genuine failure outcome. Correct.

A successful `{ok:true, compacted:true, result:{...}}` from `compactViaClaudeCli` returns straight
through all three callers unchanged (Task 3 already produces the fully-populated shape including
rotated `sessionId`/`sessionFile`). No Task-1b fallback plumbing changes were needed.

## Tests (red → green)

New home: `src/agents/harness/selection.test.ts` (already tests `maybeCompactAgentHarnessSession`
with both `claude-cli` and `google-gemini-cli` fixtures — no new `compaction.test.ts` sibling was
needed). Added a hoisted `vi.mock("../cli-runner/compact-cli.js", ...)` exporting a mocked
`compactViaClaudeCli` (+ the `CLAUDE_CLI_PROVIDER` const the module now exports).

- Rewrote the two prior "skips … for claude-cli" tests (which asserted `undefined`) to assert the CLI
  result is returned and `compactViaClaudeCli` was called once — for both the model-runtime config
  (`anthropic` + runtime `claude-cli`) and the provider-alias config (`claude-cli`).
- Added a failure-propagation test: `{ok:false,...}` from the CLI is returned as-is.
- Added two negative tests proving a NON-Claude CLI runtime is unchanged: `google/gemini-3-pro-preview`
  with runtime `google-gemini-cli`, and the `google-gemini-cli` provider alias — both resolve to
  `undefined` and `compactViaClaudeCli` is NOT called.

RED (before impl):
```
Tests  3 failed | 56 passed (59)   # 3 claude-cli tests got undefined; both gemini negatives passed
```
GREEN (after impl), plus regression suites:
```
node scripts/run-vitest.mjs src/agents/harness/selection.test.ts src/agents/cli-runner/compact-cli.test.ts
  Test Files  2 passed (2)   Tests  65 passed (65)
node scripts/run-vitest.mjs src/agents/command/cli-compaction.test.ts src/agents/embedded-agent-runner/compact.hooks.test.ts
  Test Files  2 passed (2)   Tests  88 passed (88)
```
Typecheck of touched files: `npx tsgo --noEmit` reports ZERO errors mentioning
`harness/compaction.ts`, `cli-runner/compact-cli.ts`, or `selection.test.ts`. (Pre-existing baseline
errors in `extensions/telegram/**`, `command/delivery.test.ts`, `main-session-restart-recovery.ts`
are unrelated and untouched.)

Note: did NOT extend `run.overflow-compaction.test.ts` — it is a 2705-line high-level
`runEmbeddedAgent` suite that does not call `maybeCompactAgentHarnessSession` directly; the focused
routing test in `selection.test.ts` is the precise, low-cost proof the brief asked for.

## Files

- `src/agents/harness/compaction.ts` — narrowed both CLI gates to route claude-cli to
  `compactViaClaudeCli`; added `isClaudeCliRuntimeId` helper + imports.
- `src/agents/cli-runner/compact-cli.ts` — exported `CLAUDE_CLI_PROVIDER`; tightened
  `compactViaClaudeCli` return type to non-undefined; corrected the JSDoc contract.
- `src/agents/harness/selection.test.ts` — mock + 5 routing tests (2 rewritten, 3 added).

## Import-cycle / architecture check

`harness/compaction.ts` → `cli-runner/compact-cli.ts` is a new edge; verified `compact-cli.ts` and
its runtime deps do NOT import back from `harness/**`, so no cycle is introduced.

## git status cleanliness

`git status --short` shows ONLY the 3 intended files modified:
```
 M src/agents/cli-runner/compact-cli.ts
 M src/agents/harness/compaction.ts
 M src/agents/harness/selection.test.ts
```
The untracked `openclaw.json.bak.*` and `skills/nosmoke-push/` entries are pre-existing and unrelated;
they were NOT created by this task and are NOT staged (committer takes an explicit file list).

## Concerns

- The claude-cli compaction path is now REACHED for the first time in production routing. Runtime
  wiring is fully proven under mock (`compact-cli.test.ts` covers the real persistence tail from
  Tasks 2/3), but there is no live end-to-end CLI run in this task's scope. Per AGENTS.md this is a
  compatibility/upgrade-sensitive harness-routing change; a Crabbox live claude-cli compaction smoke
  before landing would fully close the gap.
- `isClaudeCliRuntimeId` compares against the backend id string `claude-cli` via `normalizeProviderId`
  (the repo's canonical identity for this backend, matching ~15 other sites). If the Claude CLI
  backend id ever changes, this and those sites move together.

## Commit

<COMMIT_HASH_PLACEHOLDER>
