import { describe, expect, it } from "vitest";
import { resolveSessionCompactionCheckpointReason } from "./session-compaction-checkpoints.js";

describe("resolveSessionCompactionCheckpointReason", () => {
  it("maps timeout recovery and timeout path to timeout-retry", () => {
    expect(resolveSessionCompactionCheckpointReason({ trigger: "timeout_recovery" })).toBe(
      "timeout-retry",
    );
    expect(
      resolveSessionCompactionCheckpointReason({
        checkpointTrigger: { path: "timeout_retry", trigger: "budget" },
      }),
    ).toBe("timeout-retry");
  });

  it("maps concrete overflow entry paths onto detailed reasons", () => {
    expect(resolveSessionCompactionCheckpointReason({ trigger: "overflow" })).toBe(
      "overflow-retry",
    );
    expect(
      resolveSessionCompactionCheckpointReason({
        checkpointTrigger: { path: "pre_prompt_precheck", trigger: "overflow" },
      }),
    ).toBe("pre-prompt-precheck");
    expect(
      resolveSessionCompactionCheckpointReason({
        checkpointTrigger: { path: "char_overflow_guard", trigger: "overflow" },
      }),
    ).toBe("char-overflow-guard");
    expect(
      resolveSessionCompactionCheckpointReason({
        checkpointTrigger: { path: "midturn_precheck", trigger: "overflow" },
      }),
    ).toBe("midturn-precheck");
  });

  it("maps preflight token/bytes gates onto detailed auto reasons", () => {
    expect(
      resolveSessionCompactionCheckpointReason({
        trigger: "budget",
        checkpointTrigger: { path: "preflight_tokens", trigger: "tokens" },
      }),
    ).toBe("preflight-tokens");
    expect(
      resolveSessionCompactionCheckpointReason({
        trigger: "budget",
        checkpointTrigger: { path: "preflight_transcript_bytes", trigger: "transcript_bytes" },
      }),
    ).toBe("preflight-transcript-bytes");
  });

  it("maps manual trigger to manual", () => {
    expect(resolveSessionCompactionCheckpointReason({ trigger: "manual" })).toBe("manual");
  });
});
