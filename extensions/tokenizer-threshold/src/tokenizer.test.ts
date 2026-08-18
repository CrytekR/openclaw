import { describe, expect, it } from "vitest";
import { resolveTokenizerThresholdConfig } from "./config.js";
import { countMessageTokens, createTokenCounter, extractMessageText } from "./tokenizer.js";

const testConfig = resolveTokenizerThresholdConfig({});

describe("tokenizer helpers", () => {
  it("counts text with the Vitest stub counter", () => {
    const counter = createTokenCounter(testConfig);
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
    const counter = createTokenCounter(testConfig);
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
