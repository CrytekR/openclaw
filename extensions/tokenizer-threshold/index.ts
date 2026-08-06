/**
 * Tokenizer-threshold context engine plugin.
 * Counts tokens with a local tiktoken encoding and compacts at a fixed threshold.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { resolveTokenizerThresholdConfig } from "./src/config.js";
import { createTokenizerThresholdContextEngine } from "./src/engine.js";

const configSchema = Type.Object(
  {
    thresholdTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    encoding: Type.Optional(
      Type.Union([
        Type.Literal("cl100k_base"),
        Type.Literal("o200k_base"),
        Type.Literal("p50k_base"),
        Type.Literal("r50k_base"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export default definePluginEntry({
  id: "tokenizer-threshold",
  name: "Tokenizer Threshold Context Engine",
  description:
    "Count prompt tokens with a local tiktoken encoding and trigger compaction at a fixed threshold (default 113k).",
  kind: "context-engine",
  configSchema,
  register(api) {
    const config = resolveTokenizerThresholdConfig(
      (api.pluginConfig ?? {}) as Record<string, unknown>,
    );
    api.registerContextEngine("tokenizer-threshold", () =>
      createTokenizerThresholdContextEngine({ config }),
    );
  },
});
