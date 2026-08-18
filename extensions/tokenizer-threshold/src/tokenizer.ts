/**
 * Local tiktoken-backed message token counting for the context engine.
 * Encoding bytes are loaded from js-tiktoken (no network).
 */
import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { TokenizerThresholdEncoding } from "./config.js";

export type TokenCounter = {
  countText: (text: string) => number;
};

const encodingCache = new Map<TokenizerThresholdEncoding, Tiktoken>();

/** Lazily load and cache a local tiktoken encoding. */
export function getLocalTokenCounter(encoding: TokenizerThresholdEncoding): TokenCounter {
  let tiktoken = encodingCache.get(encoding);
  if (!tiktoken) {
    tiktoken = getEncoding(encoding);
    encodingCache.set(encoding, tiktoken);
  }
  const encoder = tiktoken;
  return {
    countText(text: string): number {
      if (!text) {
        return 0;
      }
      return encoder.encode(text).length;
    },
  };
}

/** Flatten assistant/user/tool message content into countable text. */
export function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as {
    role?: unknown;
    content?: unknown;
    errorMessage?: unknown;
    name?: unknown;
  };
  const parts: string[] = [];
  if (typeof record.role === "string" && record.role.trim()) {
    parts.push(record.role);
  }
  if (typeof record.name === "string" && record.name.trim()) {
    parts.push(record.name);
  }
  const content = record.content;
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const typed = block as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      if (typeof typed.text === "string") {
        parts.push(typed.text);
      }
      if (typeof typed.thinking === "string") {
        parts.push(typed.thinking);
      }
      if (typeof typed.name === "string") {
        parts.push(typed.name);
      }
      if (typed.arguments !== undefined) {
        try {
          parts.push(
            typeof typed.arguments === "string" ? typed.arguments : JSON.stringify(typed.arguments),
          );
        } catch {
          // Ignore non-serializable tool args for counting.
        }
      }
    }
  }
  if (typeof record.errorMessage === "string" && record.errorMessage.trim()) {
    parts.push(record.errorMessage);
  }
  return parts.join("\n");
}

/** Sum local tokenizer counts across a message list. */
export function countMessageTokens(params: {
  messages: readonly unknown[];
  counter: TokenCounter;
}): number {
  let total = 0;
  for (const message of params.messages) {
    // Per-message framing overhead is small vs content; keep the counter
    // content-faithful and deterministic for threshold decisions.
    total += params.counter.countText(extractMessageText(message));
    total += 4;
  }
  return total;
}

/** Count tokens for a cached system prompt string (0 when missing/blank). */
export function countSystemPromptTokens(params: {
  systemPrompt?: string;
  counter: TokenCounter;
}): number {
  const text = params.systemPrompt?.trim();
  if (!text) {
    return 0;
  }
  // Small framing overhead so system text is not treated cheaper than messages.
  return params.counter.countText(text) + 4;
}

/**
 * Local prompt pressure: session messages plus optional cached system prompt.
 * Tool JSON schemas are still outside this estimate (not available to the engine).
 */
export function countPromptTokens(params: {
  messages: readonly unknown[];
  systemPrompt?: string;
  counter: TokenCounter;
}): number {
  return (
    countMessageTokens({ messages: params.messages, counter: params.counter }) +
    countSystemPromptTokens({
      systemPrompt: params.systemPrompt,
      counter: params.counter,
    })
  );
}
