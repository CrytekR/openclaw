/**
 * Context engine that decides compaction from a local tokenizer threshold.
 *
 * Path: assemble only windows the in-flight prompt; afterTurn triggers durable
 * compaction when over threshold. Same-turn host retry (overflow recovery)
 * still calls compact() and reloads the session before the next assemble.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
  type ContextEngineSessionTarget,
} from "openclaw/plugin-sdk/core";
import type { TokenizerThresholdConfig } from "./config.js";
import { countMessageTokens, getLocalTokenCounter, type TokenCounter } from "./tokenizer.js";

type CompactResult = Awaited<ReturnType<typeof delegateCompactionToRuntime>>;

type SessionBinding = {
  sessionFile?: string;
  sessionKey?: string;
};

function keepRecentMessagesUnderThreshold(params: {
  messages: AgentMessage[];
  thresholdTokens: number;
  counter: TokenCounter;
}): { messages: AgentMessage[]; estimatedTokens: number; trimmed: boolean } {
  const fullCount = countMessageTokens({ messages: params.messages, counter: params.counter });
  if (fullCount <= params.thresholdTokens || params.messages.length <= 1) {
    return {
      messages: params.messages,
      estimatedTokens: fullCount,
      trimmed: false,
    };
  }

  // Keep the newest suffix that still fits under the tokenizer threshold so
  // this attempt stays under the local gate while afterTurn / host overflow
  // owns durable transcript compaction for the next assemble.
  let low = 1;
  let high = params.messages.length;
  let bestStart = params.messages.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = params.messages.length - mid;
    const slice = params.messages.slice(start);
    const tokens = countMessageTokens({ messages: slice, counter: params.counter });
    if (tokens <= params.thresholdTokens) {
      bestStart = start;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const trimmedMessages = params.messages.slice(bestStart);
  return {
    messages: trimmedMessages,
    estimatedTokens: countMessageTokens({
      messages: trimmedMessages,
      counter: params.counter,
    }),
    trimmed: trimmedMessages.length !== params.messages.length,
  };
}

function resolveCurrentTokenCount(params: {
  messages: AgentMessage[];
  counter: TokenCounter;
  runtimeContext?: Record<string, unknown>;
}): number {
  const fromRuntime = params.runtimeContext?.currentTokenCount;
  if (typeof fromRuntime === "number" && Number.isFinite(fromRuntime) && fromRuntime > 0) {
    return Math.floor(fromRuntime);
  }
  return countMessageTokens({ messages: params.messages, counter: params.counter });
}

export function createTokenizerThresholdContextEngine(params: {
  config: TokenizerThresholdConfig;
}) {
  const counter = getLocalTokenCounter(params.config.encoding);
  const bindings = new Map<string, SessionBinding>();
  let compactInFlight: Promise<CompactResult> | null = null;

  const rememberBinding = (sessionId: string, binding: SessionBinding) => {
    const previous = bindings.get(sessionId) ?? {};
    bindings.set(sessionId, {
      ...previous,
      ...(binding.sessionFile ? { sessionFile: binding.sessionFile } : {}),
      ...(binding.sessionKey ? { sessionKey: binding.sessionKey } : {}),
    });
  };

  const compactIfOverThreshold = async (compactParams: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    sessionTarget?: ContextEngineSessionTarget;
    tokenBudget?: number;
    currentTokenCount: number;
    runtimeContext?: Record<string, unknown>;
  }) => {
    if (compactParams.currentTokenCount < params.config.thresholdTokens) {
      return null;
    }
    return engine.compact({
      sessionId: compactParams.sessionId,
      sessionKey: compactParams.sessionKey,
      sessionFile: compactParams.sessionFile,
      sessionTarget: compactParams.sessionTarget,
      tokenBudget: compactParams.tokenBudget,
      currentTokenCount: compactParams.currentTokenCount,
      force: true,
      runtimeContext: compactParams.runtimeContext,
    });
  };

  const engine = {
    info: {
      id: "tokenizer-threshold",
      name: "Tokenizer Threshold",
      ownsCompaction: true as const,
    },

    async bootstrap(bootstrapParams: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
    }) {
      rememberBinding(bootstrapParams.sessionId, {
        sessionFile: bootstrapParams.sessionFile,
        sessionKey: bootstrapParams.sessionKey,
      });
      return { bootstrapped: true };
    },

    async ingest() {
      return { ingested: true };
    },

    async afterTurn(afterTurnParams: {
      sessionId: string;
      sessionKey?: string;
      sessionTarget?: ContextEngineSessionTarget;
      sessionFile: string;
      messages: AgentMessage[];
      prePromptMessageCount: number;
      tokenBudget?: number;
      runtimeContext?: Record<string, unknown>;
    }) {
      // Proactive durable compaction belongs here so the host can reload the
      // successor transcript before the next assemble(); same-turn recovery
      // still goes through host overflow -> compact() -> retry.
      rememberBinding(afterTurnParams.sessionId, {
        sessionFile: afterTurnParams.sessionFile,
        sessionKey: afterTurnParams.sessionKey,
      });
      const currentTokenCount = resolveCurrentTokenCount({
        messages: afterTurnParams.messages,
        counter,
        runtimeContext: afterTurnParams.runtimeContext,
      });
      await compactIfOverThreshold({
        sessionId: afterTurnParams.sessionId,
        sessionKey: afterTurnParams.sessionKey,
        sessionFile: afterTurnParams.sessionFile,
        sessionTarget: afterTurnParams.sessionTarget,
        tokenBudget: afterTurnParams.tokenBudget,
        currentTokenCount,
        runtimeContext: afterTurnParams.runtimeContext,
      });
    },

    async assemble(assembleParams: {
      sessionId: string;
      sessionKey?: string;
      messages: AgentMessage[];
      tokenBudget?: number;
      availableTools?: Set<string>;
      citationsMode?: "off" | "on" | "auto";
      model?: string;
      prompt?: string;
    }) {
      // Admission only: window the in-flight prompt. Do not compact here —
      // CompactResult has no messages, and host adopt/retry owns post-compact
      // session reload before the next assemble.
      const windowed = keepRecentMessagesUnderThreshold({
        messages: assembleParams.messages,
        thresholdTokens: params.config.thresholdTokens,
        counter,
      });
      return {
        messages: windowed.messages,
        estimatedTokens: windowed.estimatedTokens,
        promptAuthority: "assembled" as const,
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: assembleParams.availableTools ?? new Set(),
          citationsMode: assembleParams.citationsMode,
          agentSessionKey: assembleParams.sessionKey,
        }),
      };
    },

    async compact(compactParams: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
      sessionTarget?: ContextEngineSessionTarget;
      tokenBudget?: number;
      force?: boolean;
      currentTokenCount?: number;
      customInstructions?: string;
      runtimeContext?: Record<string, unknown>;
      abortSignal?: AbortSignal;
    }): Promise<CompactResult> {
      if (compactInFlight) {
        return compactInFlight;
      }
      rememberBinding(compactParams.sessionId, {
        sessionFile: compactParams.sessionFile,
        sessionKey: compactParams.sessionKey,
      });
      compactInFlight = delegateCompactionToRuntime({
        ...compactParams,
        force: compactParams.force ?? true,
        runtimeContext: compactParams.runtimeContext,
      }).finally(() => {
        compactInFlight = null;
      });
      return compactInFlight;
    },
  };

  return engine;
}
