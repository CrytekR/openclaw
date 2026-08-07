import { describe, expect, it } from "vitest";
import { computeTokenizerThresholdCompaction } from "./compact-logic.js";
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  assembleNativeStyleCompactedMessages,
  splitPreservedRecentTurns,
} from "./native-compact-assemble.js";
import { getLocalTokenCounter, countMessageTokens } from "./tokenizer.js";

describe("computeTokenizerThresholdCompaction", () => {
  const counter = getLocalTokenCounter("cl100k_base");

  it("returns below-threshold without compacting", () => {
    const result = computeTokenizerThresholdCompaction({
      messages: [{ role: "user", content: "short" }],
      thresholdTokens: 113_000,
      counter,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("below threshold");
  });

  it("compacts oversized transcripts to summary + preserved recent turns", () => {
    const result = computeTokenizerThresholdCompaction({
      messages: [
        { role: "user", content: "word ".repeat(2_000) },
        { role: "assistant", content: "word ".repeat(2_000) },
        { role: "user", content: "latest" },
      ],
      thresholdTokens: 200,
      counter,
      force: true,
      recentTurnsPreserve: 1,
    });
    expect(result.compacted).toBe(true);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(result.messages.at(-1)).toMatchObject({ role: "user", content: "latest" });
    expect(result.summary).toContain("Extractive compaction");
    const first = result.messages[0] as { role?: string; content?: string };
    expect(first.role).toBe("user");
    expect(String(first.content)).toContain(COMPACTION_SUMMARY_PREFIX.trim());
    expect(String(first.content)).toContain(COMPACTION_SUMMARY_SUFFIX.trim());
  });
});

describe("splitPreservedRecentTurns", () => {
  it("keeps the last N user turns and trailing tool pairs", () => {
    const messages = [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "old-a" },
      { role: "user", content: "keep-1" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "call-1", content: "ok" },
      { role: "user", content: "keep-2" },
      { role: "assistant", content: "final" },
    ] as const;

    const split = splitPreservedRecentTurns({
      messages: [...messages],
      recentTurnsPreserve: 2,
    });

    expect(split.summarizableMessages).toEqual([messages[0], messages[1]]);
    expect(split.preservedMessages.at(0)).toMatchObject({ content: "keep-1" });
    expect(split.preservedMessages.at(-1)).toMatchObject({ content: "final" });
  });
});

describe("assembleNativeStyleCompactedMessages", () => {
  const counter = getLocalTokenCounter("cl100k_base");

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
      recentTurnsPreserve: 1,
      summaryOverride: "LLM summary of earlier work",
      countMessageTokens: (msgs) => countMessageTokens({ messages: msgs, counter }),
    });
    expect(result.compacted).toBe(true);
    expect(result.summary).toBe("LLM summary of earlier work");
    expect(String((result.messages[0] as { content?: string }).content)).toContain(
      "LLM summary of earlier work",
    );
  });
});
