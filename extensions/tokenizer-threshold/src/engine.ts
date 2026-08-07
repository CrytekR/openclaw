/**
 * Context engine that owns threshold compaction with a local tokenizer.
 *
 * Compaction logic lives in this engine (no runtime delegate / session lock):
 * - assemble returns a trailing local-tokenizer window under the threshold
 * - afterTurn refreshes the engine-owned compacted view for later host compact()
 * - compact() returns CompactResult.tokensBefore/tokensAfter so host checkpoint
 *   records and compaction hooks can persist those counts
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";
import { computeTokenizerThresholdCompaction } from "./compact-logic.js";
import type { TokenizerThresholdConfig } from "./config.js";
import {
  getSessionCompactionState,
  resolveSessionStateKey,
  setSessionCompactionState,
  type TokenizerThresholdSessionState,
} from "./session-state.js";
import { countMessageTokens, getLocalTokenCounter, type TokenCounter } from "./tokenizer.js";
import { windowMessagesToTokenBudget } from "./window.js";

type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
};

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

function toCompactResult(params: {
  state: TokenizerThresholdSessionState;
  thresholdTokens: number;
  encoding: TokenizerThresholdConfig["encoding"];
  tokenBudget?: number;
}): CompactResult {
  return {
    ok: true,
    compacted: true,
    result: {
      summary: params.state.summary,
      tokensBefore: params.state.tokensBefore,
      tokensAfter: params.state.tokensAfter,
      details: {
        engine: "tokenizer-threshold",
        thresholdTokens: params.thresholdTokens,
        encoding: params.encoding,
        checkpointTrigger: buildContextEngineCheckpointTrigger({
          currentTokenCount: params.state.tokensBefore,
          thresholdTokens: params.thresholdTokens,
          tokenBudget: params.tokenBudget,
        }),
      },
    },
  };
}

export function createTokenizerThresholdContextEngine(params: {
  config: TokenizerThresholdConfig;
}) {
  const counter = getLocalTokenCounter(params.config.encoding);
  let compactInFlight: Promise<CompactResult> | null = null;

  const runEngineCompaction = (compactParams: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    force?: boolean;
    tokenBudget?: number;
  }): CompactResult => {
    const stateKey = resolveSessionStateKey({
      sessionId: compactParams.sessionId,
      sessionKey: compactParams.sessionKey,
    });
    const computation = computeTokenizerThresholdCompaction({
      messages: compactParams.messages,
      thresholdTokens: params.config.thresholdTokens,
      counter,
      force: compactParams.force,
    });
    if (!computation.compacted) {
      return {
        ok: true,
        compacted: false,
        ...(computation.reason ? { reason: computation.reason } : {}),
      };
    }

    const state: TokenizerThresholdSessionState = {
      compactedSourceLength: compactParams.messages.length,
      compactedMessages: computation.messages,
      tokensBefore: computation.tokensBefore,
      tokensAfter: computation.tokensAfter,
      summary: computation.summary,
    };
    setSessionCompactionState(stateKey, state);
    return toCompactResult({
      state,
      thresholdTokens: params.config.thresholdTokens,
      encoding: params.config.encoding,
      tokenBudget: compactParams.tokenBudget,
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
      // Engine-owned view only — no session write lock, safe in tool loops.
      // Host compaction records are written when the host calls compact().
      const currentTokenCount = resolveCurrentTokenCount({
        messages: afterTurnParams.messages,
        counter,
      });
      if (currentTokenCount < params.config.thresholdTokens) {
        return;
      }
      runEngineCompaction({
        sessionId: afterTurnParams.sessionId,
        sessionKey: afterTurnParams.sessionKey,
        messages: afterTurnParams.messages,
        force: true,
        tokenBudget: afterTurnParams.tokenBudget,
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
      // Prompt path: always return a local-tokenizer window under threshold so
      // mid-loop model calls stay bounded even before/without durable host records.
      const windowed = windowMessagesToTokenBudget({
        messages: assembleParams.messages,
        thresholdTokens: params.config.thresholdTokens,
        counter,
      });
      if (windowed.messages.length < assembleParams.messages.length) {
        runEngineCompaction({
          sessionId: assembleParams.sessionId,
          sessionKey: assembleParams.sessionKey,
          messages: assembleParams.messages,
          force: true,
          tokenBudget: assembleParams.tokenBudget,
        });
      }
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

      const runtimeMessages = compactParams.runtimeContext?.messages;
      const messages = Array.isArray(runtimeMessages)
        ? (runtimeMessages as AgentMessage[])
        : undefined;

      compactInFlight = Promise.resolve()
        .then(() => {
          if (compactParams.abortSignal?.aborted) {
            return {
              ok: false,
              compacted: false,
              reason: "aborted",
            } satisfies CompactResult;
          }
          if (messages) {
            return runEngineCompaction({
              sessionId: compactParams.sessionId,
              sessionKey: compactParams.sessionKey,
              messages,
              force: compactParams.force ?? true,
              tokenBudget: compactParams.tokenBudget,
            });
          }

          // Host overflow/`/compact` often omit the live message list. Reuse the
          // engine view prepared by assemble/afterTurn so CompactResult counts
          // still reach host checkpoint persistence.
          const stateKey = resolveSessionStateKey({
            sessionId: compactParams.sessionId,
            sessionKey: compactParams.sessionKey,
          });
          const state = getSessionCompactionState(stateKey);
          if (state) {
            return toCompactResult({
              state,
              thresholdTokens: params.config.thresholdTokens,
              encoding: params.config.encoding,
              tokenBudget: compactParams.tokenBudget,
            });
          }
          return {
            ok: true,
            compacted: false,
            reason: "no messages available for engine compaction",
          } satisfies CompactResult;
        })
        .finally(() => {
          compactInFlight = null;
        });

      return compactInFlight;
    },
  };

  return engine;
}
