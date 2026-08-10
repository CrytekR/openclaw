import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_THRESHOLD_TOKENS,
  DEFAULT_TOKENIZER_ENCODING,
  resolveTokenizerThresholdConfig,
} from "./config.js";

describe("resolveTokenizerThresholdConfig", () => {
  it("defaults to 113k cl100k_base with 20k keep-recent", () => {
    expect(resolveTokenizerThresholdConfig(undefined)).toEqual({
      thresholdTokens: DEFAULT_THRESHOLD_TOKENS,
      encoding: DEFAULT_TOKENIZER_ENCODING,
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
    });
    expect(DEFAULT_THRESHOLD_TOKENS).toBe(113_000);
    expect(DEFAULT_KEEP_RECENT_TOKENS).toBe(20_000);
  });

  it("accepts explicit threshold, encoding, and keepRecentTokens", () => {
    expect(
      resolveTokenizerThresholdConfig({
        thresholdTokens: 50_000,
        encoding: "o200k_base",
        keepRecentTokens: 12_000,
      }),
    ).toEqual({
      thresholdTokens: 50_000,
      encoding: "o200k_base",
      keepRecentTokens: 12_000,
    });
  });

  it("clamps keepRecentTokens below thresholdTokens", () => {
    expect(
      resolveTokenizerThresholdConfig({
        thresholdTokens: 1_000,
        keepRecentTokens: 5_000,
      }),
    ).toMatchObject({
      thresholdTokens: 1_000,
      keepRecentTokens: 999,
    });
  });

  it("rejects invalid values", () => {
    expect(
      resolveTokenizerThresholdConfig({
        thresholdTokens: -1,
        encoding: "nope",
        keepRecentTokens: -1,
      }),
    ).toEqual({
      thresholdTokens: DEFAULT_THRESHOLD_TOKENS,
      encoding: DEFAULT_TOKENIZER_ENCODING,
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
    });
  });
});
