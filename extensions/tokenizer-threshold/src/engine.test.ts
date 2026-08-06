import { beforeEach, describe, expect, it, vi } from "vitest";

const { delegateCompactionToRuntime } = vi.hoisted(() => ({
  delegateCompactionToRuntime: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/core", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/core")>(
    "openclaw/plugin-sdk/core",
  );
  return {
    ...actual,
    delegateCompactionToRuntime,
  };
});

import { createTokenizerThresholdContextEngine } from "./engine.js";

describe("createTokenizerThresholdContextEngine", () => {
  beforeEach(() => {
    delegateCompactionToRuntime.mockReset();
    delegateCompactionToRuntime.mockResolvedValue({
      ok: true,
      compacted: true,
      result: { tokensBefore: 120_000, tokensAfter: 40_000 },
    });
  });

  it("returns tokenizer estimates and windows over-threshold prompts", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: { thresholdTokens: 200, encoding: "cl100k_base" },
    });
    await engine.bootstrap?.({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
    });

    const big = "word ".repeat(2_000);
    const messages = [
      { role: "user", content: big },
      { role: "assistant", content: big },
      { role: "user", content: "latest turn" },
    ] as const;

    const assembled = await engine.assemble({
      sessionId: "s1",
      messages: [...messages],
    });

    expect(assembled.estimatedTokens).toBeLessThanOrEqual(200);
    expect(assembled.messages.at(-1)).toMatchObject({ content: "latest turn" });
    expect(delegateCompactionToRuntime).toHaveBeenCalled();
    expect(delegateCompactionToRuntime.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      force: true,
    });
  });

  it("does not compact when under the threshold", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: { thresholdTokens: 113_000, encoding: "cl100k_base" },
    });
    await engine.bootstrap?.({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
    });

    const assembled = await engine.assemble({
      sessionId: "s1",
      messages: [{ role: "user", content: "short" }],
    });

    expect(assembled.estimatedTokens).toBeGreaterThan(0);
    expect(assembled.messages).toHaveLength(1);
    expect(delegateCompactionToRuntime).not.toHaveBeenCalled();
  });

  it("uses afterTurn only to refresh session bindings", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: { thresholdTokens: 200, encoding: "cl100k_base" },
    });
    const messages = [
      { role: "user", content: "word ".repeat(2_000) },
      { role: "assistant", content: "word ".repeat(2_000) },
      { role: "user", content: "latest" },
    ] as const;
    await engine.afterTurn?.({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      messages: [...messages],
      prePromptMessageCount: 0,
    });
    expect(delegateCompactionToRuntime).not.toHaveBeenCalled();

    const assembled = await engine.assemble({
      sessionId: "s1",
      messages: [...messages],
    });
    expect(assembled.estimatedTokens).toBeLessThanOrEqual(200);
    expect(delegateCompactionToRuntime).toHaveBeenCalledTimes(1);
  });
});
