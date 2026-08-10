/**
 * Tokenizer-threshold context engine plugin.
 * Owns threshold compaction with agent-core findCutPoint keep-recent tail.
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
    keepRecentTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export default definePluginEntry({
  id: "tokenizer-threshold",
  name: "Tokenizer Threshold Context Engine",
  description:
    "Own threshold compaction with findCutPoint keep-recent tail (default 113k / 20k) and report token counts to host checkpoints.",
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
