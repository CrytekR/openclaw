import { describe, expect, it } from "vitest";
import {
  buildCompactionAgentEventData,
  createCompactionNoticePayload,
  formatCompactionNoticeText,
  formatCompactionTriggerReason,
  formatProjectedTokenExpression,
  readCompactionTriggerDetails,
  resolveProjectedTokenProjection,
} from "./compaction-notice.js";

describe("compaction notice trigger details", () => {
  it("formats token-budget reasons with projected token breakdown", () => {
    expect(
      formatCompactionTriggerReason({
        trigger: "tokens",
        projectedTokens: 176_000,
        threshold: 176_000,
        projectedBreakdown: {
          source: "fresh_persisted",
          baseTokens: 160_000,
          lastOutputTokens: 12_000,
          promptEstimateTokens: 4_000,
        },
      }),
    ).toBe(
      "token budget: projected 176k = 160k context meter + 12k previous reply + 4k this message ≥ 176k",
    );
    expect(
      formatCompactionNoticeText("start", {
        trigger: "tokens",
        projectedTokens: 180_500,
        threshold: 176_000,
        projectedBreakdown: {
          source: "transcript_usage",
          baseTokens: 170_000,
          lastOutputTokens: 10_000,
          promptEstimateTokens: 500,
        },
      }),
    ).toBe(
      "🧹 Compacting context (token budget: projected 181k = 170k chat-log recount + 10k previous reply + 500 this message ≥ 176k)...",
    );
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
      projectedBreakdown: {
        source: "transcript_usage",
        baseTokens: 10_000,
        lastOutputTokens: 2_000,
        promptEstimateTokens: 345,
      },
    });
    expect(data).toMatchObject({
      phase: "start",
      trigger: "tokens",
      reason: "threshold",
      projectedTokens: 12_345,
      threshold: 10_000,
      projectedBreakdown: {
        source: "transcript_usage",
        baseTokens: 10_000,
        lastOutputTokens: 2_000,
        promptEstimateTokens: 345,
      },
      reasonText:
        "token budget: projected 12k = 10k chat-log recount + 2k previous reply + 345 this message ≥ 10k",
    });
    expect(readCompactionTriggerDetails(data)).toEqual({
      trigger: "tokens",
      reason: "threshold",
      projectedTokens: 12_345,
      threshold: 10_000,
      projectedBreakdown: {
        source: "transcript_usage",
        baseTokens: 10_000,
        lastOutputTokens: 2_000,
        promptEstimateTokens: 345,
      },
    });
  });

  it("selects the winning projected-token candidate and expression", () => {
    expect(
      resolveProjectedTokenProjection({
        transcriptPromptTokens: 100_000,
        transcriptOutputTokens: 5_000,
        freshPersistedTokens: 90_000,
        persistedPromptTokens: 80_000,
        promptEstimateTokens: 2_000,
      }),
    ).toEqual({
      projectedTokens: 107_000,
      breakdown: {
        source: "transcript_usage",
        baseTokens: 100_000,
        lastOutputTokens: 5_000,
        promptEstimateTokens: 2_000,
      },
    });
    expect(
      formatProjectedTokenExpression({
        projectedTokens: 107_000,
        breakdown: {
          source: "transcript_usage",
          baseTokens: 100_000,
          lastOutputTokens: 5_000,
          promptEstimateTokens: 2_000,
        },
      }),
    ).toBe("107k = 100k chat-log recount + 5k previous reply + 2k this message");
  });

  it("labels base-only projections with a plain-language source", () => {
    expect(
      formatProjectedTokenExpression({
        projectedTokens: 160_000,
        breakdown: {
          source: "fresh_persisted",
          baseTokens: 160_000,
        },
      }),
    ).toBe("160k (160k context meter)");
    expect(
      formatProjectedTokenExpression({
        projectedTokens: 150_000,
        breakdown: {
          source: "persisted",
          baseTokens: 150_000,
        },
      }),
    ).toBe("150k (150k saved context floor)");
  });

  it("keeps legacy notice text when no details are provided", () => {
    expect(createCompactionNoticePayload({ phase: "start" }).text).toBe("🧹 Compacting context...");
  });
});
