import { describe, expect, it } from "vitest";
import {
  buildCompactionAgentEventData,
  createCompactionNoticePayload,
  formatCompactionNoticeText,
  formatCompactionTriggerReason,
  formatProjectedTokenExpression,
  mergeCompactionReasonTextIntoDetails,
  resolveCompactionPersistReasonText,
  resolveProjectedTokenProjection,
} from "./compaction-notice.js";

describe("compaction notice trigger details (2026.6.11)", () => {
  it("formats token-budget reasons with projected-token calculation details", () => {
    expect(
      formatCompactionTriggerReason({
        trigger: "tokens",
        projectedTokens: 176_000,
        projectedBreakdown: {
          source: "fresh_persisted",
          baseTokens: 160_000,
          lastOutputTokens: 12_000,
          promptEstimateTokens: 4_000,
        },
        threshold: 160_000,
      }),
    ).toBe(
      "token budget: projected 176k = 160k context meter + 12k previous reply + 4.0k this message ≥ 160k",
    );
    expect(
      formatCompactionTriggerReason({
        trigger: "tokens",
        projectedTokens: 180_000,
        projectedBreakdown: {
          source: "transcript_usage",
          baseTokens: 170_000,
          lastOutputTokens: 8_000,
          promptEstimateTokens: 2_000,
          recountMethod: "model_usage_plus_unread_tail",
        },
        threshold: 160_000,
      }),
    ).toBe(
      "token budget: projected 180k = 170k chat-log recount via model usage + unread tail + 8.0k previous reply + 2.0k this message ≥ 160k",
    );
    expect(
      formatCompactionTriggerReason({
        trigger: "tokens",
        projectedTokens: 150_000,
        projectedBreakdown: {
          source: "persisted",
          baseTokens: 150_000,
        },
        threshold: 140_000,
      }),
    ).toBe("token budget: projected 150k (150k saved context floor) ≥ 140k");
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
        projectedBreakdown: {
          source: "fresh_persisted",
          baseTokens: 176_000,
          lastOutputTokens: 3_000,
          promptEstimateTokens: 1_500,
        },
        threshold: 176_000,
      }),
    ).toBe(
      "🧹 Compacting context (token budget: projected 181k = 176k context meter + 3.0k previous reply + 1.5k this message ≥ 176k)...",
    );
  });

  it("resolves the winning projected-token candidate and additive terms", () => {
    const add = (
      basePromptTokens?: number,
      lastOutputTokens?: number,
      promptTokenEstimate?: number,
    ) =>
      Math.max(0, basePromptTokens ?? 0) +
      Math.max(0, lastOutputTokens ?? 0) +
      Math.max(0, promptTokenEstimate ?? 0);

    expect(
      resolveProjectedTokenProjection({
        transcriptPromptTokens: 100_000,
        transcriptOutputTokens: 5_000,
        transcriptRecountMethod: "last_model_usage",
        freshPersistedTokens: 90_000,
        persistedPromptTokens: 80_000,
        promptEstimateTokens: 2_000,
        resolveEffectivePromptTokens: add,
      }),
    ).toEqual({
      projectedTokens: 107_000,
      breakdown: {
        source: "transcript_usage",
        baseTokens: 100_000,
        lastOutputTokens: 5_000,
        promptEstimateTokens: 2_000,
        recountMethod: "last_model_usage",
      },
    });

    expect(
      resolveProjectedTokenProjection({
        freshPersistedTokens: 160_000,
        persistedPromptTokens: 150_000,
        promptEstimateTokens: 4_000,
        transcriptOutputTokens: 12_000,
        resolveEffectivePromptTokens: add,
      }),
    ).toEqual({
      projectedTokens: 176_000,
      breakdown: {
        source: "fresh_persisted",
        baseTokens: 160_000,
        lastOutputTokens: 12_000,
        promptEstimateTokens: 4_000,
      },
    });

    expect(
      resolveProjectedTokenProjection({
        persistedPromptTokens: 200_000,
        resolveEffectivePromptTokens: add,
      }),
    ).toEqual({
      projectedTokens: 200_000,
      breakdown: {
        source: "persisted",
        baseTokens: 200_000,
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
          recountMethod: "chat_log_file_size",
        },
      }),
    ).toBe(
      "107k = 100k chat-log recount via chat-log size ÷ 4 + 5.0k previous reply + 2.0k this message",
    );
  });

  it("builds agent-event payloads with reasonText and projectedBreakdown", () => {
    expect(
      buildCompactionAgentEventData("start", {
        trigger: "tokens",
        reason: "threshold",
        projectedTokens: 12_345,
        projectedBreakdown: {
          source: "fresh_persisted",
          baseTokens: 10_000,
          lastOutputTokens: 1_500,
          promptEstimateTokens: 845,
        },
        threshold: 10_000,
      }),
    ).toMatchObject({
      phase: "start",
      trigger: "tokens",
      reason: "threshold",
      projectedTokens: 12_345,
      threshold: 10_000,
      projectedBreakdown: {
        source: "fresh_persisted",
        baseTokens: 10_000,
        lastOutputTokens: 1_500,
        promptEstimateTokens: 845,
      },
      reasonText:
        "token budget: projected 12k = 10k context meter + 1.5k previous reply + 845 this message ≥ 10k",
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
        reasonText:
          "token budget: projected 176k = 160k context meter + 12k previous reply + 4.0k this message ≥ 160k",
        trigger: "manual",
      }),
    ).toBe(
      "token budget: projected 176k = 160k context meter + 12k previous reply + 4.0k this message ≥ 160k",
    );
    expect(resolveCompactionPersistReasonText({ trigger: "timeout_recovery" })).toBe(
      "timeout recovery",
    );
    expect(resolveCompactionPersistReasonText({ trigger: "cli_budget" })).toBe(
      "CLI context budget",
    );
    expect(createCompactionNoticePayload({ phase: "end" }).text).toBe("🧹 Compaction complete");
  });

  it("formats overflow, timeout recovery, and CLI budget trigger reasons", () => {
    expect(
      formatCompactionTriggerReason({
        trigger: "overflow",
        projectedTokens: 210_000,
        threshold: 200_000,
      }),
    ).toBe("context overflow: ~210k ≥ 200k context");
    expect(
      formatCompactionTriggerReason({
        trigger: "timeout_recovery",
        projectedTokens: 140_000,
        threshold: 200_000,
        tokenUsedRatio: 0.7,
      }),
    ).toBe("timeout recovery: prompt 140k (70% of 200k context)");
    expect(
      formatCompactionTriggerReason({
        trigger: "cli_budget",
        projectedTokens: 180_000,
        threshold: 160_000,
      }),
    ).toBe("CLI context budget: 180k ≥ 160k");
    expect(
      formatCompactionTriggerReason({
        trigger: "tokens",
        reasonText: "token budget: projected 176k ≥ 160k",
        projectedTokens: 999_999,
        threshold: 1,
      }),
    ).toBe("token budget: projected 176k ≥ 160k");
    expect(
      buildCompactionAgentEventData("end", {
        trigger: "timeout_recovery",
        projectedTokens: 140_000,
        threshold: 200_000,
        tokenUsedRatio: 0.7,
      }),
    ).toMatchObject({
      phase: "end",
      trigger: "timeout_recovery",
      projectedTokens: 140_000,
      threshold: 200_000,
      tokenUsedRatio: 0.7,
      reasonText: "timeout recovery: prompt 140k (70% of 200k context)",
    });
  });
});
