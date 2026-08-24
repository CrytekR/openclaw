import { describe, expect, it } from "vitest";
import { computeTokenizerThresholdCompaction } from "./compact-logic.js";
import { resolveTokenizerThresholdConfig } from "./config.js";
import { findMessageCutPoint, splitMessagesAtCutPoint } from "./cut-point.js";
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  assembleNativeStyleCompactedMessages,
} from "./native-compact-assemble.js";
import { createTokenCounter, countMessageTokens } from "./tokenizer.js";

describe("findMessageCutPoint", () => {
  const counter = createTokenCounter(resolveTokenizerThresholdConfig({}));

  it("keeps a contiguous recent token budget and never cuts on toolResult", () => {
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: "task start" }];
    for (let i = 0; i < 30; i += 1) {
      messages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${i}`, name: "bash", arguments: { i } }],
      });
      messages.push({
        role: "toolResult",
        toolCallId: `call-${i}`,
        content: `output-${i} ${"word ".repeat(40)}`,
      });
    }
    messages.push({ role: "assistant", content: "done" });

    const cut = findMessageCutPoint({
      messages: messages as never,
      keepRecentTokens: 400,
      counter,
    });

    expect(cut.firstKeptIndex).toBeGreaterThan(0);
    expect((messages[cut.firstKeptIndex] as { role?: string }).role).not.toBe("toolResult");

    const split = splitMessagesAtCutPoint({
      messages: messages as never,
      keepRecentTokens: 400,
      counter,
    });
    expect(split.preservedMessages[0]).toBe(messages[cut.firstKeptIndex]);
    expect(split.preservedMessages.at(-1)).toMatchObject({ content: "done" });
    // Contiguous tail: preserved length equals end - firstKept
    expect(split.preservedMessages).toHaveLength(messages.length - cut.firstKeptIndex);
    expect(split.summarizableMessages.length).toBeGreaterThan(0);
    // Early tool output is summarizable, not in the keep-recent tail.
    expect(
      split.summarizableMessages.some((m) =>
        String((m as { content?: string }).content ?? "").includes("output-0"),
      ),
    ).toBe(true);
  });

  it("marks split turns when the cut lands mid-turn on an assistant", () => {
    const messages = [
      { role: "user", content: "please do work" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "c1", content: "a".repeat(4_000) },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c2", name: "read", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "c2", content: "b".repeat(4_000) },
      { role: "assistant", content: "tail" },
    ];
    const cut = findMessageCutPoint({
      messages: messages as never,
      keepRecentTokens: 50,
      counter,
    });
    // Small budget snaps near the end; if cut is not a user, turn start is the user.
    if ((messages[cut.firstKeptIndex] as { role: string }).role !== "user") {
      expect(cut.isSplitTurn).toBe(true);
      expect(cut.turnStartIndex).toBe(0);
      const split = splitMessagesAtCutPoint({
        messages: messages as never,
        keepRecentTokens: 50,
        counter,
      });
      // Turn prefix before firstKept is folded into summarizable.
      expect(split.summarizableMessages.length).toBeGreaterThan(0);
    }
  });
});

describe("computeTokenizerThresholdCompaction", () => {
  const counter = createTokenCounter(resolveTokenizerThresholdConfig({}));

  it("returns below-threshold without compacting", () => {
    const result = computeTokenizerThresholdCompaction({
      messages: [{ role: "user", content: "short" }],
      thresholdTokens: 113_000,
      counter,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("below threshold");
  });

  it("compacts oversized transcripts to summary + keep-recent tail", () => {
    const result = computeTokenizerThresholdCompaction({
      messages: [
        { role: "user", content: "word ".repeat(2_000) },
        { role: "assistant", content: "word ".repeat(2_000) },
        { role: "user", content: "latest" },
      ],
      thresholdTokens: 200,
      counter,
      keepRecentTokens: 80,
    });
    expect(result.compacted).toBe(true);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(result.messages.at(-1)).toMatchObject({ role: "user", content: "latest" });
    expect(result.summary).toContain("Extractive compaction");
    expect(result.summary).toContain("超过阈值 200 token，第 1 次触发压缩");
    const first = result.messages[0] as { role?: string; content?: string };
    expect(first.role).toBe("user");
    expect(String(first.content)).toContain(COMPACTION_SUMMARY_PREFIX.trim());
    expect(String(first.content)).toContain(COMPACTION_SUMMARY_SUFFIX.trim());
    expect(String(first.content)).toContain("超过阈值 200 token，第 1 次触发压缩");
  });

  it("counts cached system prompt toward the threshold gate", () => {
    const messages = [
      { role: "user", content: "word ".repeat(80) },
      { role: "assistant", content: "word ".repeat(80) },
      { role: "user", content: "latest" },
    ];
    const messageTokens = countMessageTokens({ messages, counter });
    const withoutSystem = computeTokenizerThresholdCompaction({
      messages,
      thresholdTokens: messageTokens + 100,
      counter,
      keepRecentTokens: 60,
    });
    expect(withoutSystem.compacted).toBe(false);

    const withSystem = computeTokenizerThresholdCompaction({
      messages,
      thresholdTokens: messageTokens + 100,
      counter,
      keepRecentTokens: 60,
      systemPrompt: "BOOTSTRAP ".repeat(500),
    });
    expect(withSystem.compacted).toBe(true);
    expect(withSystem.tokensBefore).toBeGreaterThan(messageTokens);
    expect(withSystem.tokensAfter).toBeGreaterThan(
      countMessageTokens({ messages: withSystem.messages, counter }),
    );
  });

  it("counts cached tool schemas toward the threshold gate", () => {
    const messages = [
      { role: "user", content: "word ".repeat(80) },
      { role: "assistant", content: "word ".repeat(80) },
      { role: "user", content: "latest" },
    ];
    const messageTokens = countMessageTokens({ messages, counter });
    const withoutTools = computeTokenizerThresholdCompaction({
      messages,
      thresholdTokens: messageTokens + 100,
      counter,
      keepRecentTokens: 60,
    });
    expect(withoutTools.compacted).toBe(false);

    const withTools = computeTokenizerThresholdCompaction({
      messages,
      thresholdTokens: messageTokens + 100,
      counter,
      keepRecentTokens: 60,
      toolsSchemaTokens: 5_000,
    });
    expect(withTools.compacted).toBe(true);
    expect(withTools.tokensBefore).toBe(messageTokens + 5_000);
    expect(withTools.summary).toContain("超过阈值");
  });
});

describe("assembleNativeStyleCompactedMessages", () => {
  const counter = createTokenCounter(resolveTokenizerThresholdConfig({}));

  it("reuses summaryOverride instead of rebuilding extractive text", () => {
    const messages = [
      { role: "user", content: "word ".repeat(2_000) },
      { role: "assistant", content: "word ".repeat(2_000) },
      { role: "user", content: "latest" },
    ];
    const result = assembleNativeStyleCompactedMessages({
      messages,
      thresholdTokens: 200,
      counter,
      keepRecentTokens: 80,
      summaryOverride: "LLM summary of earlier work",
      countMessageTokens: (msgs) => countMessageTokens({ messages: msgs, counter }),
    });
    expect(result.compacted).toBe(true);
    expect(result.summary).toContain("LLM summary of earlier work");
    expect(result.summary).toContain("超过阈值 200 token，第 1 次触发压缩");
    expect(String((result.messages[0] as { content?: string }).content)).toContain(
      "LLM summary of earlier work",
    );
    expect(String((result.messages[0] as { content?: string }).content)).toContain(
      "超过阈值 200 token，第 1 次触发压缩",
    );
  });

  it("surfaces tokenizer degradation in the Chinese gate reason", () => {
    const messages = [
      { role: "user", content: "word ".repeat(2_000) },
      { role: "assistant", content: "word ".repeat(2_000) },
      { role: "user", content: "latest" },
    ];
    const result = assembleNativeStyleCompactedMessages({
      messages,
      thresholdTokens: 200,
      counter,
      keepRecentTokens: 80,
      tokenizerDegraded: true,
      countMessageTokens: (msgs) => countMessageTokens({ messages: msgs, counter }),
    });
    expect(result.compacted).toBe(true);
    expect(result.summary).toContain("本地 tokenizer 不可用，当前为估算值");
    expect(result.summary).toContain("第 1 次触发压缩");
  });

  it("honors an explicit compactionTriggerCount in the gate reason", () => {
    const messages = [
      { role: "user", content: "word ".repeat(2_000) },
      { role: "assistant", content: "word ".repeat(2_000) },
      { role: "user", content: "latest" },
    ];
    const result = assembleNativeStyleCompactedMessages({
      messages,
      thresholdTokens: 200,
      counter,
      keepRecentTokens: 80,
      compactionTriggerCount: 3,
      countMessageTokens: (msgs) => countMessageTokens({ messages: msgs, counter }),
    });
    expect(result.compacted).toBe(true);
    expect(result.summary).toContain("第 3 次触发压缩");
  });
});
