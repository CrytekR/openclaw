/**
 * Context engine that owns threshold compaction with a local tokenizer.
 *
 * Compaction happens only in assemble() (prompt path / mid-loop):
 *   [user message wrapping <summary>...</summary>] + keepRecentTokens contiguous tail
 *
 * When over threshold, assemble prefers api.runtime.llm.complete for the summary
 * (injected at plugin register), then falls back to extractive text.
 *
 * afterTurn is intentionally a no-op — no compaction work there.
 * compact() reuses the assemble-built in-memory view for host checkpoints, or
 * can compact an explicit runtimeContext.messages list (same LLM resolver).
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";
import { computeTokenizerThresholdCompaction, splitMessagesAtCutPoint } from "./compact-logic.js";
import type { TokenizerThresholdConfig } from "./config.js";
import { summarizeWithRuntimeLlm } from "./llm-summary.js";
import {
  fingerprintSummarizableMessages,
  getSessionCompactionState,
  resolveSessionStateKey,
  setSessionCompactionState,
  type TokenizerThresholdSessionState,
} from "./session-state.js";
import { getCachedSystemPrompt } from "./system-prompt-cache.js";
import { countPromptTokens, createTokenCounter, type TokenCounter } from "./tokenizer.js";

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

export type RuntimeLlmComplete = (params: {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  purpose?: string;
  signal?: AbortSignal;
}) => Promise<{ text: string }>;

function resolveCachedSystemPrompt(params: {
  sessionId: string;
  sessionKey?: string;
}): string | undefined {
  return getCachedSystemPrompt({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });
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
  tokenizerModel: TokenizerThresholdConfig["tokenizerModel"];
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
        tokenizerModel: params.tokenizerModel,
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
  keepRecentTokens: number;
  counter: TokenCounter;
}): { summary?: string; summaryFromLlm: boolean; summarizableFingerprint: string } {
  const split = splitMessagesAtCutPoint({
    messages: params.messages,
    keepRecentTokens: params.keepRecentTokens,
    counter: params.counter,
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

async function resolveSummaryForCompaction(params: {
  messages: AgentMessage[];
  keepRecentTokens: number;
  counter: TokenCounter;
  reusable: { summary?: string; summaryFromLlm: boolean };
  llmComplete?: RuntimeLlmComplete;
  signal?: AbortSignal;
}): Promise<{ summary?: string; summaryFromLlm: boolean }> {
  if (params.reusable.summaryFromLlm && params.reusable.summary?.trim()) {
    return {
      summary: params.reusable.summary,
      summaryFromLlm: true,
    };
  }

  const llmComplete = params.llmComplete;
  if (llmComplete) {
    const split = splitMessagesAtCutPoint({
      messages: params.messages,
      keepRecentTokens: params.keepRecentTokens,
      counter: params.counter,
    });
    if (split.summarizableMessages.length > 0) {
      const llmSummary = await summarizeWithRuntimeLlm({
        messages: split.summarizableMessages,
        llmComplete,
        previousSummary: params.reusable.summary,
        signal: params.signal,
      });
      if (llmSummary?.trim()) {
        return { summary: llmSummary, summaryFromLlm: true };
      }
    }
  }

  return {
    summary: params.reusable.summary,
    summaryFromLlm: params.reusable.summaryFromLlm,
  };
}

export function createTokenizerThresholdContextEngine(params: {
  config: TokenizerThresholdConfig;
  /**
   * Lazy resolver for api.runtime.llm.complete. Invoked from assemble/compact
   * so the runtime facade can be ready after plugin register.
   */
  resolveLlmComplete?: () => RuntimeLlmComplete | undefined;
}) {
  const counter = createTokenCounter(params.config);
  let compactInFlight: Promise<CompactResult> | null = null;

  const runEngineCompaction = (compactParams: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    force?: boolean;
    tokenBudget?: number;
    summaryOverride?: string;
    summaryFromLlm?: boolean;
    systemPrompt?: string;
  }): CompactResult => {
    const stateKey = resolveSessionStateKey({
      sessionId: compactParams.sessionId,
      sessionKey: compactParams.sessionKey,
    });
    const systemPrompt =
      compactParams.systemPrompt ??
      resolveCachedSystemPrompt({
        sessionId: compactParams.sessionId,
        sessionKey: compactParams.sessionKey,
      });
    const reusable = resolveReusableSummary({
      stateKey,
      messages: compactParams.messages,
      keepRecentTokens: params.config.keepRecentTokens,
      counter,
    });
    const summaryOverride = compactParams.summaryOverride?.trim() || reusable.summary;
    const computation = computeTokenizerThresholdCompaction({
      messages: compactParams.messages,
      thresholdTokens: params.config.thresholdTokens,
      counter,
      force: compactParams.force,
      keepRecentTokens: params.config.keepRecentTokens,
      summaryOverride,
      systemPrompt,
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
      summarizableFingerprint: reusable.summarizableFingerprint,
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
      tokenizerModel: params.config.tokenizerModel,
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

    async afterTurn(_afterTurnParams: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
      messages: AgentMessage[];
      prePromptMessageCount: number;
      tokenBudget?: number;
      runtimeContext?: Record<string, unknown>;
    }) {
      // Compaction is assemble-only. Mid-loop and turn-start assemble check the
      // threshold and shrink the next prompt; afterTurn must not duplicate work
      // or race the live tool loop with a second LLM summary.
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
      const stateKey = resolveSessionStateKey({
        sessionId: assembleParams.sessionId,
        sessionKey: assembleParams.sessionKey,
      });
      const systemPrompt = resolveCachedSystemPrompt({
        sessionId: assembleParams.sessionId,
        sessionKey: assembleParams.sessionKey,
      });
      const tokensBefore = countPromptTokens({
        messages: assembleParams.messages,
        systemPrompt,
        counter,
      });

      // Under budget: leave the prompt untouched.
      if (tokensBefore < params.config.thresholdTokens) {
        return {
          messages: assembleParams.messages,
          estimatedTokens: tokensBefore,
          systemPromptAddition: buildMemorySystemPromptAddition({
            availableTools: assembleParams.availableTools ?? new Set(),
            citationsMode: assembleParams.citationsMode,
          }),
        };
      }

      const reusable = resolveReusableSummary({
        stateKey,
        messages: assembleParams.messages,
        keepRecentTokens: params.config.keepRecentTokens,
        counter,
      });
      const resolved = await resolveSummaryForCompaction({
        messages: assembleParams.messages,
        keepRecentTokens: params.config.keepRecentTokens,
        counter,
        reusable,
        llmComplete: params.resolveLlmComplete?.(),
      });
      const computation = computeTokenizerThresholdCompaction({
        messages: assembleParams.messages,
        thresholdTokens: params.config.thresholdTokens,
        counter,
        force: true,
        keepRecentTokens: params.config.keepRecentTokens,
        summaryOverride: resolved.summary,
        systemPrompt,
      });

      if (computation.compacted) {
        const state: TokenizerThresholdSessionState = {
          compactedSourceLength: assembleParams.messages.length,
          summarizableCount: computation.summarizableCount,
          summarizableFingerprint: reusable.summarizableFingerprint,
          compactedMessages: computation.messages,
          tokensBefore: computation.tokensBefore,
          tokensAfter: computation.tokensAfter,
          summary: computation.summary,
          summaryFromLlm: Boolean(
            resolved.summaryFromLlm && resolved.summary && resolved.summary === computation.summary,
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
            const stateKey = resolveSessionStateKey({
              sessionId: compactParams.sessionId,
              sessionKey: compactParams.sessionKey,
            });
            const reusable = resolveReusableSummary({
              stateKey,
              messages,
              keepRecentTokens: params.config.keepRecentTokens,
              counter,
            });
            const resolved = await resolveSummaryForCompaction({
              messages,
              keepRecentTokens: params.config.keepRecentTokens,
              counter,
              reusable,
              llmComplete: params.resolveLlmComplete?.(),
              signal: compactParams.abortSignal,
            });
            return runEngineCompaction({
              sessionId: compactParams.sessionId,
              sessionKey: compactParams.sessionKey,
              messages,
              force: compactParams.force ?? true,
              tokenBudget: compactParams.tokenBudget,
              summaryOverride: resolved.summary,
              summaryFromLlm: resolved.summaryFromLlm,
            });
          }

          // Host overflow/`/compact` often omit the live message list. Reuse the
          // engine view prepared by assemble so CompactResult counts still reach
          // host checkpoint persistence.
          const stateKey = resolveSessionStateKey({
            sessionId: compactParams.sessionId,
            sessionKey: compactParams.sessionKey,
          });
          const state = getSessionCompactionState(stateKey);
          if (state) {
            return toCompactResult({
              state,
              thresholdTokens: params.config.thresholdTokens,
              tokenizerModel: params.config.tokenizerModel,
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
