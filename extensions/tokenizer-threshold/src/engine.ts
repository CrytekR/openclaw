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
import { computeTokenizerThresholdCompaction } from "./compact-logic.js";
import type { TokenizerThresholdConfig } from "./config.js";
import { splitMessagesAtCutPoint } from "./cut-point.js";
import { summarizeWithRuntimeLlm } from "./llm-summary.js";
import {
  fingerprintSummarizableMessages,
  getSessionCompactionState,
  nextCompactionTriggerCount,
  resolveSessionStateKey,
  setSessionCompactionState,
  type TokenizerThresholdSessionState,
} from "./session-state.js";
import { getCachedSystemPrompt } from "./system-prompt-cache.js";
import { countPromptTokens, createTokenCounter, type TokenCounter } from "./tokenizer.js";
import { getCachedToolsSchemaTokens } from "./tools-schema-cache.js";

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
  tokenizerDegraded?: boolean;
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
        compactionTriggerCount: params.state.compactionTriggerCount,
        ...(params.tokenizerDegraded ? { tokenizerDegraded: true } : {}),
        checkpointTrigger: buildContextEngineCheckpointTrigger({
          currentTokenCount: params.state.tokensBefore,
          thresholdTokens: params.thresholdTokens,
          tokenBudget: params.tokenBudget,
        }),
      },
    },
  };
}

function inferSummaryFromLlm(params: {
  summaryFromLlmHint?: boolean;
  summaryOverride?: string;
  reusableSummary?: string;
  reusableSummaryFromLlm: boolean;
  computationSummary: string;
}): boolean {
  const overrideBody = params.summaryOverride?.trim() ?? "";
  return Boolean(
    params.summaryFromLlmHint ||
    (overrideBody &&
      params.reusableSummaryFromLlm &&
      (params.reusableSummary === params.summaryOverride ||
        params.computationSummary === overrideBody ||
        params.computationSummary.includes(overrideBody))),
  );
}

function persistCompactionState(params: {
  stateKey: string;
  sourceMessages: AgentMessage[];
  computation: {
    summarizableCount: number;
    messages: AgentMessage[];
    tokensBefore: number;
    tokensAfter: number;
    summary: string;
  };
  summarizableFingerprint: string;
  compactionTriggerCount: number;
  summaryFromLlm: boolean;
}): TokenizerThresholdSessionState {
  const state: TokenizerThresholdSessionState = {
    compactedSourceLength: params.sourceMessages.length,
    summarizableCount: params.computation.summarizableCount,
    summarizableFingerprint: params.summarizableFingerprint,
    compactedMessages: params.computation.messages,
    tokensBefore: params.computation.tokensBefore,
    tokensAfter: params.computation.tokensAfter,
    summary: params.computation.summary,
    summaryFromLlm: params.summaryFromLlm,
    compactionTriggerCount: params.compactionTriggerCount,
  };
  setSessionCompactionState(params.stateKey, state);
  return state;
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
  /** Shared counter from plugin register (warn + degraded state). */
  counter?: TokenCounter;
  /**
   * Lazy resolver for api.runtime.llm.complete. Invoked from assemble/compact
   * so the runtime facade can be ready after plugin register.
   */
  resolveLlmComplete?: () => RuntimeLlmComplete | undefined;
}) {
  const counter = params.counter ?? createTokenCounter(params.config);
  let compactInFlight: Promise<CompactResult> | null = null;

  const runEngineCompaction = (compactParams: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
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
      getCachedSystemPrompt({
        sessionId: compactParams.sessionId,
        sessionKey: compactParams.sessionKey,
      });
    const toolsSchemaTokens = getCachedToolsSchemaTokens({
      sessionId: compactParams.sessionId,
      sessionKey: compactParams.sessionKey,
    });
    const reusable = resolveReusableSummary({
      stateKey,
      messages: compactParams.messages,
      keepRecentTokens: params.config.keepRecentTokens,
      counter,
    });
    const compactionTriggerCount = nextCompactionTriggerCount({
      existing: getSessionCompactionState(stateKey),
      summarizableFingerprint: reusable.summarizableFingerprint,
    });
    const summaryOverride = compactParams.summaryOverride?.trim() || reusable.summary;
    const computation = computeTokenizerThresholdCompaction({
      messages: compactParams.messages,
      thresholdTokens: params.config.thresholdTokens,
      counter,
      keepRecentTokens: params.config.keepRecentTokens,
      summaryOverride,
      systemPrompt,
      toolsSchemaTokens,
      compactionTriggerCount,
    });
    if (!computation.compacted) {
      return {
        ok: true,
        compacted: false,
        ...(computation.reason ? { reason: computation.reason } : {}),
      };
    }

    const state = persistCompactionState({
      stateKey,
      sourceMessages: compactParams.messages,
      computation,
      summarizableFingerprint: reusable.summarizableFingerprint,
      compactionTriggerCount,
      summaryFromLlm: inferSummaryFromLlm({
        summaryFromLlmHint: compactParams.summaryFromLlm,
        summaryOverride,
        reusableSummary: reusable.summary,
        reusableSummaryFromLlm: reusable.summaryFromLlm,
        computationSummary: computation.summary,
      }),
    });
    return toCompactResult({
      state,
      thresholdTokens: params.config.thresholdTokens,
      tokenizerModel: params.config.tokenizerModel,
      tokenBudget: compactParams.tokenBudget,
      tokenizerDegraded: counter.isDegraded(),
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
      const systemPrompt = getCachedSystemPrompt({
        sessionId: assembleParams.sessionId,
        sessionKey: assembleParams.sessionKey,
      });
      const toolsSchemaTokens = getCachedToolsSchemaTokens({
        sessionId: assembleParams.sessionId,
        sessionKey: assembleParams.sessionKey,
      });
      const tokensBefore = countPromptTokens({
        messages: assembleParams.messages,
        systemPrompt,
        toolsSchemaTokens,
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
      const compactionTriggerCount = nextCompactionTriggerCount({
        existing: getSessionCompactionState(stateKey),
        summarizableFingerprint: reusable.summarizableFingerprint,
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
        keepRecentTokens: params.config.keepRecentTokens,
        summaryOverride: resolved.summary,
        systemPrompt,
        toolsSchemaTokens,
        compactionTriggerCount,
      });

      if (computation.compacted) {
        persistCompactionState({
          stateKey,
          sourceMessages: assembleParams.messages,
          computation,
          summarizableFingerprint: reusable.summarizableFingerprint,
          compactionTriggerCount,
          // Require the resolved LLM body to actually land in computation.summary.
          summaryFromLlm: inferSummaryFromLlm({
            summaryOverride: resolved.summary,
            reusableSummary: resolved.summary,
            reusableSummaryFromLlm: Boolean(resolved.summaryFromLlm),
            computationSummary: computation.summary,
          }),
        });
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
              tokenizerDegraded: counter.isDegraded(),
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
