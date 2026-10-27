import { afterEach, beforeEach, expect, it } from "vitest";
import { saveWorkshopDraft, listWorkshopDrafts } from "../../skills/workshop/drafts.js";
import { viewWorkshopSkill } from "../../skills/workshop/library.js";
import { buildSkillProposalHandle } from "../../skills/workshop/proposal-decision.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { handleProposalCommand } from "./commands-proposal.js";
import { buildSessionCommandTestParams } from "./commands-session-params.test-support.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
});
afterEach(async () => {
  await state.cleanup();
});

function command(text: string, owner = true) {
  return buildSessionCommandTestParams({
    surface: "telegram",
    channel: "telegram",
    ownerList: [],
    senderIsOwner: owner,
    isAuthorizedSender: true,
    senderId: "123",
    rawBodyNormalized: text,
    commandBodyNormalized: text,
  });
}

it("applies and rejects drafts through the exact chat decision without another model turn", async () => {
  const content = "---\nname: deploy\ndescription: Deploy staging\n---\n\n1. Run make ship.\n";
  const id = await saveWorkshopDraft({}, "main", { name: "deploy", content });
  const applied = await handleProposalCommand(
    command(`/proposal apply ${buildSkillProposalHandle(id)}`),
    true,
  );
  expect(applied?.shouldContinue).toBe(false);
  expect(applied?.reply?.text).toContain("Applied");
  expect((await viewWorkshopSkill({}, "main", "deploy")).content).toBe(content);
  expect(await listWorkshopDrafts({}, "main")).toEqual([]);

  const rejected = await saveWorkshopDraft({}, "main", {
    name: "deploy",
    content: content.replace("ship", "delete"),
  });
  expect(
    (await handleProposalCommand(command(`/proposal reject ${rejected}`), true))?.reply?.text,
  ).toContain("Rejected");
  expect((await viewWorkshopSkill({}, "main", "deploy")).content).toBe(content);
  expect(await listWorkshopDrafts({}, "main")).toEqual([]);
});

it("leaves a draft unchanged when an authorized sender is not the owner", async () => {
  const id = await saveWorkshopDraft({}, "main", {
    name: "deploy",
    content: "---\nname: deploy\ndescription: Deploy staging\n---\n\n1. Run make ship.\n",
  });
  await handleProposalCommand(command(`/proposal reject ${id}`, false), true);
  expect((await listWorkshopDrafts({}, "main")).map((draft) => draft.id)).toEqual([id]);
});
