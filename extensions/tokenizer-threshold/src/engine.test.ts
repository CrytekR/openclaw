import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireSessionWriteLock } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  let tempDir: string | undefined;
  let heldLock: { release: () => Promise<void> } | undefined;

  beforeEach(() => {
    delegateCompactionToRuntime.mockReset();
    delegateCompactionToRuntime.mockResolvedValue({
      ok: true,
      compacted: true,
      result: { tokensBefore: 120_000, tokensAfter: 40_000 },
    });
  });

  afterEach(async () => {
    if (heldLock) {
      await heldLock.release();
      heldLock = undefined;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      tempDir = undefined;
    }
  });

  async function createTempSessionFile(): Promise<string> {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tokenizer-threshold-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    return sessionFile;
  }

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

  it("compacts from afterTurn when over the tokenizer threshold and lock is free", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: { thresholdTokens: 200, encoding: "cl100k_base" },
    });
    const sessionFile = await createTempSessionFile();
    const messages = [
      { role: "user", content: "word ".repeat(2_000) },
      { role: "assistant", content: "word ".repeat(2_000) },
      { role: "user", content: "latest" },
    ] as const;

    await engine.afterTurn?.({
      sessionId: "s1",
      sessionKey: "agent:main:main",
      sessionFile,
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
      sessionFile,
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

  it("skips durable afterTurn compaction while the session write lock is held", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: { thresholdTokens: 200, encoding: "cl100k_base" },
    });
    const sessionFile = await createTempSessionFile();
    heldLock = await acquireSessionWriteLock({
      sessionFile,
      timeoutMs: 1_000,
      allowReentrant: false,
    });

    await engine.afterTurn?.({
      sessionId: "s1",
      sessionFile,
      messages: [
        { role: "user", content: "word ".repeat(2_000) },
        { role: "assistant", content: "word ".repeat(2_000) },
      ],
      prePromptMessageCount: 0,
    });

    expect(delegateCompactionToRuntime).not.toHaveBeenCalled();
  });

  it("does not compact from afterTurn when under the threshold", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: { thresholdTokens: 113_000, encoding: "cl100k_base" },
    });
    const sessionFile = await createTempSessionFile();

    await engine.afterTurn?.({
      sessionId: "s1",
      sessionFile,
      messages: [{ role: "user", content: "short" }],
      prePromptMessageCount: 0,
    });

    expect(delegateCompactionToRuntime).not.toHaveBeenCalled();
  });

  it("gates afterTurn compaction on local tokenizer count, not host usage", async () => {
    const engine = createTokenizerThresholdContextEngine({
      config: { thresholdTokens: 200, encoding: "cl100k_base" },
    });
    const sessionFile = await createTempSessionFile();

    // Host usage is already over threshold, but the local message view is small.
    await engine.afterTurn?.({
      sessionId: "s1",
      sessionFile,
      messages: [{ role: "user", content: "short" }],
      prePromptMessageCount: 0,
      runtimeContext: { currentTokenCount: 250 },
    });
    expect(delegateCompactionToRuntime).not.toHaveBeenCalled();

    // Local messages are over threshold even if host usage is still under.
    await engine.afterTurn?.({
      sessionId: "s1",
      sessionFile,
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
