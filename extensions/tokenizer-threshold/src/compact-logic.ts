/**
 * Engine-owned compaction: native-style summary message + keepRecentTokens tail.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { splitMessagesAtCutPoint } from "./cut-point.js";
import {
  assembleNativeStyleCompactedMessages,
  type NativeCompactAssembly,
} from "./native-compact-assemble.js";
import {
  countMessageTokens,
  countPromptTokens,
  countSystemPromptTokens,
  type TokenCounter,
} from "./tokenizer.js";

export type EngineCompactComputation = NativeCompactAssembly;

/** Compute a compacted prompt view for the tokenizer-threshold engine. */
export function computeTokenizerThresholdCompaction(params: {
  messages: AgentMessage[];
  thresholdTokens: number;
  counter: TokenCounter;
  force?: boolean;
  keepRecentTokens?: number;
  summaryOverride?: string;
  /** Cached llm_input system prompt; counted toward the threshold gate. */
  systemPrompt?: string;
}): EngineCompactComputation {
  const systemPromptTokens = countSystemPromptTokens({
    systemPrompt: params.systemPrompt,
    counter: params.counter,
  });
  const tokensBefore = countPromptTokens({
    messages: params.messages,
    systemPrompt: params.systemPrompt,
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

  // force still respects the threshold gate: under-budget prompts stay intact.
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

  // Leave headroom in the message budget for the cached system prompt so
  // summary+tail windowing targets (messages + system) ≈ thresholdTokens.
  const messageThresholdTokens = Math.max(1, params.thresholdTokens - systemPromptTokens);
  const assembled = assembleNativeStyleCompactedMessages({
    messages: params.messages,
    thresholdTokens: messageThresholdTokens,
    counter: params.counter,
    keepRecentTokens: params.keepRecentTokens ?? 20_000,
    summaryOverride: params.summaryOverride,
    countMessageTokens: (messages) => countMessageTokens({ messages, counter: params.counter }),
  });
  if (!assembled.compacted) {
    return {
      ...assembled,
      tokensBefore,
      tokensAfter: assembled.tokensAfter + systemPromptTokens,
    };
  }
  return {
    ...assembled,
    tokensBefore,
    tokensAfter: assembled.tokensAfter + systemPromptTokens,
  };
}

export { splitMessagesAtCutPoint };
