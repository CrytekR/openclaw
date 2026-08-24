import { describe, expect, it } from "vitest";
import { resolveTokenizerThresholdConfig } from "./config.js";
import {
  findMessageCutPoint,
  findValidMessageCutPoints,
  splitMessagesAtCutPoint,
} from "./cut-point.js";
import { createTokenCounter } from "./tokenizer.js";

describe("cut-point helpers", () => {
  const counter = createTokenCounter(resolveTokenizerThresholdConfig({}));

  it("lists valid cut points excluding toolResult", () => {
    const messages = [
      { role: "user", content: "u" },
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "t", arguments: {} }] },
      { role: "toolResult", toolCallId: "c1", content: "r" },
      { role: "assistant", content: "a" },
    ];
    expect(findValidMessageCutPoints(messages as never, 0, messages.length)).toEqual([0, 1, 3]);
  });

  it("returns the whole list as preserved when under keepRecentTokens", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const split = splitMessagesAtCutPoint({
      messages: messages as never,
      keepRecentTokens: 20_000,
      counter,
    });
    expect(split.firstKeptIndex).toBe(0);
    expect(split.summarizableMessages).toEqual([]);
    expect(split.preservedMessages).toEqual(messages);
  });

  it("snaps budget overflow to a non-toolResult cut point", () => {
    const messages = [
      { role: "user", content: "old " + "x".repeat(2_000) },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "c1", content: "y".repeat(2_000) },
      { role: "assistant", content: "fresh" },
    ];
    const cut = findMessageCutPoint({
      messages: messages as never,
      keepRecentTokens: 20,
      counter,
    });
    expect(cut.firstKeptIndex).toBeGreaterThan(0);
    expect((messages[cut.firstKeptIndex] as { role: string }).role).not.toBe("toolResult");
  });
});
