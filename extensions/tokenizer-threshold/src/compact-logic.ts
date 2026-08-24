/**
 * Engine-owned compaction: native-style summary message + keepRecentTokens tail.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  assembleNativeStyleCompactedMessages,
  type NativeCompactAssembly,
} from "./native-compact-assemble.js";
import {
  countMessageTokens,
  countPromptTokens,
  countSystemPromptTokens,
  countToolsSchemaTokens,
  type TokenCounter,
} from "./tokenizer.js";

export type EngineCompactComputation = NativeCompactAssembly;

/** Compute a compacted prompt view for the tokenizer-threshold engine. */
export function computeTokenizerThresholdCompaction(params: {
  messages: AgentMessage[];
  thresholdTokens: number;
  counter: TokenCounter;
  keepRecentTokens?: number;
  summaryOverride?: string;
  /** Cached llm_input system prompt; counted toward the threshold gate. */
  systemPrompt?: string;
  /** Cached llm_input tool-schema token estimate; counted toward the gate. */
  toolsSchemaTokens?: number;
  /** 1-based context-engine compaction trigger count for the summary reason. */
  compactionTriggerCount?: number;
}): EngineCompactComputation {
  const systemPromptTokens = countSystemPromptTokens({
    systemPrompt: params.systemPrompt,
    counter: params.counter,
  });
  const toolsSchemaTokens = countToolsSchemaTokens({
    toolsSchemaTokens: params.toolsSchemaTokens,
    counter: params.counter,
  });
  const tokensBefore = countPromptTokens({
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    toolsSchemaTokens,
    counter: params.counter,
  });

  if (params.messages.length === 0) {
    return {
      compacted: false,
      reason: "empty transcript",
      messages: params.messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      summary: "",
      preservedStartIndex: 0,
      summarizableCount: 0,
      isSplitTurn: false,
    };
  }

  // Under-budget prompts stay intact.
  if (tokensBefore < params.thresholdTokens) {
    return {
      compacted: false,
      reason: "below threshold",
      messages: params.messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      summary: "",
      preservedStartIndex: params.messages.length,
      summarizableCount: 0,
      isSplitTurn: false,
    };
  }

  // Leave headroom in the message budget for cached system + tool schemas so
  // summary+tail windowing targets (messages + system + tools) ≈ thresholdTokens.
  const fixedPromptTokens = systemPromptTokens + toolsSchemaTokens;
  const messageThresholdTokens = Math.max(1, params.thresholdTokens - fixedPromptTokens);
  const assembled = assembleNativeStyleCompactedMessages({
    messages: params.messages,
    thresholdTokens: messageThresholdTokens,
    counter: params.counter,
    keepRecentTokens: params.keepRecentTokens ?? 20_000,
    summaryOverride: params.summaryOverride,
    // Gate reason in the summary body uses full prompt pressure + configured threshold.
    triggerTokensBefore: tokensBefore,
    triggerThresholdTokens: params.thresholdTokens,
    compactionTriggerCount: params.compactionTriggerCount,
    tokenizerDegraded: params.counter.isDegraded(),
    countMessageTokens: (messages) => countMessageTokens({ messages, counter: params.counter }),
  });
  return {
    ...assembled,
    tokensBefore,
    tokensAfter: assembled.tokensAfter + fixedPromptTokens,
  };
}
