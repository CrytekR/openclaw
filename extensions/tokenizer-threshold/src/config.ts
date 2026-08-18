/**
 * Plugin config for the tokenizer-threshold context engine.
 * Local counts use Python transformers (DeepSeek-V4-Flash tokenizer by default).
 */

export const DEFAULT_THRESHOLD_TOKENS = 113_000;
/** Official DeepSeek-V4-Flash tokenizer on Hugging Face (deepseek-v4-flash). */
export const DEFAULT_TOKENIZER_MODEL = "deepseek-ai/DeepSeek-V4-Flash";
export const DEFAULT_PYTHON_PATH = "python3";
/** Same default as agent-core DEFAULT_COMPACTION_SETTINGS.keepRecentTokens. */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

export type TokenizerThresholdConfig = {
  thresholdTokens: number;
  /**
   * Hugging Face model id whose tokenizer is loaded via Python transformers
   * (default: deepseek-ai/DeepSeek-V4-Flash).
   */
  tokenizerModel: string;
  /** Python executable used to run the transformers token-counter worker. */
  pythonPath: string;
  /**
   * Approximate recent-context tokens kept verbatim after the summary
   * (agent-core findCutPoint / keepRecentTokens; default 20000).
   */
  keepRecentTokens: number;
};

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function readNonEmptyString(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

/** Map short aliases like deepseek-v4-flash onto the HF model id. */
function normalizeTokenizerModel(value: unknown): string {
  const raw = readNonEmptyString(value, DEFAULT_TOKENIZER_MODEL);
  const lowered = raw.toLowerCase();
  if (
    lowered === "deepseek-v4-flash" ||
    lowered === "deepseek_v4_flash" ||
    lowered === "deepseek-v4flash"
  ) {
    return DEFAULT_TOKENIZER_MODEL;
  }
  return raw;
}

export function resolveTokenizerThresholdConfig(
  raw: Record<string, unknown> | undefined,
): TokenizerThresholdConfig {
  const thresholdTokens = readPositiveInt(raw?.thresholdTokens, DEFAULT_THRESHOLD_TOKENS);
  let keepRecentTokens = readPositiveInt(raw?.keepRecentTokens, DEFAULT_KEEP_RECENT_TOKENS);
  // Keep-recent must leave room under the engine threshold for a summary prefix.
  if (keepRecentTokens >= thresholdTokens) {
    keepRecentTokens = Math.max(1, thresholdTokens - 1);
  }
  return {
    thresholdTokens,
    tokenizerModel: normalizeTokenizerModel(raw?.tokenizerModel),
    pythonPath: readNonEmptyString(raw?.pythonPath, DEFAULT_PYTHON_PATH),
    keepRecentTokens,
  };
}
