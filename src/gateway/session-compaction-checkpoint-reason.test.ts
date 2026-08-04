import { describe, expect, it } from "vitest";
import { resolveSessionCompactionCheckpointReason } from "./session-compaction-checkpoints.js";

describe("resolveSessionCompactionCheckpointReason", () => {
  it("maps timeout recovery and timeout path to timeout-retry", () => {
    expect(
      resolveSessionCompactionCheckpointReason({ trigger: "timeout_recovery" }),
    ).toBe("timeout-retry");
    expect(
      resolveSessionCompactionCheckpointReason({
        checkpointTrigger: { path: "timeout_retry", trigger: "budget" },
      }),
    ).toBe("timeout-retry");
  });

  it("maps overflow and mid-turn precheck paths to overflow-retry", () => {
    expect(resolveSessionCompactionCheckpointReason({ trigger: "overflow" })).toBe(
      "overflow-retry",
    );
    expect(
      resolveSessionCompactionCheckpointReason({
        checkpointTrigger: { path: "midturn_precheck", trigger: "overflow" },
      }),
    ).toBe("overflow-retry");
  });

  it("keeps preflight token/bytes gates under auto-threshold", () => {
    expect(
      resolveSessionCompactionCheckpointReason({
        trigger: "budget",
        checkpointTrigger: { path: "preflight_tokens", trigger: "tokens" },
      }),
    ).toBe("auto-threshold");
    expect(
      resolveSessionCompactionCheckpointReason({
        trigger: "budget",
        checkpointTrigger: { path: "preflight_transcript_bytes", trigger: "transcript_bytes" },
      }),
    ).toBe("auto-threshold");
  });

  it("maps manual trigger to manual", () => {
    expect(resolveSessionCompactionCheckpointReason({ trigger: "manual" })).toBe("manual");
  });
});
