/**
 * Native-style compaction message assembly for the context engine.
 *
 * Keep-tail uses agent-core findCutPoint semantics (keepRecentTokens), then
 * assembles:
 *   [user message wrapping <summary>...</summary>] + preserved contiguous tail
 *
 * Summary text may be extractive (assemble) or LLM-produced (afterTurn/compact
 * when runtimeContext.llm is available).
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { splitMessagesAtCutPoint } from "./cut-point.js";
import { extractMessageText, type TokenCounter } from "./tokenizer.js";
import { windowMessagesToTokenBudget } from "./window.js";

/** Same model-facing wrapper as packages/agent-core harness messages. */
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

const EXTRACTIVE_MAX_CHARS = 12_000;
const EXTRACTIVE_PER_MESSAGE_CHARS = 800;

export type NativeCompactAssembly = {
  compacted: boolean;
  reason?: string;
  messages: AgentMessage[];
  tokensBefore: number;
  tokensAfter: number;
  summary: string;
  /** Index of the first verbatim-kept source message (findCutPoint firstKept). */
  preservedStartIndex: number;
  summarizableCount: number;
  isSplitTurn: boolean;
};

function messageRole(message: AgentMessage): string | undefined {
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

/** Deterministic stand-in for LLM summary when assemble has no llm capability. */
export function buildExtractiveSummary(params: {
  messages: AgentMessage[];
  maxChars?: number;
  perMessageChars?: number;
}): string {
  const maxChars = params.maxChars ?? EXTRACTIVE_MAX_CHARS;
  const perMessageChars = params.perMessageChars ?? EXTRACTIVE_PER_MESSAGE_CHARS;
  if (params.messages.length === 0) {
    return "No prior history.";
  }
  const lines: string[] = [
    `Extractive compaction of ${params.messages.length} earlier message(s):`,
  ];
  let used = lines[0]!.length;
  for (const message of params.messages) {
    const role = messageRole(message) ?? "message";
    const text = extractMessageText(message).replace(/\s+/g, " ").trim();
    if (!text) {
      continue;
    }
    const clipped = text.length > perMessageChars ? `${text.slice(0, perMessageChars)}…` : text;
    const line = `- [${role}] ${clipped}`;
    if (used + line.length + 1 > maxChars) {
      lines.push("- …(truncated)…");
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/** Wrap summary text the same way convertToLlm wraps compactionSummary. */
export function buildCompactionSummaryUserMessage(params: {
  summary: string;
  tokensBefore: number;
  timestamp?: number;
}): AgentMessage {
  const summary = params.summary.trim() || "No prior history.";
  return {
    role: "user",
    content: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX,
    timestamp: params.timestamp ?? Date.now(),
    // Diagnostic only; providers ignore unknown fields.
    __tokenizerThresholdCompaction: {
      tokensBefore: params.tokensBefore,
    },
  } as AgentMessage;
}

/** Assemble native-shaped compacted prompt messages under a local token threshold. */
export function assembleNativeStyleCompactedMessages(params: {
  messages: AgentMessage[];
  thresholdTokens: number;
  counter: TokenCounter;
  /** Approximate recent-context tokens to keep verbatim (agent-core default: 20000). */
  keepRecentTokens: number;
  /** Prefer a previously generated LLM/extractive summary for the summarizable prefix. */
  summaryOverride?: string;
  countMessageTokens: (messages: readonly AgentMessage[]) => number;
}): NativeCompactAssembly {
  const tokensBefore = params.countMessageTokens(params.messages);
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

  const split = splitMessagesAtCutPoint({
    messages: params.messages,
    keepRecentTokens: params.keepRecentTokens,
    counter: params.counter,
  });

  if (split.summarizableMessages.length === 0) {
    // Nothing older to summarize — fall back to trailing window under threshold.
    const windowed = windowMessagesToTokenBudget({
      messages: params.messages,
      thresholdTokens: params.thresholdTokens,
      counter: params.counter,
    });
    return {
      compacted: windowed.messages.length < params.messages.length,
      reason: windowed.messages.length < params.messages.length ? undefined : "nothing to compact",
      messages: windowed.messages,
      tokensBefore,
      tokensAfter: windowed.estimatedTokens,
      summary: "",
      preservedStartIndex: params.messages.length - windowed.messages.length,
      summarizableCount: 0,
      isSplitTurn: split.isSplitTurn,
    };
  }

  // Keep extractive summaries proportional to the local threshold so the
  // summary user message itself cannot blow a small mid-loop budget.
  const extractiveMaxChars = Math.max(400, Math.floor(params.thresholdTokens * 2));
  const extractivePerMessageChars = Math.min(
    EXTRACTIVE_PER_MESSAGE_CHARS,
    Math.max(120, Math.floor(params.thresholdTokens / 2)),
  );
  const summary =
    params.summaryOverride?.trim() ||
    buildExtractiveSummary({
      messages: split.summarizableMessages,
      maxChars: extractiveMaxChars,
      perMessageChars: extractivePerMessageChars,
    });
  const summaryMessage = buildCompactionSummaryUserMessage({
    summary,
    tokensBefore,
  });

  let preserved = split.preservedMessages;
  let assembled = [summaryMessage, ...preserved];
  let tokensAfter = params.countMessageTokens(assembled);

  // If summary + keep-recent tail still overflow the engine threshold, shrink
  // the preserved tail with the trailing-window helper (last resort).
  if (tokensAfter >= params.thresholdTokens && preserved.length > 0) {
    const preservedBudget = Math.max(
      1,
      params.thresholdTokens - params.countMessageTokens([summaryMessage]),
    );
    const windowedPreserved = windowMessagesToTokenBudget({
      messages: preserved,
      thresholdTokens: preservedBudget,
      counter: params.counter,
    });
    preserved = windowedPreserved.messages;
    assembled = [summaryMessage, ...preserved];
    tokensAfter = params.countMessageTokens(assembled);
  }

  if (tokensAfter >= params.thresholdTokens) {
    const windowed = windowMessagesToTokenBudget({
      messages: params.messages,
      thresholdTokens: params.thresholdTokens,
      counter: params.counter,
    });
    return {
      compacted: windowed.messages.length < params.messages.length,
      reason:
        windowed.messages.length < params.messages.length
          ? "summary overflow; trailing window fallback"
          : "nothing to compact",
      messages: windowed.messages,
      tokensBefore,
      tokensAfter: windowed.estimatedTokens,
      summary,
      preservedStartIndex: params.messages.length - windowed.messages.length,
      summarizableCount: split.summarizableMessages.length,
      isSplitTurn: split.isSplitTurn,
    };
  }

  return {
    compacted: true,
    messages: assembled,
    tokensBefore,
    tokensAfter,
    summary,
    preservedStartIndex: split.firstKeptIndex,
    summarizableCount: split.summarizableMessages.length,
    isSplitTurn: split.isSplitTurn,
  };
}
