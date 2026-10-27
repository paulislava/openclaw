import { formatErrorMessage } from "../../infra/errors.js";
import { applyWorkshopDraft, discardWorkshopDraft } from "../../skills/workshop/drafts.js";
import {
  parseSkillProposalDecisionCommandText,
  resolveSkillProposalByHandle,
} from "../../skills/workshop/proposal-decision.js";
import {
  commandReply,
  defineAuthorizedTextCommand,
  requireGatewayClientScope,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

export const handleProposalCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/proposal", match: parseSkillProposalDecisionCommandText, ownerOnly: true },
  async (params, parsed) => {
    if (!parsed.ok) {
      return commandReply(parsed.error);
    }
    const missingScope = requireGatewayClientScope(params, {
      label: "/proposal",
      allowedScopes: ["operator.admin"],
      missingText: "❌ /proposal requires operator.admin for gateway clients.",
    });
    if (missingScope) {
      return missingScope;
    }
    try {
      const draft = await resolveSkillProposalByHandle({
        handle: parsed.handle,
        config: params.cfg,
        agentId: params.agentId,
      });
      if (!draft) {
        return commandReply(`❌ No pending skill proposal matched: ${parsed.handle}`);
      }
      const assertLive = params.command.assertOwnerCurrent;
      const context = {
        config: params.cfg,
        agentId: params.agentId,
        actor: "user" as const,
        sessionKey: params.sessionKey,
        ...(assertLive ? { assertLive } : {}),
      };
      if (parsed.decision === "apply") {
        await applyWorkshopDraft(context, draft.id, draft.skillName);
        return commandReply(`✅ Applied skill proposal ${draft.id} to ${draft.skillName}.`);
      }
      await discardWorkshopDraft(params.cfg, params.agentId, draft.id, assertLive);
      return commandReply(`🚫 Rejected skill proposal ${draft.id}.`);
    } catch (error) {
      return commandReply(
        `❌ Failed to ${parsed.decision} skill proposal: ${formatErrorMessage(error)}`,
      );
    }
  },
);
