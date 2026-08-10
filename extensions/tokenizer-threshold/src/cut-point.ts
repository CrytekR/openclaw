/**
 * Message-list port of agent-core `findCutPoint` / prepareCompaction keep-tail.
 *
 * Native reference: packages/agent-core/src/harness/compaction/compaction.ts
 *   - findValidCutPoints / findCutPoint / findTurnStartIndex / prepareCompaction
 *
 * Differences from the session-tree original:
 * - Operates on AgentMessage[] (assemble prompt view), not SessionTreeEntry[]
 * - Token estimates use the plugin's local tiktoken counter (native uses ~chars/4)
 * - No session-tree meta entries (compaction/leaf/…); cut points are message roles only
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { countMessageTokens, type TokenCounter } from "./tokenizer.js";

export type MessageCutPoint = {
  /** First message index kept verbatim after compaction. */
  firstKeptIndex: number;
  /** Turn-start index when the cut splits a turn; otherwise -1. */
  turnStartIndex: number;
  /** True when firstKept is mid-turn (not on a user message). */
  isSplitTurn: boolean;
};

export type MessageHistorySplit = {
  /** Messages folded into the compaction summary (history + optional turn prefix). */
  summarizableMessages: AgentMessage[];
  /** Contiguous verbatim tail from firstKeptIndex to end. */
  preservedMessages: AgentMessage[];
  firstKeptIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
  /** End index (exclusive) of the main history summarization range. */
  historyEndIndex: number;
};

function messageRole(message: AgentMessage): string | undefined {
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

/**
 * Valid cut indexes: never cut on toolResult (keeps tool-call/result pairs
 * intact), matching agent-core findValidCutPoints for message roles.
 */
export function findValidMessageCutPoints(
  messages: readonly AgentMessage[],
  startIndex: number,
  endIndex: number,
): number[] {
  const cutPoints: number[] = [];
  const start = Math.max(0, startIndex);
  const end = Math.min(messages.length, endIndex);
  for (let i = start; i < end; i += 1) {
    const role = messageRole(messages[i]!);
    switch (role) {
      case "user":
      case "assistant":
      case "bashExecution":
      case "custom":
      case "branchSummary":
      case "compactionSummary":
        cutPoints.push(i);
        break;
      default:
        break;
    }
  }
  return cutPoints;
}

/** Walk back to the user (or bashExecution) that starts the turn containing entryIndex. */
export function findMessageTurnStartIndex(
  messages: readonly AgentMessage[],
  entryIndex: number,
  startIndex: number,
): number {
  for (let i = entryIndex; i >= startIndex; i -= 1) {
    const role = messageRole(messages[i]!);
    if (role === "user" || role === "bashExecution") {
      return i;
    }
  }
  return -1;
}

/**
 * Find the first-kept index that retains approximately `keepRecentTokens` from
 * the newest end of the message list (agent-core findCutPoint semantics).
 */
export function findMessageCutPoint(params: {
  messages: readonly AgentMessage[];
  startIndex?: number;
  endIndex?: number;
  keepRecentTokens: number;
  counter: TokenCounter;
}): MessageCutPoint {
  const startIndex = params.startIndex ?? 0;
  const endIndex = params.endIndex ?? params.messages.length;
  const keepRecentTokens = Math.max(1, Math.floor(params.keepRecentTokens));
  const cutPoints = findValidMessageCutPoints(params.messages, startIndex, endIndex);

  if (cutPoints.length === 0) {
    return { firstKeptIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0]!;

  for (let i = endIndex - 1; i >= startIndex; i -= 1) {
    accumulatedTokens += countMessageTokens({
      messages: [params.messages[i]!],
      counter: params.counter,
    });
    if (accumulatedTokens >= keepRecentTokens) {
      for (const cutPoint of cutPoints) {
        if (cutPoint >= i) {
          cutIndex = cutPoint;
          break;
        }
      }
      break;
    }
  }

  const cutMessage = params.messages[cutIndex]!;
  const isUserMessage = messageRole(cutMessage) === "user";
  const turnStartIndex = isUserMessage
    ? -1
    : findMessageTurnStartIndex(params.messages, cutIndex, startIndex);

  return {
    firstKeptIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1,
  };
}

/**
 * Split messages the way prepareCompaction does after findCutPoint:
 * - summarizable: [start, historyEnd) plus split-turn prefix [turnStart, firstKept)
 * - preserved: contiguous [firstKept, end)
 */
export function splitMessagesAtCutPoint(params: {
  messages: AgentMessage[];
  startIndex?: number;
  keepRecentTokens: number;
  counter: TokenCounter;
}): MessageHistorySplit {
  const startIndex = params.startIndex ?? 0;
  const cut = findMessageCutPoint({
    messages: params.messages,
    startIndex,
    keepRecentTokens: params.keepRecentTokens,
    counter: params.counter,
  });
  const historyEndIndex = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptIndex;
  const summarizableMessages: AgentMessage[] = [];
  for (let i = startIndex; i < historyEndIndex; i += 1) {
    summarizableMessages.push(params.messages[i]!);
  }
  if (cut.isSplitTurn) {
    for (let i = cut.turnStartIndex; i < cut.firstKeptIndex; i += 1) {
      summarizableMessages.push(params.messages[i]!);
    }
  }
  const preservedMessages = params.messages.slice(cut.firstKeptIndex);
  return {
    summarizableMessages,
    preservedMessages,
    firstKeptIndex: cut.firstKeptIndex,
    turnStartIndex: cut.turnStartIndex,
    isSplitTurn: cut.isSplitTurn,
    historyEndIndex,
  };
}
