import { describe, expect, it } from "vitest";
import { computeTokenizerThresholdCompaction } from "./compact-logic.js";
import { getLocalTokenCounter } from "./tokenizer.js";

describe("computeTokenizerThresholdCompaction", () => {
  const counter = getLocalTokenCounter("cl100k_base");

  it("returns below-threshold without compacting", () => {
    const result = computeTokenizerThresholdCompaction({
      messages: [{ role: "user", content: "short" }],
      thresholdTokens: 113_000,
      counter,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("below threshold");
  });

  it("compacts oversized transcripts to a trailing window", () => {
    const result = computeTokenizerThresholdCompaction({
      messages: [
        { role: "user", content: "word ".repeat(2_000) },
        { role: "assistant", content: "word ".repeat(2_000) },
        { role: "user", content: "latest" },
      ],
      thresholdTokens: 200,
      counter,
      force: true,
    });
    expect(result.compacted).toBe(true);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(result.messages.at(-1)).toMatchObject({ role: "user", content: "latest" });
    expect(result.summary).toContain("Tokenizer-threshold");
  });
});
