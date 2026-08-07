/**
 * Engine-owned compaction algorithm: keep a trailing local-tokenizer window.
 * No runtime delegate and no live session-file writer — the host prompt path
 * consumes the result through assemble()/CompactResult.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { countMessageTokens, type TokenCounter } from "./tokenizer.js";
import { windowMessagesToTokenBudget } from "./window.js";

export type EngineCompactComputation = {
  compacted: boolean;
  reason?: string;
  messages: AgentMessage[];
  tokensBefore: number;
  tokensAfter: number;
  summary: string;
};

/** Compute a compacted prompt view for the tokenizer-threshold engine. */
export function computeTokenizerThresholdCompaction(params: {
  messages: AgentMessage[];
  thresholdTokens: number;
  counter: TokenCounter;
  force?: boolean;
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
    };
  }

  if (!params.force && tokensBefore < params.thresholdTokens) {
    return {
      compacted: false,
      reason: "below threshold",
      messages: params.messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      summary: "",
    };
  }

  const windowed = windowMessagesToTokenBudget({
    messages: params.messages,
    thresholdTokens: params.thresholdTokens,
    counter: params.counter,
  });

  if (windowed.messages.length >= params.messages.length) {
    return {
      compacted: false,
      reason: "nothing to compact",
      messages: params.messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      summary: "",
    };
  }

  const dropped = params.messages.length - windowed.messages.length;
  return {
    compacted: true,
    messages: windowed.messages,
    tokensBefore,
    tokensAfter: windowed.estimatedTokens,
    summary:
      `Tokenizer-threshold kept ${windowed.messages.length} trailing message(s) ` +
      `(dropped ${dropped}) under ${params.thresholdTokens} local tokens ` +
      `(${tokensBefore} → ${windowed.estimatedTokens}).`,
  };
}
