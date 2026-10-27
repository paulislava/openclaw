/**
 * Skill Workshop proposal decision helpers.
 *
 * A pending proposal is surfaced with Apply/Reject controls so the decision can
 * be taken straight from chat. Both the inline buttons and the `/proposal`
 * command share the compact handle + command text built here.
 */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MessagePresentation } from "../../interactive/payload.js";
import { listWorkshopDrafts, type WorkshopDraft } from "./drafts.js";

export type SkillProposalDecision = "apply" | "reject";

export const SKILL_PROPOSAL_COMMAND = "/proposal";

const SKILL_PROPOSAL_COMMAND_REGEX = /^\/?proposal(?:@[^\s]+)?(?:\s|$)/i;

const DECISION_ALIASES: Record<string, SkillProposalDecision> = {
  apply: "apply",
  accept: "apply",
  approve: "apply",
  allow: "apply",
  yes: "apply",
  reject: "reject",
  decline: "reject",
  deny: "reject",
  discard: "reject",
  no: "reject",
};

export const SKILL_PROPOSAL_COMMAND_USAGE =
  "Usage: /proposal <apply|reject> <proposal id> (see the pending proposal message for the id)";

/**
 * Compact handle for a proposal id. Proposal ids embed the skill name and can
 * exceed Telegram's 64-byte callback_data budget, so buttons carry the trailing
 * random segment instead.
 */
export function buildSkillProposalHandle(proposalId: string): string {
  const normalized = normalizeOptionalString(proposalId) ?? "";
  const lastSegment = normalized.slice(normalized.lastIndexOf("-") + 1);
  return lastSegment || normalized.slice(0, 24);
}

export function buildSkillProposalDecisionCommandText(params: {
  proposalId: string;
  decision: SkillProposalDecision;
}): string {
  return `${SKILL_PROPOSAL_COMMAND} ${params.decision} ${buildSkillProposalHandle(params.proposalId)}`;
}

export type ParsedSkillProposalDecisionCommand =
  | { ok: true; handle: string; decision: SkillProposalDecision }
  | { ok: false; error: string };

/** Parses `/proposal apply <handle>` (either argument order). */
export function parseSkillProposalDecisionCommandText(
  raw: string,
): ParsedSkillProposalDecisionCommand | null {
  const trimmed = raw.trim();
  const commandMatch = trimmed.match(SKILL_PROPOSAL_COMMAND_REGEX);
  if (!commandMatch) {
    return null;
  }
  const tokens = trimmed.slice(commandMatch[0].length).trim().split(/\s+/).filter(Boolean);
  const [firstToken, secondToken] = tokens;
  if (!firstToken || !secondToken) {
    return { ok: false, error: SKILL_PROPOSAL_COMMAND_USAGE };
  }
  const first = normalizeOptionalLowercaseString(firstToken) ?? "";
  const second = normalizeOptionalLowercaseString(secondToken) ?? "";
  if (DECISION_ALIASES[first]) {
    return { ok: true, decision: DECISION_ALIASES[first], handle: secondToken };
  }
  if (DECISION_ALIASES[second]) {
    return { ok: true, decision: DECISION_ALIASES[second], handle: firstToken };
  }
  return { ok: false, error: SKILL_PROPOSAL_COMMAND_USAGE };
}

/** Build the portable Apply/Reject controls for a pending proposal. */
export function buildSkillProposalDecisionPresentation(params: {
  proposalId: string;
}): MessagePresentation {
  const applyCommand = buildSkillProposalDecisionCommandText({
    proposalId: params.proposalId,
    decision: "apply",
  });
  const rejectCommand = buildSkillProposalDecisionCommandText({
    proposalId: params.proposalId,
    decision: "reject",
  });
  return {
    blocks: [
      {
        type: "buttons",
        buttons: [
          {
            label: "✅ Apply",
            action: { type: "command", command: applyCommand },
            value: applyCommand,
            style: "success",
          },
          {
            label: "❌ Reject",
            action: { type: "command", command: rejectCommand },
            value: rejectCommand,
            style: "danger",
          },
        ],
      },
    ],
  };
}

/** Resolve a proposal from a button handle or a full proposal id. */
export async function resolveSkillProposalByHandle(params: {
  handle: string;
  config: OpenClawConfig;
  agentId: string;
}): Promise<WorkshopDraft | undefined> {
  const handle = normalizeOptionalString(params.handle);
  if (!handle) {
    return undefined;
  }
  const drafts = await listWorkshopDrafts(params.config, params.agentId);
  const matches = drafts.filter(
    (draft) => draft.id === handle || buildSkillProposalHandle(draft.id) === handle,
  );
  // A short handle must identify exactly one pending draft.
  return matches.length === 1 ? matches[0] : undefined;
}

export type SkillProposalDecisionPrompt = {
  proposalId: string;
  skillKey: string;
  kind: "create" | "update";
  title?: string;
  scanState?: string;
};

/** Build the deterministic pending-proposal message that carries the decision buttons. */
export function buildSkillProposalDecisionReplyPayload(prompt: SkillProposalDecisionPrompt): {
  text: string;
  presentation: MessagePresentation;
} {
  const headline =
    prompt.kind === "update"
      ? `Skill update proposal pending for ${prompt.skillKey}.`
      : `New skill proposal pending for ${prompt.skillKey}.`;
  const lines = [headline];
  const title = normalizeOptionalString(prompt.title);
  if (title) {
    lines.push(title);
  }
  if (prompt.scanState && prompt.scanState !== "clean") {
    lines.push(`Security scan: ${prompt.scanState}.`);
  }
  lines.push(
    `Apply it into live workspace skills, or reject it.\nProposal id: \`${prompt.proposalId}\``,
  );
  return {
    text: lines.join("\n\n"),
    presentation: buildSkillProposalDecisionPresentation({ proposalId: prompt.proposalId }),
  };
}

/** Read the pending-proposal decision prompt emitted by the skill_workshop tool. */
export function readSkillProposalDecisionPrompt(
  result: unknown,
): SkillProposalDecisionPrompt | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const outer = result as Record<string, unknown>;
  const details =
    outer.details && typeof outer.details === "object" && !Array.isArray(outer.details)
      ? (outer.details as Record<string, unknown>)
      : outer;
  const prompt = details.proposalDecision;
  if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) {
    return null;
  }
  const record = prompt as Record<string, unknown>;
  const proposalId = normalizeOptionalString(record.proposalId);
  const skillKey = normalizeOptionalString(record.skillKey);
  if (!proposalId || !skillKey) {
    return null;
  }
  return {
    proposalId,
    skillKey,
    kind: record.kind === "update" ? "update" : "create",
    title: normalizeOptionalString(record.title),
    scanState: normalizeOptionalString(record.scanState),
  };
}
