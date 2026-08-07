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

  it("passes assemble messages through without compacting or windowing", async () => {
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

    expect(assembled.messages).toEqual([...messages]);
    expect(assembled.estimatedTokens).toBeGreaterThan(200);
    expect(delegateCompactionToRuntime).not.toHaveBeenCalled();
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
    expect(delegateCompactionToRuntime).not.toHaveBeenCalled();
  });

  it("compacts from afterTurn when over the tokenizer threshold", async () => {
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
      runtimeContext: { workspaceDir: "/tmp/workspace" },
    });

    expect(delegateCompactionToRuntime).toHaveBeenCalledTimes(1);
    const compactArgs = delegateCompactionToRuntime.mock.calls[0]?.[0];
    expect(compactArgs).toMatchObject({
      sessionId: "s1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      force: true,
      tokenBudget: 128_000,
    });
    expect(compactArgs.currentTokenCount).toBeGreaterThan(200);
    expect(compactArgs.runtimeContext).toMatchObject({
      workspaceDir: "/tmp/workspace",
      checkpointTrigger: {
        path: "context_engine",
        trigger: "threshold",
        thresholdTokens: 200,
        contextWindowTokens: 128_000,
      },
    });
    expect(compactArgs.runtimeContext.checkpointTrigger.projectedTokens).toBe(
      compactArgs.currentTokenCount,
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

    expect(delegateCompactionToRuntime).not.toHaveBeenCalled();
  });

  it("gates afterTurn compaction on local tokenizer count, not host usage", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: { thresholdTokens: 200, encoding: "cl100k_base" },
    });

    // Host usage is already over threshold, but the local message view is small.
    await engine.afterTurn?.({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      messages: [{ role: "user", content: "short" }],
      prePromptMessageCount: 0,
      runtimeContext: { currentTokenCount: 250 },
    });
    expect(delegateCompactionToRuntime).not.toHaveBeenCalled();

    // Local messages are over threshold even if host usage is still under.
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
    expect(delegateCompactionToRuntime).toHaveBeenCalledTimes(1);
    const compactArgs = delegateCompactionToRuntime.mock.calls[0]?.[0];
    expect(compactArgs.currentTokenCount).toBeGreaterThan(200);
    expect(compactArgs.runtimeContext).toMatchObject({
      currentTokenCount: 50,
      checkpointTrigger: {
        path: "context_engine",
        trigger: "threshold",
        thresholdTokens: 200,
      },
    });
    expect(compactArgs.runtimeContext.checkpointTrigger.projectedTokens).toBe(
      compactArgs.currentTokenCount,
    );
  });
});
