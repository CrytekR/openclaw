/**
 * Engine-owned compaction: native-style summary message + preserved recent turns.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  assembleNativeStyleCompactedMessages,
  splitPreservedRecentTurns,
  type NativeCompactAssembly,
} from "./native-compact-assemble.js";
import { countMessageTokens, type TokenCounter } from "./tokenizer.js";

export type EngineCompactComputation = NativeCompactAssembly;

/** Compute a compacted prompt view for the tokenizer-threshold engine. */
export function computeTokenizerThresholdCompaction(params: {
  messages: AgentMessage[];
  thresholdTokens: number;
  counter: TokenCounter;
  force?: boolean;
  recentTurnsPreserve?: number;
  summaryOverride?: string;
}): EngineCompactComputation {
  const tokensBefore = countMessageTokens({
    messages: params.messages,
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
    };
  }

  return assembleNativeStyleCompactedMessages({
    messages: params.messages,
    thresholdTokens: params.thresholdTokens,
    counter: params.counter,
    recentTurnsPreserve: params.recentTurnsPreserve,
    summaryOverride: params.summaryOverride,
    countMessageTokens: (messages) => countMessageTokens({ messages, counter: params.counter }),
  });
}

export { splitPreservedRecentTurns };
