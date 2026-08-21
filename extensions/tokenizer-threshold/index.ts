/**
 * Tokenizer-threshold context engine plugin.
 * Owns threshold compaction with agent-core findCutPoint keep-recent tail.
 * Compacts only in assemble via api.runtime.llm.complete (+ extractive fallback).
 * Observes llm_input to cache system prompt + tool schemas for threshold gating.
 * Local token counts use Python transformers (default: deepseek-v4-flash bundled).
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { resolveTokenizerThresholdConfig } from "./src/config.js";
import { createTokenizerThresholdContextEngine } from "./src/engine.js";
import { rememberSystemPrompt } from "./src/system-prompt-cache.js";
import { countToolsSchemaTokens, createTokenCounter } from "./src/tokenizer.js";
import { rememberToolsSchemaTokens, serializeToolsSchema } from "./src/tools-schema-cache.js";

const configSchema = Type.Object(
  {
    thresholdTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    tokenizerModel: Type.Optional(Type.String({ minLength: 1 })),
    pythonPath: Type.Optional(Type.String({ minLength: 1 })),
    keepRecentTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export default definePluginEntry({
  id: "tokenizer-threshold",
  name: "Tokenizer Threshold Context Engine",
  description:
    "Own threshold compaction in assemble with findCutPoint keep-recent tail (default 113k / 20k) via api.runtime.llm.complete; tokens via Python transformers (DeepSeek-V4-Flash).",
  kind: "context-engine",
  configSchema,
  register(api) {
    const config = resolveTokenizerThresholdConfig(
      (api.pluginConfig ?? {}) as Record<string, unknown>,
    );
    const counter = createTokenCounter(config, {
      onWarn: (message) => {
        api.logger.warn(message);
      },
    });

    // Context-engine assemble cannot see system prompt or tool schemas. Cache
    // both from llm_input so threshold gating tracks OpenClaw's displayed
    // provider prompt pressure more closely. Non-bundled installs need
    // plugins.entries.tokenizer-threshold.hooks.allowConversationAccess=true.
    api.on("llm_input", (event, ctx) => {
      if (typeof event.systemPrompt === "string" && event.systemPrompt.trim()) {
        rememberSystemPrompt({
          sessionId: event.sessionId,
          sessionKey: ctx.sessionKey,
          systemPrompt: event.systemPrompt,
        });
      }
      const toolsSchema = serializeToolsSchema(event.tools);
      rememberToolsSchemaTokens({
        sessionId: event.sessionId,
        sessionKey: ctx.sessionKey,
        tokens: countToolsSchemaTokens({
          toolsSchema,
          counter,
        }),
      });
    });

    api.registerContextEngine("tokenizer-threshold", () =>
      createTokenizerThresholdContextEngine({
        config,
        counter,
        // Lazy: runtime.llm may be wired after register; resolve at assemble time.
        resolveLlmComplete: () => {
          const complete = api.runtime?.llm?.complete;
          if (typeof complete !== "function") {
            return undefined;
          }
          return (request) => complete.call(api.runtime.llm, request);
        },
      }),
    );
  },
});
