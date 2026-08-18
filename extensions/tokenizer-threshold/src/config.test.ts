import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_PYTHON_PATH,
  DEFAULT_THRESHOLD_TOKENS,
  DEFAULT_TOKENIZER_MODEL,
  resolveTokenizerThresholdConfig,
} from "./config.js";

describe("resolveTokenizerThresholdConfig", () => {
  it("defaults to 113k DeepSeek-V4-Flash with 20k keep-recent", () => {
    expect(resolveTokenizerThresholdConfig(undefined)).toEqual({
      thresholdTokens: DEFAULT_THRESHOLD_TOKENS,
      tokenizerModel: DEFAULT_TOKENIZER_MODEL,
      pythonPath: DEFAULT_PYTHON_PATH,
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
    });
    expect(DEFAULT_THRESHOLD_TOKENS).toBe(113_000);
    expect(DEFAULT_KEEP_RECENT_TOKENS).toBe(20_000);
    expect(DEFAULT_TOKENIZER_MODEL).toBe("deepseek-ai/DeepSeek-V4-Flash");
  });

  it("accepts explicit threshold, tokenizerModel, pythonPath, and keepRecentTokens", () => {
    expect(
      resolveTokenizerThresholdConfig({
        thresholdTokens: 50_000,
        tokenizerModel: "other/model",
        pythonPath: "/usr/bin/python3",
        keepRecentTokens: 12_000,
      }),
    ).toEqual({
      thresholdTokens: 50_000,
      tokenizerModel: "other/model",
      pythonPath: "/usr/bin/python3",
      keepRecentTokens: 12_000,
    });
  });

  it("maps deepseek-v4-flash alias to the HF model id", () => {
    expect(
      resolveTokenizerThresholdConfig({
        tokenizerModel: "deepseek-v4-flash",
      }),
    ).toMatchObject({
      tokenizerModel: DEFAULT_TOKENIZER_MODEL,
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
        tokenizerModel: "   ",
        pythonPath: "",
        keepRecentTokens: -1,
      }),
    ).toEqual({
      thresholdTokens: DEFAULT_THRESHOLD_TOKENS,
      tokenizerModel: DEFAULT_TOKENIZER_MODEL,
      pythonPath: DEFAULT_PYTHON_PATH,
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
    });
  });
});
