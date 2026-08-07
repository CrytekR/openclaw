/**
 * Native-style compaction message assembly for the context engine.
 *
 * Mirrors agent-core / safeguard shape:
 *   [user message wrapping <summary>...</summary>] + preserved recent turns
 *
 * Summary text may be extractive (assemble / lock-free path) or LLM-produced
 * (afterTurn when runtimeContext.llm is available).
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { extractMessageText, type TokenCounter } from "./tokenizer.js";
import { windowMessagesToTokenBudget } from "./window.js";

/** Same model-facing wrapper as packages/agent-core harness messages. */
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

const DEFAULT_RECENT_TURNS_PRESERVE = 3;
const MAX_RECENT_TURNS_PRESERVE = 12;
const EXTRACTIVE_MAX_CHARS = 12_000;
const EXTRACTIVE_PER_MESSAGE_CHARS = 800;

export type NativeCompactAssembly = {
  compacted: boolean;
  reason?: string;
  messages: AgentMessage[];
  tokensBefore: number;
  tokensAfter: number;
  summary: string;
  /** Index where preserved recent turns start in the source messages. */
  preservedStartIndex: number;
  summarizableCount: number;
};

function clampRecentTurnsPreserve(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_RECENT_TURNS_PRESERVE;
  }
  return Math.min(MAX_RECENT_TURNS_PRESERVE, Math.floor(value));
}

function messageRole(message: AgentMessage): string | undefined {
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function extractAssistantToolCallIds(message: AgentMessage): string[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  const ids: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typed = block as { type?: unknown; id?: unknown };
    if (
      (typed.type === "toolCall" || typed.type === "toolUse" || typed.type === "functionCall") &&
      typeof typed.id === "string" &&
      typed.id.trim()
    ) {
      ids.push(typed.id);
    }
  }
  return ids;
}

function extractToolResultId(message: AgentMessage): string | undefined {
  const record = message as { toolCallId?: unknown; tool_use_id?: unknown };
  if (typeof record.toolCallId === "string" && record.toolCallId.trim()) {
    return record.toolCallId;
  }
  if (typeof record.tool_use_id === "string" && record.tool_use_id.trim()) {
    return record.tool_use_id;
  }
  return undefined;
}

/**
 * Port of safeguard splitPreservedRecentTurns: keep the last N user/assistant
 * turns (and their tool results) verbatim; older history is summarizable.
 */
export function splitPreservedRecentTurns(params: {
  messages: AgentMessage[];
  recentTurnsPreserve?: number;
}): {
  summarizableMessages: AgentMessage[];
  preservedMessages: AgentMessage[];
  preservedStartIndex: number;
} {
  const preserveTurns = clampRecentTurnsPreserve(params.recentTurnsPreserve);
  if (preserveTurns <= 0 || params.messages.length === 0) {
    return {
      summarizableMessages: params.messages,
      preservedMessages: [],
      preservedStartIndex: params.messages.length,
    };
  }

  const conversationIndexes: number[] = [];
  const userIndexes: number[] = [];
  for (let i = 0; i < params.messages.length; i += 1) {
    const role = messageRole(params.messages[i]!);
    if (role === "user" || role === "assistant") {
      conversationIndexes.push(i);
      if (role === "user") {
        userIndexes.push(i);
      }
    }
  }
  if (conversationIndexes.length === 0) {
    return {
      summarizableMessages: [],
      preservedMessages: params.messages,
      preservedStartIndex: 0,
    };
  }

  const preservedIndexSet = new Set<number>();
  if (userIndexes.length >= preserveTurns) {
    const boundaryStartIndex = userIndexes[userIndexes.length - preserveTurns] ?? -1;
    if (boundaryStartIndex >= 0) {
      for (const index of conversationIndexes) {
        if (index >= boundaryStartIndex) {
          preservedIndexSet.add(index);
        }
      }
    }
  } else {
    const fallbackMessageCount = preserveTurns * 2;
    for (const userIndex of userIndexes) {
      preservedIndexSet.add(userIndex);
    }
    for (let i = conversationIndexes.length - 1; i >= 0; i -= 1) {
      const index = conversationIndexes[i];
      if (index === undefined) {
        continue;
      }
      preservedIndexSet.add(index);
      if (preservedIndexSet.size >= fallbackMessageCount) {
        break;
      }
    }
  }

  if (preservedIndexSet.size === 0) {
    return {
      summarizableMessages: params.messages,
      preservedMessages: [],
      preservedStartIndex: params.messages.length,
    };
  }

  const preservedToolCallIds = new Set<string>();
  for (let i = 0; i < params.messages.length; i += 1) {
    if (!preservedIndexSet.has(i)) {
      continue;
    }
    const message = params.messages[i]!;
    if (messageRole(message) !== "assistant") {
      continue;
    }
    for (const id of extractAssistantToolCallIds(message)) {
      preservedToolCallIds.add(id);
    }
  }
  if (preservedToolCallIds.size > 0) {
    for (let i = 0; i < params.messages.length; i += 1) {
      const role = messageRole(params.messages[i]!);
      if (role !== "toolResult" && role !== "tool") {
        continue;
      }
      const toolCallId = extractToolResultId(params.messages[i]!);
      if (toolCallId && preservedToolCallIds.has(toolCallId)) {
        preservedIndexSet.add(i);
      }
    }
  }

  let preservedStartIndex = params.messages.length;
  for (const index of preservedIndexSet) {
    preservedStartIndex = Math.min(preservedStartIndex, index);
  }
  // Include any interstitial messages between the first preserved conversation
  // turn and the end so tool pairs stay contiguous.
  for (let i = preservedStartIndex; i < params.messages.length; i += 1) {
    preservedIndexSet.add(i);
  }

  const summarizableMessages = params.messages.slice(0, preservedStartIndex);
  const preservedMessages = params.messages.slice(preservedStartIndex);
  return { summarizableMessages, preservedMessages, preservedStartIndex };
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
  recentTurnsPreserve?: number;
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
    };
  }

  const split = splitPreservedRecentTurns({
    messages: params.messages,
    recentTurnsPreserve: params.recentTurnsPreserve,
  });

  if (split.summarizableMessages.length === 0) {
    // Nothing older to summarize — fall back to trailing window.
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

  // If the summary + preserved recent turns still overflow, shrink the
  // preserved tail with the same trailing-window helper native paths use as a
  // last resort for oversized suffixes.
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

  // Summary alone can still exceed a tiny threshold (or an oversized LLM
  // override). Fall back to a pure trailing window so assemble always returns
  // a prompt that fits under budget when possible.
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
    };
  }

  return {
    compacted: true,
    messages: assembled,
    tokensBefore,
    tokensAfter,
    summary,
    preservedStartIndex: split.preservedStartIndex,
    summarizableCount: split.summarizableMessages.length,
  };
}
