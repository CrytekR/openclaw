/**
 * Context engine that decides compaction from a local tokenizer threshold.
 *
 * assemble returns a trailing prompt window when over threshold so mid-loop
 * model calls shrink even while the live attempt holds the session write lock.
 * afterTurn performs durable runtime compaction only when that lock is free
 * (for example after abort releases it); otherwise it fails fast and leaves
 * prompt pressure to assemble windowing.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { acquireSessionWriteLock } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
} from "openclaw/plugin-sdk/core";
import type { TokenizerThresholdConfig } from "./config.js";
import { countMessageTokens, getLocalTokenCounter, type TokenCounter } from "./tokenizer.js";
import { windowMessagesToTokenBudget } from "./window.js";

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

/**
 * Durable compact opens its own SessionManager and session write lock. During a
 * live attempt that lock is already held, so a normal acquire waits up to the
 * default timeout and stalls the tool loop. Probe with a 1ms timeout instead.
 */
async function canAcquireSessionWriteLock(sessionFile: string): Promise<boolean> {
  try {
    const lock = await acquireSessionWriteLock({
      sessionFile,
      timeoutMs: 1,
      allowReentrant: false,
    });
    await lock.release();
    return true;
  } catch {
    return false;
  }
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
    // Skip durable compact while the live attempt still owns the session lock.
    // The loop-hook assemble path windows the prompt instead so the tool loop
    // keeps moving; abort/unlocked afterTurn still persists a real checkpoint.
    if (!(await canAcquireSessionWriteLock(compactParams.sessionFile))) {
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
      // Durable compaction runs only when the session write lock is free. Mid
      // tool-loop pressure is handled by assemble windowing below.
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
      // Mid-loop ownsCompaction hook: afterTurn may not be able to durable
      // compact under the live session lock, so return a trailing window that
      // fits under the threshold for the next provider call.
      const windowed = windowMessagesToTokenBudget({
        messages: assembleParams.messages,
        thresholdTokens: params.config.thresholdTokens,
        counter,
      });
      return {
        messages: windowed.messages,
        estimatedTokens: windowed.estimatedTokens,
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
