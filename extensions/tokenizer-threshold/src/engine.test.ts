import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/core", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/core")>(
    "openclaw/plugin-sdk/core",
  );
  return {
    ...actual,
    delegateCompactionToRuntime: vi.fn(async () => {
      throw new Error("engine-owned compaction must not delegate to runtime");
    }),
  };
});

import { createTokenizerThresholdContextEngine } from "./engine.js";
import { resetTokenizerThresholdSessionStatesForTest } from "./session-state.js";

describe("createTokenizerThresholdContextEngine", () => {
  beforeEach(() => {
    resetTokenizerThresholdSessionStatesForTest();
  });

  afterEach(() => {
    resetTokenizerThresholdSessionStatesForTest();
  });

  it("windows assemble messages when over the tokenizer threshold", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: { thresholdTokens: 200, encoding: "cl100k_base" },
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

    expect(assembled.messages).not.toEqual([...messages]);
    expect(assembled.messages.at(-1)).toEqual(messages[2]);
    expect(assembled.estimatedTokens).toBeLessThan(200);
  });

  it("reports tokenizer estimates for short assemble prompts", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: { thresholdTokens: 113_000, encoding: "cl100k_base" },
    });

    const assembled = await engine.assemble({
      sessionId: "s1",
      messages: [{ role: "user", content: "short" }],
    });

    expect(assembled.estimatedTokens).toBeGreaterThan(0);
    expect(assembled.messages).toHaveLength(1);
  });

  it("compacts inside the engine from afterTurn when over the tokenizer threshold", async () => {
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
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      messages: [...messages],
      prePromptMessageCount: 0,
      tokenBudget: 128_000,
    });

    const compactResult = await engine.compact({
      sessionId: "s1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 128_000,
      force: true,
    });

    expect(compactResult).toMatchObject({
      ok: true,
      compacted: true,
      result: {
        tokensBefore: expect.any(Number),
        tokensAfter: expect.any(Number),
        details: {
          engine: "tokenizer-threshold",
          checkpointTrigger: {
            path: "context_engine",
            trigger: "threshold",
            thresholdTokens: 200,
            contextWindowTokens: 128_000,
          },
        },
      },
    });
    expect(compactResult.result?.tokensBefore).toBeGreaterThan(200);
    expect(compactResult.result?.tokensAfter).toBeLessThan(
      compactResult.result?.tokensBefore ?? Number.POSITIVE_INFINITY,
    );
  });

  it("does not compact from afterTurn when under the threshold", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: { thresholdTokens: 113_000, encoding: "cl100k_base" },
    });

    await engine.afterTurn?.({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      messages: [{ role: "user", content: "short" }],
      prePromptMessageCount: 0,
    });

    const compactResult = await engine.compact({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      force: true,
    });
    expect(compactResult).toMatchObject({
      ok: true,
      compacted: false,
      reason: "no messages available for engine compaction",
    });
  });

  it("gates afterTurn compaction on local tokenizer count, not host usage", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: { thresholdTokens: 200, encoding: "cl100k_base" },
    });

    await engine.afterTurn?.({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      messages: [{ role: "user", content: "short" }],
      prePromptMessageCount: 0,
      runtimeContext: { currentTokenCount: 250 },
    });
    expect(
      (
        await engine.compact({
          sessionId: "s1",
          sessionFile: "/tmp/session.jsonl",
          force: true,
        })
      ).compacted,
    ).toBe(false);

    await engine.afterTurn?.({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      messages: [
        { role: "user", content: "word ".repeat(2_000) },
        { role: "assistant", content: "word ".repeat(2_000) },
      ],
      prePromptMessageCount: 0,
      runtimeContext: { currentTokenCount: 50 },
    });

    const compactResult = await engine.compact({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      force: true,
    });
    expect(compactResult.compacted).toBe(true);
    expect(compactResult.result?.tokensBefore).toBeGreaterThan(200);
    expect(compactResult.result?.details).toMatchObject({
      checkpointTrigger: {
        path: "context_engine",
        trigger: "threshold",
        projectedTokens: compactResult.result?.tokensBefore,
        thresholdTokens: 200,
      },
    });
  });

  it("compacts from explicit runtimeContext messages without delegating", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: { thresholdTokens: 200, encoding: "cl100k_base" },
    });
    const messages = [
      { role: "user", content: "word ".repeat(2_000) },
      { role: "assistant", content: "word ".repeat(2_000) },
      { role: "user", content: "latest" },
    ];

    const compactResult = await engine.compact({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      force: true,
      runtimeContext: { messages },
    });

    expect(compactResult.ok).toBe(true);
    expect(compactResult.compacted).toBe(true);
    expect(compactResult.result?.tokensAfter).toBeLessThan(
      compactResult.result?.tokensBefore ?? Number.POSITIVE_INFINITY,
    );
  });
});
