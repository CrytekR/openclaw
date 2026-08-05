import { describe, expect, it } from "vitest";
import {
  buildCheckpointTriggerFromPreflightDetails,
  buildOverflowCompactionCheckpointTrigger,
  normalizeSessionCompactionCheckpointTrigger,
  resolveCompactionCheckpointTriggerFromParams,
  resolveOverflowCompactionTriggerPath,
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
        currentTokenCount: 70_000,
        contextTokenBudget: 100_000,
        attempt: 2,
      }),
    ).toEqual({
      path: "timeout_retry",
      trigger: "budget",
      promptTokens: 70_000,
      thresholdTokens: 65_000,
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
      compactionTokens: 210_000,
      contextWindowTokens: 200_000,
      attempt: 1,
    });
  });

  it("builds path-specific overflow checkpoint trigger snapshots", () => {
    expect(
      buildOverflowCompactionCheckpointTrigger({
        path: "overflow_retry",
        observedOverflowTokens: 130_000,
        compactionTokens: 130_000,
        contextWindowTokens: 128_000,
        attempt: 1,
        overflowSource: "assistantError",
        overflowErrorText:
          "request_too_large: Request size exceeds model context window\nwith detail",
      }),
    ).toEqual({
      path: "overflow_retry",
      trigger: "overflow",
      observedOverflowTokens: 130_000,
      compactionTokens: 130_000,
      contextWindowTokens: 128_000,
      attempt: 1,
      overflowSource: "assistantError",
      overflowErrorText: "request_too_large: Request size exceeds model context window with detail",
    });
    expect(
      buildOverflowCompactionCheckpointTrigger({
        path: "char_overflow_guard",
        maxContextChars: 460_800,
        contextWindowTokens: 128_000,
        compactionTokens: 128_001,
        attempt: 1,
        overflowSource: "promptError",
      }),
    ).toEqual({
      path: "char_overflow_guard",
      trigger: "overflow",
      maxContextChars: 460_800,
      contextWindowTokens: 128_000,
      attempt: 1,
      overflowSource: "promptError",
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

  it("normalizes assistant overflow error text for sessions.json", () => {
    const long = `x${"y".repeat(600)}`;
    expect(
      normalizeSessionCompactionCheckpointTrigger({
        path: "overflow_retry",
        overflowSource: "assistantError",
        overflowErrorText: `  ${long}\n\nextra  `,
      }),
    ).toEqual({
      path: "overflow_retry",
      overflowSource: "assistantError",
      overflowErrorText: `x${"y".repeat(499)}`,
    });
    expect(
      normalizeSessionCompactionCheckpointTrigger({
        path: "overflow_retry",
        overflowErrorText: "   ",
      }),
    ).toEqual({ path: "overflow_retry" });
  });

  it("classifies overflow recovery into detailed entry paths", () => {
    expect(
      resolveOverflowCompactionTriggerPath({
        preflightRecoverySource: "mid-turn",
        promptErrorSource: "precheck",
      }),
    ).toBe("midturn_precheck");
    expect(
      resolveOverflowCompactionTriggerPath({
        overflowErrorSource: "promptError",
        overflowErrorText:
          "Context overflow: estimated context size exceeds safe threshold during tool loop.",
        promptErrorSource: "prompt",
      }),
    ).toBe("char_overflow_guard");
    expect(
      resolveOverflowCompactionTriggerPath({
        // Assistant/provider overflow must stay overflow_retry even if the
        // error text mentions the char-guard phrase.
        overflowErrorSource: "assistantError",
        overflowErrorText:
          "Context overflow: estimated context size exceeds safe threshold during tool loop.",
        promptErrorSource: null,
      }),
    ).toBe("overflow_retry");
    expect(
      resolveOverflowCompactionTriggerPath({
        promptErrorSource: "precheck",
        overflowErrorSource: "promptError",
      }),
    ).toBe("pre_prompt_precheck");
    expect(
      resolveOverflowCompactionTriggerPath({
        overflowErrorSource: "promptError",
        promptErrorSource: "prompt",
        overflowErrorText: "prompt is too long",
      }),
    ).toBe("overflow_retry");
  });
});
