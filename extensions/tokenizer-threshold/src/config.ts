/** Plugin config for the tokenizer-threshold context engine. */

export const DEFAULT_THRESHOLD_TOKENS = 113_000;
export const DEFAULT_TOKENIZER_ENCODING = "cl100k_base" as const;
/** Same default as agent-core DEFAULT_COMPACTION_SETTINGS.keepRecentTokens. */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

export type TokenizerThresholdEncoding = "cl100k_base" | "o200k_base" | "p50k_base" | "r50k_base";

export type TokenizerThresholdConfig = {
  thresholdTokens: number;
  encoding: TokenizerThresholdEncoding;
  /**
   * Approximate recent-context tokens kept verbatim after the summary
   * (agent-core findCutPoint / keepRecentTokens; default 20000).
   */
  keepRecentTokens: number;
};

const ENCODINGS = new Set<TokenizerThresholdEncoding>([
  "cl100k_base",
  "o200k_base",
  "p50k_base",
  "r50k_base",
]);

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

export function resolveTokenizerThresholdConfig(
  raw: Record<string, unknown> | undefined,
): TokenizerThresholdConfig {
  const encodingRaw = raw?.encoding;
  const encoding =
    typeof encodingRaw === "string" && ENCODINGS.has(encodingRaw as TokenizerThresholdEncoding)
      ? (encodingRaw as TokenizerThresholdEncoding)
      : DEFAULT_TOKENIZER_ENCODING;
  const thresholdTokens = readPositiveInt(raw?.thresholdTokens, DEFAULT_THRESHOLD_TOKENS);
  let keepRecentTokens = readPositiveInt(raw?.keepRecentTokens, DEFAULT_KEEP_RECENT_TOKENS);
  // Keep-recent must leave room under the engine threshold for a summary prefix.
  if (keepRecentTokens >= thresholdTokens) {
    keepRecentTokens = Math.max(1, thresholdTokens - 1);
  }
  return {
    thresholdTokens,
    encoding,
    keepRecentTokens,
  };
}
