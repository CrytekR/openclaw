/**
 * Context engine that decides compaction from a local tokenizer threshold.
 *
 * assemble passes host messages through unchanged. afterTurn triggers durable
 * compaction when over threshold. Same-turn host retry (overflow recovery)
 * still calls compact() and reloads the session before the next assemble.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
} from "openclaw/plugin-sdk/core";
import type { TokenizerThresholdConfig } from "./config.js";
import { countMessageTokens, getLocalTokenCounter, type TokenCounter } from "./tokenizer.js";

type CompactResult = Awaited<ReturnType<typeof delegateCompactionToRuntime>>;

function resolveCurrentTokenCount(params: {
  messages: AgentMessage[];
  counter: TokenCounter;
}): number {
  // Gate on the local tokenizer view of session messages. Host usage snapshots
  // (runtimeContext.currentTokenCount) can lag, jump after a large tool turn,
  // or disagree with tiktoken — preferring them delayed compaction far past
  // the configured threshold.
  return countMessageTokens({ messages: params.messages, counter: params.counter });
}

/** Build the checkpoint trigger snapshot for plugin-owned threshold compaction. */
export function buildContextEngineCheckpointTrigger(params: {
  currentTokenCount: number;
  thresholdTokens: number;
  tokenBudget?: number;
}) {
  return {
    path: "context_engine" as const,
    trigger: "threshold" as const,
    projectedTokens: Math.floor(params.currentTokenCount),
    thresholdTokens: Math.floor(params.thresholdTokens),
    ...(typeof params.tokenBudget === "number" &&
    Number.isFinite(params.tokenBudget) &&
    params.tokenBudget > 0
      ? { contextWindowTokens: Math.floor(params.tokenBudget) }
      : {}),
  };
}

export function createTokenizerThresholdContextEngine(params: {
  config: TokenizerThresholdConfig;
}) {
  const counter = getLocalTokenCounter(params.config.encoding);
  let compactInFlight: Promise<CompactResult> | null = null;

  const compactIfOverThreshold = async (compactParams: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    currentTokenCount: number;
    runtimeContext?: Record<string, unknown>;
  }) => {
    if (compactParams.currentTokenCount < params.config.thresholdTokens) {
      return null;
    }
    // Attach path+calc facts so checkpoint reason shows "Context engine" with
    // the local tokenizer count and configured threshold, not the generic
    // Auto threshold fallback.
    const checkpointTrigger = buildContextEngineCheckpointTrigger({
      currentTokenCount: compactParams.currentTokenCount,
      thresholdTokens: params.config.thresholdTokens,
      tokenBudget: compactParams.tokenBudget,
    });
    return engine.compact({
      sessionId: compactParams.sessionId,
      sessionKey: compactParams.sessionKey,
      sessionFile: compactParams.sessionFile,
      tokenBudget: compactParams.tokenBudget,
      currentTokenCount: compactParams.currentTokenCount,
      force: true,
      runtimeContext: {
        ...compactParams.runtimeContext,
        checkpointTrigger,
      },
    });
  };

  const engine = {
    info: {
      id: "tokenizer-threshold",
      name: "Tokenizer Threshold",
      ownsCompaction: true as const,
    },

    async bootstrap() {
      return { bootstrapped: true };
    },

    async ingest() {
      return { ingested: true };
    },

    async afterTurn(afterTurnParams: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
      messages: AgentMessage[];
      prePromptMessageCount: number;
      tokenBudget?: number;
      runtimeContext?: Record<string, unknown>;
    }) {
      // Proactive durable compaction belongs here so the host can reload the
      // successor transcript before the next assemble(); same-turn recovery
      // still goes through host overflow -> compact() -> retry.
      const currentTokenCount = resolveCurrentTokenCount({
        messages: afterTurnParams.messages,
        counter,
      });
      await compactIfOverThreshold({
        sessionId: afterTurnParams.sessionId,
        sessionKey: afterTurnParams.sessionKey,
        sessionFile: afterTurnParams.sessionFile,
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
      // Pass-through: host owns session reload after compact/retry. This
      // engine only reports a local tokenizer estimate for the prompt view.
      return {
        messages: assembleParams.messages,
        estimatedTokens: countMessageTokens({
          messages: assembleParams.messages,
          counter,
        }),
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: assembleParams.availableTools ?? new Set(),
          citationsMode: assembleParams.citationsMode,
        }),
      };
    },

    async compact(compactParams: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
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
