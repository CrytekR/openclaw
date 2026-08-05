import { describe, expect, it } from "vitest";
import { resolveSessionCompactionCheckpointReason } from "./session-compaction-checkpoint-reason.js";

describe("resolveSessionCompactionCheckpointReason", () => {
  it("maps timeout recovery onto a Timeout retry reason", () => {
    expect(resolveSessionCompactionCheckpointReason({ trigger: "timeout_recovery" })).toBe(
      "Timeout retry",
    );
    expect(
      resolveSessionCompactionCheckpointReason({
        checkpointTrigger: {
          path: "timeout_retry",
          trigger: "budget",
          projectedTokens: 70_000,
          thresholdTokens: 65_000,
          contextWindowTokens: 100_000,
          attempt: 2,
        },
      }),
    ).toBe(
      "Timeout retry projectedTokens=70000 thresholdTokens=65000 contextWindowTokens=100000 attempt=2",
    );
  });

  it("embeds gate calc numbers for detailed overflow entry paths", () => {
    expect(resolveSessionCompactionCheckpointReason({ trigger: "overflow" })).toBe(
      "Overflow retry",
    );
    expect(
      resolveSessionCompactionCheckpointReason({
        checkpointTrigger: {
          path: "pre_prompt_precheck",
          trigger: "overflow",
          estimatedPromptTokens: 210_000,
          promptBudgetBeforeReserve: 180_000,
          overflowTokens: 30_000,
          contextWindowTokens: 200_000,
          overflowRoute: "compact_only",
          overflowSource: "precheck",
          attempt: 1,
        },
      }),
    ).toBe(
      "Pre-prompt precheck contextWindowTokens=200000 estimatedPromptTokens=210000 promptBudgetBeforeReserve=180000 overflowTokens=30000 attempt=1 overflowRoute=compact_only overflowSource=precheck",
    );
    expect(
      resolveSessionCompactionCheckpointReason({
        checkpointTrigger: {
          path: "char_overflow_guard",
          trigger: "overflow",
          projectedTokens: 220_001,
          contextWindowTokens: 200_000,
          attempt: 1,
        },
      }),
    ).toBe("Char overflow guard projectedTokens=220001 contextWindowTokens=200000 attempt=1");
    expect(
      resolveSessionCompactionCheckpointReason({
        checkpointTrigger: {
          path: "midturn_precheck",
          trigger: "overflow",
          projectedTokens: 190_000,
          overflowRoute: "compact_then_truncate",
          overflowSource: "mid-turn",
        },
      }),
    ).toBe(
      "Mid-turn precheck projectedTokens=190000 overflowRoute=compact_then_truncate overflowSource=mid-turn",
    );
  });

  it("embeds preflight projection and transcript-byte gate numbers", () => {
    expect(
      resolveSessionCompactionCheckpointReason({
        trigger: "budget",
        checkpointTrigger: {
          path: "preflight_tokens",
          trigger: "tokens",
          projectedTokens: 181_000,
          thresholdTokens: 176_000,
          contextWindowTokens: 200_000,
          projectedBreakdown: {
            source: "transcript_usage",
            baseTokens: 170_000,
            lastOutputTokens: 10_000,
            promptEstimateTokens: 1_000,
            recountMethod: "last_model_usage",
          },
        },
      }),
    ).toBe(
      "Preflight tokens projectedTokens=181000 thresholdTokens=176000 contextWindowTokens=200000 breakdownSource=transcript_usage baseTokens=170000 lastOutputTokens=10000 promptEstimateTokens=1000 recountMethod=last_model_usage",
    );
    expect(
      resolveSessionCompactionCheckpointReason({
        trigger: "budget",
        checkpointTrigger: {
          path: "preflight_transcript_bytes",
          trigger: "transcript_bytes",
          activeTranscriptBytes: 3_000_000,
          maxActiveTranscriptBytes: 2_000_000,
          projectedTokens: 50_000,
          thresholdTokens: 40_000,
          contextWindowTokens: 100_000,
        },
      }),
    ).toBe(
      "Preflight transcript bytes projectedTokens=50000 thresholdTokens=40000 contextWindowTokens=100000 activeTranscriptBytes=3000000 maxActiveTranscriptBytes=2000000",
    );
  });

  it("maps manual trigger to Manual", () => {
    expect(resolveSessionCompactionCheckpointReason({ trigger: "manual" })).toBe("Manual");
    expect(
      resolveSessionCompactionCheckpointReason({
        checkpointTrigger: {
          path: "manual",
          trigger: "manual",
          contextWindowTokens: 200_000,
        },
      }),
    ).toBe("Manual contextWindowTokens=200000");
  });
});
