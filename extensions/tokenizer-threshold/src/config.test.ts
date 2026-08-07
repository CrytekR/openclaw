import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECENT_TURNS_PRESERVE,
  DEFAULT_THRESHOLD_TOKENS,
  DEFAULT_TOKENIZER_ENCODING,
  resolveTokenizerThresholdConfig,
} from "./config.js";

describe("resolveTokenizerThresholdConfig", () => {
  it("defaults to 113k cl100k_base with 3 preserved turns", () => {
    expect(resolveTokenizerThresholdConfig(undefined)).toEqual({
      thresholdTokens: DEFAULT_THRESHOLD_TOKENS,
      encoding: DEFAULT_TOKENIZER_ENCODING,
      recentTurnsPreserve: DEFAULT_RECENT_TURNS_PRESERVE,
    });
    expect(DEFAULT_THRESHOLD_TOKENS).toBe(113_000);
  });

  it("accepts explicit threshold, encoding, and recentTurnsPreserve", () => {
    expect(
      resolveTokenizerThresholdConfig({
        thresholdTokens: 50_000,
        encoding: "o200k_base",
        recentTurnsPreserve: 5,
      }),
    ).toEqual({
      thresholdTokens: 50_000,
      encoding: "o200k_base",
      recentTurnsPreserve: 5,
    });
  });

  it("rejects invalid values", () => {
    expect(
      resolveTokenizerThresholdConfig({
        thresholdTokens: -1,
        encoding: "nope",
        recentTurnsPreserve: -1,
      }),
    ).toEqual({
      thresholdTokens: DEFAULT_THRESHOLD_TOKENS,
      encoding: DEFAULT_TOKENIZER_ENCODING,
      recentTurnsPreserve: DEFAULT_RECENT_TURNS_PRESERVE,
    });
  });
});
