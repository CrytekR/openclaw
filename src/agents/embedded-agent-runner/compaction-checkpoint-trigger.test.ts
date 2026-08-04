import { describe, expect, it } from "vitest";
import {
  buildCheckpointTriggerFromPreflightDetails,
  normalizeSessionCompactionCheckpointTrigger,
  resolveCompactionCheckpointTriggerFromParams,
} from "./compaction-checkpoint-trigger.js";

describe("compaction-checkpoint-trigger", () => {
  it("maps preflight token-budget details onto a checkpoint trigger snapshot", () => {
    expect(
      buildCheckpointTriggerFromPreflightDetails({
        details: {
          trigger: "tokens",
          projectedTokens: 181_000,
          threshold: 176_000,
          projectedBreakdown: {
            source: "transcript_usage",
            baseTokens: 170_000,
            lastOutputTokens: 10_000,
            promptEstimateTokens: 1_000,
            recountMethod: "last_model_usage",
          },
        },
        contextWindowTokens: 200_000,
      }),
    ).toEqual({
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
    });
  });

  it("maps transcript-bytes preflight details onto a checkpoint trigger snapshot", () => {
    expect(
      buildCheckpointTriggerFromPreflightDetails({
        details: {
          trigger: "transcript_bytes",
          activeTranscriptBytes: 3_000_000,
          maxActiveTranscriptBytes: 2_000_000,
          projectedTokens: 50_000,
          threshold: 40_000,
        },
        contextWindowTokens: 100_000,
      }),
    ).toEqual({
      path: "preflight_transcript_bytes",
      trigger: "transcript_bytes",
      projectedTokens: 50_000,
      thresholdTokens: 40_000,
      contextWindowTokens: 100_000,
      activeTranscriptBytes: 3_000_000,
      maxActiveTranscriptBytes: 2_000_000,
    });
  });

  it("prefers an explicit checkpointTrigger over inferred params", () => {
    expect(
      resolveCompactionCheckpointTriggerFromParams({
        checkpointTrigger: {
          path: "midturn_precheck",
          trigger: "overflow",
          projectedTokens: 120_000,
          overflowRoute: "compact_only",
          overflowSource: "mid-turn",
          attempt: 1,
        },
        trigger: "overflow",
        currentTokenCount: 999,
      }),
    ).toEqual({
      path: "midturn_precheck",
      trigger: "overflow",
      projectedTokens: 120_000,
      overflowRoute: "compact_only",
      overflowSource: "mid-turn",
      attempt: 1,
    });
  });

  it("infers timeout and overflow paths from compact params", () => {
    expect(
      resolveCompactionCheckpointTriggerFromParams({
        trigger: "timeout_recovery",
        contextTokenBudget: 100_000,
        attempt: 2,
      }),
    ).toEqual({
      path: "timeout_retry",
      trigger: "budget",
      contextWindowTokens: 100_000,
      attempt: 2,
    });

    expect(
      resolveCompactionCheckpointTriggerFromParams({
        trigger: "overflow",
        currentTokenCount: 210_000,
        contextTokenBudget: 200_000,
        attempt: 1,
      }),
    ).toEqual({
      path: "overflow_retry",
      trigger: "overflow",
      projectedTokens: 210_000,
      contextWindowTokens: 200_000,
      attempt: 1,
    });
  });

  it("drops invalid trigger payloads", () => {
    expect(
      normalizeSessionCompactionCheckpointTrigger({
        path: "manual",
        projectedTokens: -1,
        attempt: 0,
      }),
    ).toEqual({ path: "manual" });
  });
});
