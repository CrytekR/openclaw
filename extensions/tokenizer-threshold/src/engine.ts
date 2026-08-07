/**
 * Context engine that owns threshold compaction with a local tokenizer.
 *
 * Compaction mirrors native agent-core / safeguard shape:
 *   [user message wrapping <summary>...</summary>] + preserved recent turns
 *
 * - assemble() returns that compacted message list under the local threshold
 *   (extractive summary when no LLM summary is cached yet)
 * - afterTurn() refreshes the engine-owned view and optionally upgrades the
 *   summary via runtimeContext.llm when available
 * - compact() returns CompactResult.tokensBefore/tokensAfter for host checkpoints
 *
 * No runtime delegate / session write lock — safe inside live tool loops.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";
import { computeTokenizerThresholdCompaction, splitPreservedRecentTurns } from "./compact-logic.js";
import type { TokenizerThresholdConfig } from "./config.js";
import { summarizeWithRuntimeLlm } from "./llm-summary.js";
import {
  fingerprintSummarizableMessages,
  getSessionCompactionState,
  resolveSessionStateKey,
  setSessionCompactionState,
  type TokenizerThresholdSessionState,
} from "./session-state.js";
import { countMessageTokens, getLocalTokenCounter, type TokenCounter } from "./tokenizer.js";

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

type RuntimeLlm = {
  complete: (params: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
    purpose?: string;
    signal?: AbortSignal;
  }) => Promise<{ text: string }>;
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

function resolveRuntimeLlm(runtimeContext?: Record<string, unknown>): RuntimeLlm | undefined {
  const llm = runtimeContext?.llm;
  if (!llm || typeof llm !== "object") {
    return undefined;
  }
  const complete = (llm as { complete?: unknown }).complete;
  return typeof complete === "function" ? (llm as RuntimeLlm) : undefined;
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
        summaryFromLlm: params.state.summaryFromLlm,
        checkpointTrigger: buildContextEngineCheckpointTrigger({
          currentTokenCount: params.state.tokensBefore,
          thresholdTokens: params.thresholdTokens,
          tokenBudget: params.tokenBudget,
        }),
      },
    },
  };
}

function resolveReusableSummary(params: {
  stateKey: string;
  messages: AgentMessage[];
  recentTurnsPreserve: number;
}): { summary?: string; summaryFromLlm: boolean; summarizableFingerprint: string } {
  const split = splitPreservedRecentTurns({
    messages: params.messages,
    recentTurnsPreserve: params.recentTurnsPreserve,
  });
  const summarizableFingerprint = fingerprintSummarizableMessages(split.summarizableMessages);
  const existing = getSessionCompactionState(params.stateKey);
  if (existing?.summary?.trim() && existing.summarizableFingerprint === summarizableFingerprint) {
    return {
      summary: existing.summary,
      summaryFromLlm: existing.summaryFromLlm,
      summarizableFingerprint,
    };
  }
  return { summaryFromLlm: false, summarizableFingerprint };
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
    summaryOverride?: string;
    summaryFromLlm?: boolean;
  }): CompactResult => {
    const stateKey = resolveSessionStateKey({
      sessionId: compactParams.sessionId,
      sessionKey: compactParams.sessionKey,
    });
    const reusable = resolveReusableSummary({
      stateKey,
      messages: compactParams.messages,
      recentTurnsPreserve: params.config.recentTurnsPreserve,
    });
    const summaryOverride = compactParams.summaryOverride?.trim() || reusable.summary;
    const computation = computeTokenizerThresholdCompaction({
      messages: compactParams.messages,
      thresholdTokens: params.config.thresholdTokens,
      counter,
      force: compactParams.force,
      recentTurnsPreserve: params.config.recentTurnsPreserve,
      summaryOverride,
    });
    if (!computation.compacted) {
      return {
        ok: true,
        compacted: false,
        ...(computation.reason ? { reason: computation.reason } : {}),
      };
    }

    const summaryFromLlm = Boolean(
      compactParams.summaryFromLlm ||
      (summaryOverride && reusable.summary === summaryOverride && reusable.summaryFromLlm),
    );
    const state: TokenizerThresholdSessionState = {
      compactedSourceLength: compactParams.messages.length,
      summarizableCount: computation.summarizableCount,
      summarizableFingerprint:
        reusable.summarizableFingerprint ||
        fingerprintSummarizableMessages(
          compactParams.messages.slice(0, computation.preservedStartIndex),
        ),
      compactedMessages: computation.messages,
      tokensBefore: computation.tokensBefore,
      tokensAfter: computation.tokensAfter,
      summary: computation.summary,
      summaryFromLlm,
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
      const currentTokenCount = resolveCurrentTokenCount({
        messages: afterTurnParams.messages,
        counter,
      });
      if (currentTokenCount < params.config.thresholdTokens) {
        return;
      }

      const stateKey = resolveSessionStateKey({
        sessionId: afterTurnParams.sessionId,
        sessionKey: afterTurnParams.sessionKey,
      });
      const reusable = resolveReusableSummary({
        stateKey,
        messages: afterTurnParams.messages,
        recentTurnsPreserve: params.config.recentTurnsPreserve,
      });

      // Prefer LLM summary when the host provided runtimeContext.llm and we do
      // not already have a matching LLM-backed summary for this prefix.
      const llm = resolveRuntimeLlm(afterTurnParams.runtimeContext);
      if (llm && !reusable.summaryFromLlm) {
        const split = splitPreservedRecentTurns({
          messages: afterTurnParams.messages,
          recentTurnsPreserve: params.config.recentTurnsPreserve,
        });
        if (split.summarizableMessages.length > 0) {
          try {
            const llmSummary = await summarizeWithRuntimeLlm({
              messages: split.summarizableMessages,
              llmComplete: (request) => llm.complete(request),
              previousSummary: reusable.summary,
            });
            if (llmSummary?.trim()) {
              runEngineCompaction({
                sessionId: afterTurnParams.sessionId,
                sessionKey: afterTurnParams.sessionKey,
                messages: afterTurnParams.messages,
                force: true,
                tokenBudget: afterTurnParams.tokenBudget,
                summaryOverride: llmSummary,
                summaryFromLlm: true,
              });
              return;
            }
          } catch {
            // Fall through to extractive compact — never break the tool loop.
          }
        }
      }

      runEngineCompaction({
        sessionId: afterTurnParams.sessionId,
        sessionKey: afterTurnParams.sessionKey,
        messages: afterTurnParams.messages,
        force: true,
        tokenBudget: afterTurnParams.tokenBudget,
        summaryOverride: reusable.summary,
        summaryFromLlm: reusable.summaryFromLlm,
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
      // Prompt path: return native-style [summary user msg] + preserved recent
      // turns under the local threshold so mid-loop model calls stay bounded.
      const stateKey = resolveSessionStateKey({
        sessionId: assembleParams.sessionId,
        sessionKey: assembleParams.sessionKey,
      });
      const reusable = resolveReusableSummary({
        stateKey,
        messages: assembleParams.messages,
        recentTurnsPreserve: params.config.recentTurnsPreserve,
      });
      const computation = computeTokenizerThresholdCompaction({
        messages: assembleParams.messages,
        thresholdTokens: params.config.thresholdTokens,
        counter,
        force: true,
        recentTurnsPreserve: params.config.recentTurnsPreserve,
        summaryOverride: reusable.summary,
      });

      if (computation.compacted) {
        const state: TokenizerThresholdSessionState = {
          compactedSourceLength: assembleParams.messages.length,
          summarizableCount: computation.summarizableCount,
          summarizableFingerprint:
            reusable.summarizableFingerprint ||
            fingerprintSummarizableMessages(
              assembleParams.messages.slice(0, computation.preservedStartIndex),
            ),
          compactedMessages: computation.messages,
          tokensBefore: computation.tokensBefore,
          tokensAfter: computation.tokensAfter,
          summary: computation.summary,
          summaryFromLlm: Boolean(
            reusable.summary && reusable.summary === computation.summary && reusable.summaryFromLlm,
          ),
        };
        setSessionCompactionState(stateKey, state);
      }

      return {
        messages: computation.messages,
        estimatedTokens: computation.tokensAfter,
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
        .then(async () => {
          if (compactParams.abortSignal?.aborted) {
            return {
              ok: false,
              compacted: false,
              reason: "aborted",
            } satisfies CompactResult;
          }

          if (messages) {
            const llm = resolveRuntimeLlm(compactParams.runtimeContext);
            if (llm) {
              const split = splitPreservedRecentTurns({
                messages,
                recentTurnsPreserve: params.config.recentTurnsPreserve,
              });
              if (split.summarizableMessages.length > 0) {
                const llmSummary = await summarizeWithRuntimeLlm({
                  messages: split.summarizableMessages,
                  llmComplete: (request) => llm.complete(request),
                  signal: compactParams.abortSignal,
                });
                if (llmSummary?.trim()) {
                  return runEngineCompaction({
                    sessionId: compactParams.sessionId,
                    sessionKey: compactParams.sessionKey,
                    messages,
                    force: compactParams.force ?? true,
                    tokenBudget: compactParams.tokenBudget,
                    summaryOverride: llmSummary,
                    summaryFromLlm: true,
                  });
                }
              }
            }
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
