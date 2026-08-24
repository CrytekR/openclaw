/**
 * Prompt-only trailing window for mid-loop threshold pressure.
 *
 * Durable compaction needs the session write lock, which the live attempt already
 * holds. The ownsCompaction loop hook still calls assemble after afterTurn, so
 * returning a trimmed prompt view is what actually shrinks the next model call
 * during a long tool loop.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { countMessageTokens, extractMessageText, type TokenCounter } from "./tokenizer.js";

function isLeadingToolResult(message: AgentMessage): boolean {
  const role = (message as { role?: unknown }).role;
  return role === "toolResult" || role === "tool";
}

/** Keep a trailing message window whose local tokenizer count fits under budget. */
export function windowMessagesToTokenBudget(params: {
  messages: AgentMessage[];
  thresholdTokens: number;
  counter: TokenCounter;
}): { messages: AgentMessage[]; estimatedTokens: number } {
  const estimatedTokens = countMessageTokens({
    messages: params.messages,
    counter: params.counter,
  });
  if (
    params.messages.length === 0 ||
    estimatedTokens < params.thresholdTokens ||
    params.thresholdTokens <= 0
  ) {
    return { messages: params.messages, estimatedTokens };
  }

  const perMessageTokens = params.messages.map(
    (message) => params.counter.countText(extractMessageText(message)) + 4,
  );

  let total = 0;
  let start = params.messages.length;
  for (let index = params.messages.length - 1; index >= 0; index -= 1) {
    const nextTotal = total + (perMessageTokens[index] ?? 0);
    // Always keep at least the newest message, even if it alone exceeds budget.
    if (nextTotal > params.thresholdTokens && total > 0) {
      break;
    }
    total = nextTotal;
    start = index;
  }

  let windowed = params.messages.slice(start);
  // Drop orphan tool results at the window head so the next prompt does not
  // start mid tool-pair after a hard cut.
  while (windowed.length > 1 && isLeadingToolResult(windowed[0]!)) {
    total = Math.max(0, total - (perMessageTokens[start] ?? 0));
    start += 1;
    windowed = params.messages.slice(start);
  }

  return { messages: windowed, estimatedTokens: total };
}
