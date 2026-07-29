import { describe, expect, it } from "vitest";
import {
  buildCompactionAgentEventData,
  createCompactionNoticePayload,
  formatCompactionNoticeText,
  formatCompactionTriggerReason,
  mergeCompactionReasonTextIntoDetails,
  resolveCompactionPersistReasonText,
} from "./compaction-notice.js";

describe("compaction notice trigger details (2026.6.11)", () => {
  it("formats token-budget and transcript-size reasons", () => {
    expect(
      formatCompactionTriggerReason({
        trigger: "tokens",
        projectedTokens: 176_000,
        threshold: 160_000,
      }),
    ).toBe("token budget: projected 176k ≥ 160k");
    expect(
      formatCompactionTriggerReason({
        trigger: "transcript_bytes",
        activeTranscriptBytes: 20_000_000,
        maxActiveTranscriptBytes: 20_000_000,
      }),
    ).toBe("transcript size limit: 20.0MB ≥ 20.0MB");
    expect(
      formatCompactionNoticeText("start", {
        trigger: "tokens",
        projectedTokens: 180_500,
        threshold: 176_000,
      }),
    ).toBe("🧹 Compacting context (token budget: projected 181k ≥ 176k)...");
  });

  it("builds agent-event payloads with reasonText", () => {
    expect(
      buildCompactionAgentEventData("start", {
        trigger: "tokens",
        reason: "threshold",
        projectedTokens: 12_345,
        threshold: 10_000,
      }),
    ).toMatchObject({
      phase: "start",
      trigger: "tokens",
      reason: "threshold",
      projectedTokens: 12_345,
      threshold: 10_000,
      reasonText: "token budget: projected 12k ≥ 10k",
    });
  });

  it("merges durable reasonText and resolves persist labels", () => {
    expect(mergeCompactionReasonTextIntoDetails({ readFiles: ["a.ts"] }, "token budget")).toEqual({
      readFiles: ["a.ts"],
      reasonText: "token budget",
    });
    expect(resolveCompactionPersistReasonText({ trigger: "overflow" })).toBe("context overflow");
    expect(
      resolveCompactionPersistReasonText({
        reasonText: "token budget: projected 10k ≥ 9k",
        trigger: "manual",
      }),
    ).toBe("token budget: projected 10k ≥ 9k");
    expect(createCompactionNoticePayload({ phase: "end" }).text).toBe("🧹 Compaction complete");
  });
});
