import { describe, expect, it } from "vitest";
import { countMessageTokens, extractMessageText, getLocalTokenCounter } from "./tokenizer.js";

describe("tokenizer helpers", () => {
  it("loads a local tiktoken encoding and counts text", () => {
    const counter = getLocalTokenCounter("cl100k_base");
    expect(counter.countText("hello world")).toBeGreaterThan(0);
    expect(counter.countText("")).toBe(0);
  });

  it("extracts text from structured message content", () => {
    expect(
      extractMessageText({
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
        ],
      }),
    ).toContain("hello");
    expect(
      extractMessageText({
        role: "user",
        content: "plain",
      }),
    ).toContain("plain");
  });

  it("counts message lists with framing overhead", () => {
    const counter = getLocalTokenCounter("cl100k_base");
    const one = countMessageTokens({
      messages: [{ role: "user", content: "hello" }],
      counter,
    });
    const two = countMessageTokens({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
      counter,
    });
    expect(two).toBeGreaterThan(one);
  });
});
