import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLD_TOKENS,
  DEFAULT_TOKENIZER_ENCODING,
  resolveTokenizerThresholdConfig,
} from "./config.js";

describe("resolveTokenizerThresholdConfig", () => {
  it("defaults to 113k cl100k_base", () => {
    expect(resolveTokenizerThresholdConfig(undefined)).toEqual({
      thresholdTokens: DEFAULT_THRESHOLD_TOKENS,
      encoding: DEFAULT_TOKENIZER_ENCODING,
    });
    expect(DEFAULT_THRESHOLD_TOKENS).toBe(113_000);
  });

  it("accepts explicit threshold and encoding", () => {
    expect(
      resolveTokenizerThresholdConfig({
        thresholdTokens: 50_000,
        encoding: "o200k_base",
      }),
    ).toEqual({
      thresholdTokens: 50_000,
      encoding: "o200k_base",
    });
  });

  it("rejects invalid values", () => {
    expect(
      resolveTokenizerThresholdConfig({
        thresholdTokens: -1,
        encoding: "nope",
      }),
    ).toEqual({
      thresholdTokens: DEFAULT_THRESHOLD_TOKENS,
      encoding: DEFAULT_TOKENIZER_ENCODING,
    });
  });
});
