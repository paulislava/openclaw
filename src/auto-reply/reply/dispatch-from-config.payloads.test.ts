import { expect, it } from "vitest";
import {
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import { appendUsageLine } from "./agent-runner-usage-line.js";
import { shouldDeliverDespiteSourceReplySuppression } from "./dispatch-from-config.payloads.js";

const roomState = {
  ctx: { InboundEventKind: "room_event" as const },
  explicitCommandTurnCtx: false,
  suppressAutomaticSourceDelivery: true,
  sendPolicyDenied: false,
};

it("delivers the host usage footer after a completed room reply", () => {
  const [footer] = appendUsageLine([], "Usage: 1.3k total", { completedSourceReply: true });
  expect(footer).toBeDefined();
  expect(shouldDeliverDespiteSourceReplySuppression(footer!, roomState)).toBe(true);
  expect(
    shouldDeliverDespiteSourceReplySuppression(footer!, { ...roomState, sendPolicyDenied: true }),
  ).toBe(false);
});

it("does not grant ordinary room notices or model text the usage footer exemption", () => {
  const notice = markReplyPayloadForSourceSuppressionDelivery({
    text: "Still working",
    isStatusNotice: true,
  });
  expect(shouldDeliverDespiteSourceReplySuppression(notice, roomState)).toBe(false);
  setReplyPayloadMetadata(notice, { responseUsageLine: "Usage: 1.3k total" });
  expect(shouldDeliverDespiteSourceReplySuppression(notice, roomState)).toBe(false);
});
