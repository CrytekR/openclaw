import { describe, expect, it } from "vitest";
import {
  buildCompactionAgentEventData,
  createCompactionNoticePayload,
  formatCompactionNoticeText,
  formatCompactionTriggerReason,
  readCompactionTriggerDetails,
} from "./compaction-notice.js";

describe("compaction notice trigger details", () => {
  it("formats token-budget reasons with projected tokens", () => {
    expect(
      formatCompactionTriggerReason({
        trigger: "tokens",
        projectedTokens: 176_000,
        threshold: 176_000,
      }),
    ).toBe("token budget: projected 176k ≥ 176k");
    expect(
      formatCompactionNoticeText("start", {
        trigger: "tokens",
        projectedTokens: 180_500,
        threshold: 176_000,
      }),
    ).toBe("🧹 Compacting context (token budget: projected 181k ≥ 176k)...");
  });

  it("formats transcript-byte reasons", () => {
    expect(
      formatCompactionTriggerReason({
        trigger: "transcript_bytes",
        activeTranscriptBytes: 20_000_000,
        maxActiveTranscriptBytes: 20_000_000,
      }),
    ).toBe("transcript size limit: 20.0MB ≥ 20.0MB");
  });

  it("builds agent-event payloads and round-trips details", () => {
    const data = buildCompactionAgentEventData("start", {
      trigger: "tokens",
      reason: "threshold",
      projectedTokens: 12_345,
      threshold: 10_000,
    });
    expect(data).toMatchObject({
      phase: "start",
      trigger: "tokens",
      reason: "threshold",
      projectedTokens: 12_345,
      threshold: 10_000,
      reasonText: "token budget: projected 12k ≥ 10k",
    });
    expect(readCompactionTriggerDetails(data)).toEqual({
      trigger: "tokens",
      reason: "threshold",
      projectedTokens: 12_345,
      threshold: 10_000,
    });
  });

  it("keeps legacy notice text when no details are provided", () => {
    expect(createCompactionNoticePayload({ phase: "start" }).text).toBe("🧹 Compacting context...");
  });
});
