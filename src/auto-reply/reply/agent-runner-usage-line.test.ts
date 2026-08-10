// Tests usage-line formatting for agent runner completion summaries.
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import {
  appendUsageLine,
  appendUsageLineForDelivery,
  resolveResponseUsageLine,
} from "./agent-runner-usage-line.js";

describe("appendUsageLine", () => {
  it("preserves reply payload metadata when appending usage text", () => {
    const payload = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          agentId: "main",
          text: "message tool reply",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );

    const [updated] = appendUsageLine([payload], "Usage: 12 in / 3 out");

    expect(updated).toEqual({ text: "message tool reply\nUsage: 12 in / 3 out" });
    expect(getReplyPayloadMetadata(updated)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main:telegram:direct:123",
        idempotencyKey: "run-1:internal-source-reply:0",
        text: "message tool reply\nUsage: 12 in / 3 out",
      },
    });
  });

  it("keeps usage deliverable when the only text payload is a source reply mirror", () => {
    const payload = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          agentId: "main",
          text: "message tool reply",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );

    const result = appendUsageLineForDelivery([payload], "Usage: 12 in / 3 out");

    expect(result).toEqual([
      { text: "message tool reply" },
      { text: "Usage: 12 in / 3 out", isStatusNotice: true },
    ]);
    expect(getReplyPayloadMetadata(result[0])?.sourceReplyTranscriptMirror).toMatchObject({
      idempotencyKey: "run-1:internal-source-reply:0",
      text: "message tool reply",
    });
    expect(getReplyPayloadMetadata(result[1])?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(getReplyPayloadMetadata(result[1])?.responseUsageFooter).toBe(true);
    expect(getReplyPayloadMetadata(result[1])?.sourceReplyTranscriptMirror).toBeUndefined();
  });

  it("appends usage to the latest non-mirror payload when one exists", () => {
    const mirror = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          text: "message tool reply",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );
    const status = setReplyPayloadMetadata(
      { text: "status" },
      {
        deliverDespiteSourceReplySuppression: true,
      },
    );

    const result = appendUsageLineForDelivery([mirror, status], "Usage: 12 in / 3 out");

    expect(result.map((payload) => payload.text)).toEqual([
      "message tool reply",
      "status\nUsage: 12 in / 3 out",
    ]);
    expect(getReplyPayloadMetadata(result[1])?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(getReplyPayloadMetadata(result[1])?.sourceReplyTranscriptMirror).toBeUndefined();
  });

  it("does not append usage to a suppressed non-mirror payload", () => {
    const mirror = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          text: "message tool reply",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );

    const result = appendUsageLineForDelivery(
      [mirror, { text: "suppressed assistant text" }],
      "Usage: 12 in / 3 out",
    );

    expect(result.map((payload) => payload.text)).toEqual([
      "message tool reply",
      "suppressed assistant text",
      "Usage: 12 in / 3 out",
    ]);
    expect(getReplyPayloadMetadata(result[2])?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(getReplyPayloadMetadata(result[2])?.responseUsageFooter).toBe(true);
    expect(getReplyPayloadMetadata(result[2])?.sourceReplyTranscriptMirror).toBeUndefined();
  });
});

describe("resolveResponseUsageLine", () => {
  it("renders full usage state even when turn usage buckets are empty", () => {
    const line = resolveResponseUsageLine({
      config: { messages: { responseUsage: "full" } },
      sessionRaw: undefined,
      channel: "telegram",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      provider: "openai",
      model: "gpt-5.5",
      replyUsageState: {
        provider: "openai",
        model: "gpt-5.5",
        reasoningEffort: "medium",
        fastMode: false,
        agentId: "openclaw",
        sessionId: "session",
        cwd: "/Users/pkondratov/openclaw",
        contextTokenBudget: 272000,
        contextUsedTokens: 68000,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });

    expect(line).toContain("openai🤖 gpt5.5");
    expect(line).toContain("📂openclaw");
    expect(line).toContain("win 272k");
    expect(line).not.toContain("↕️");
  });

  it("keeps token-only response usage hidden when turn usage buckets are empty", () => {
    expect(
      resolveResponseUsageLine({
        config: { messages: { responseUsage: "tokens" } },
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).toBeUndefined();
  });
});
