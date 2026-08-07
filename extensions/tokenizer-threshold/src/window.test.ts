import { describe, expect, it } from "vitest";
import { getLocalTokenCounter } from "./tokenizer.js";
import { windowMessagesToTokenBudget } from "./window.js";

describe("windowMessagesToTokenBudget", () => {
  const counter = getLocalTokenCounter("cl100k_base");

  it("returns the full list when under the threshold", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ] as const;

    const windowed = windowMessagesToTokenBudget({
      messages: [...messages],
      thresholdTokens: 113_000,
      counter,
    });

    expect(windowed.messages).toEqual([...messages]);
    expect(windowed.estimatedTokens).toBeGreaterThan(0);
  });

  it("keeps a trailing window under the threshold", () => {
    const old = { role: "user", content: "word ".repeat(2_000) } as const;
    const recent = { role: "user", content: "latest turn" } as const;

    const windowed = windowMessagesToTokenBudget({
      messages: [old, recent],
      thresholdTokens: 50,
      counter,
    });

    expect(windowed.messages).toEqual([recent]);
    expect(windowed.estimatedTokens).toBeLessThan(50);
  });

  it("drops leading toolResult orphans after a hard cut", () => {
    const old = { role: "user", content: "word ".repeat(2_000) } as const;
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "exec",
      content: [{ type: "text", text: "ok" }],
    } as const;
    const latest = { role: "user", content: "continue" } as const;

    const windowed = windowMessagesToTokenBudget({
      messages: [old, toolResult, latest],
      thresholdTokens: 40,
      counter,
    });

    expect(
      windowed.messages.some((message) => (message as { role?: string }).role === "toolResult"),
    ).toBe(false);
    expect(windowed.messages.at(-1)).toEqual(latest);
  });
});
