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

import { resolveTokenizerThresholdConfig } from "./config.js";
import { createTokenizerThresholdContextEngine } from "./engine.js";
import { COMPACTION_SUMMARY_PREFIX } from "./native-compact-assemble.js";
import { resetTokenizerThresholdSessionStatesForTest } from "./session-state.js";
import { rememberSystemPrompt, resetSystemPromptCacheForTest } from "./system-prompt-cache.js";
import { countMessageTokens, createTokenCounter } from "./tokenizer.js";

describe("createTokenizerThresholdContextEngine", () => {
  beforeEach(() => {
    resetTokenizerThresholdSessionStatesForTest();
    resetSystemPromptCacheForTest();
  });

  afterEach(() => {
    resetTokenizerThresholdSessionStatesForTest();
    resetSystemPromptCacheForTest();
  });

  it("assembles summary + keepRecentTokens tail when over threshold", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: {
        thresholdTokens: 200,
        tokenizerModel: "deepseek-v4-flash",
        pythonPath: "python3",
        keepRecentTokens: 80,
      },
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
    const first = assembled.messages[0] as { role?: string; content?: string };
    expect(first.role).toBe("user");
    expect(String(first.content)).toContain(COMPACTION_SUMMARY_PREFIX.trim());
    expect(String(first.content)).toContain("超过阈值 200 token，触发压缩");
  });

  it("reports tokenizer estimates for short assemble prompts", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: {
        thresholdTokens: 113_000,
        tokenizerModel: "deepseek-v4-flash",
        pythonPath: "python3",
        keepRecentTokens: 20_000,
      },
    });

    const assembled = await engine.assemble({
      sessionId: "s1",
      messages: [{ role: "user", content: "short" }],
    });

    expect(assembled.estimatedTokens).toBeGreaterThan(0);
    expect(assembled.messages).toHaveLength(1);
  });

  it("gates assemble on messages plus cached llm_input system prompt tokens", async () => {
    const counter = createTokenCounter(resolveTokenizerThresholdConfig({}));
    const messages = [
      { role: "user", content: "word ".repeat(120) },
      { role: "assistant", content: "word ".repeat(120) },
      { role: "user", content: "latest" },
    ] as const;
    const messageTokens = countMessageTokens({ messages, counter });
    const systemPrompt = "SYSTEM_POLICY ".repeat(400);
    rememberSystemPrompt({
      sessionId: "s-sys",
      sessionKey: "agent:main:main",
      systemPrompt,
    });

    const underMessageBudget = createTokenizerThresholdContextEngine({
      config: {
        thresholdTokens: messageTokens + 10_000,
        tokenizerModel: "deepseek-v4-flash",
        pythonPath: "python3",
        keepRecentTokens: 80,
      },
    });
    const intact = await underMessageBudget.assemble({
      sessionId: "s-sys",
      sessionKey: "agent:main:main",
      messages: [...messages],
    });
    expect(intact.messages).toEqual([...messages]);

    const engine = createTokenizerThresholdContextEngine({
      config: {
        thresholdTokens: messageTokens + 50,
        tokenizerModel: "deepseek-v4-flash",
        pythonPath: "python3",
        keepRecentTokens: 80,
      },
    });
    const assembled = await engine.assemble({
      sessionId: "s-sys",
      sessionKey: "agent:main:main",
      messages: [...messages],
    });
    expect(assembled.messages).not.toEqual([...messages]);
    expect(assembled.estimatedTokens).toBeLessThan(
      countMessageTokens({ messages, counter }) + counter.countText(systemPrompt) + 4,
    );
    expect(assembled.estimatedTokens).toBeGreaterThan(
      countMessageTokens({ messages: assembled.messages, counter }),
    );
    expect(assembled.messages.length).toBeLessThan(messages.length);
  });

  it("uses api.runtime.llm.complete from assemble when over threshold", async () => {
    const complete = vi.fn(async () => ({ text: "LLM distilled earlier context" }));
    const engine = createTokenizerThresholdContextEngine({
      config: {
        thresholdTokens: 200,
        tokenizerModel: "deepseek-v4-flash",
        pythonPath: "python3",
        keepRecentTokens: 80,
      },
      resolveLlmComplete: () => complete,
    });
    const messages = [
      { role: "user", content: "word ".repeat(2_000) },
      { role: "assistant", content: "word ".repeat(2_000) },
      { role: "user", content: "latest" },
    ];

    const assembled = await engine.assemble({
      sessionId: "s1",
      messages,
    });

    expect(complete).toHaveBeenCalled();
    expect(String((assembled.messages[0] as { content?: string }).content)).toContain(
      "LLM distilled earlier context",
    );

    const compactResult = await engine.compact({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      force: true,
    });
    expect(compactResult.result?.summary).toContain("LLM distilled earlier context");
    expect(compactResult.result?.summary).toContain("超过阈值 200 token，触发压缩");
    expect(compactResult.result?.details).toMatchObject({ summaryFromLlm: true });
  });

  it("leaves afterTurn as a no-op (compaction is assemble-only)", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: {
        thresholdTokens: 200,
        tokenizerModel: "deepseek-v4-flash",
        pythonPath: "python3",
        keepRecentTokens: 80,
      },
    });
    const messages = [
      { role: "user", content: "word ".repeat(2_000) },
      { role: "assistant", content: "word ".repeat(2_000) },
      { role: "user", content: "latest" },
    ];

    await engine.afterTurn?.({
      sessionId: "s1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      messages,
      prePromptMessageCount: 0,
      tokenBudget: 128_000,
      runtimeContext: {
        llm: {
          complete: async () => ({ text: "should not run from afterTurn" }),
        },
      },
    });

    const compactResult = await engine.compact({
      sessionId: "s1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      force: true,
    });
    expect(compactResult).toMatchObject({
      ok: true,
      compacted: false,
      reason: "no messages available for engine compaction",
    });
  });

  it("persists assemble compaction into compact() checkpoint fields", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: {
        thresholdTokens: 200,
        tokenizerModel: "deepseek-v4-flash",
        pythonPath: "python3",
        keepRecentTokens: 80,
      },
    });
    const messages = [
      { role: "user", content: "word ".repeat(2_000) },
      { role: "assistant", content: "word ".repeat(2_000) },
      { role: "user", content: "latest" },
    ] as const;

    await engine.assemble({
      sessionId: "s1",
      sessionKey: "agent:main:main",
      messages: [...messages],
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

  it("compacts from explicit runtimeContext messages without delegating", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: {
        thresholdTokens: 200,
        tokenizerModel: "deepseek-v4-flash",
        pythonPath: "python3",
        keepRecentTokens: 80,
      },
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
