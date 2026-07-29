import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { enrichChatHistoryCompactionMarkers } from "./chat-history-pages.js";

describe("enrichChatHistoryCompactionMarkers", () => {
  it("joins checkpoint token metrics to the matching transcript marker", () => {
    const marker = {
      role: "system",
      __openclaw: { kind: "compaction", id: "compact-entry-1", seq: 4 },
    };
    const entry = {
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint-1",
          sessionKey: "main",
          sessionId: "session-1",
          createdAt: 1_000,
          reason: "auto-threshold",
          tokensBefore: 900_000,
          tokensAfter: 24_700,
          reasonText:
            "token budget: projected 176k = 160k context meter + 12k previous reply + 4k this message ≥ 176k",
          preCompaction: { sessionId: "session-1" },
          postCompaction: { sessionId: "session-1", entryId: "compact-entry-1" },
        },
      ],
    } as SessionEntry;

    const result = enrichChatHistoryCompactionMarkers([marker], entry);

    expect(result[0]).toEqual({
      ...marker,
      __openclaw: {
        ...marker["__openclaw"],
        tokensBefore: 900_000,
        tokensAfter: 24_700,
        reasonText:
          "token budget: projected 176k = 160k context meter + 12k previous reply + 4k this message ≥ 176k",
      },
    });
    expect(marker["__openclaw"]).not.toHaveProperty("tokensBefore");
  });

  it("keeps transcript reasonText when the checkpoint omits one", () => {
    const marker = {
      role: "system",
      __openclaw: {
        kind: "compaction",
        id: "compact-entry-1",
        reasonText: "manual",
      },
    };
    const entry = {
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint-1",
          sessionKey: "main",
          sessionId: "session-1",
          createdAt: 1_000,
          reason: "manual",
          tokensBefore: 100,
          tokensAfter: 40,
          preCompaction: { sessionId: "session-1" },
          postCompaction: { sessionId: "session-1", entryId: "compact-entry-1" },
        },
      ],
    } as SessionEntry;

    const result = enrichChatHistoryCompactionMarkers([marker], entry);
    expect((result[0] as { __openclaw: { reasonText?: string } })["__openclaw"].reasonText).toBe(
      "manual",
    );
  });

  it("preserves message identity without a matching checkpoint", () => {
    const marker = {
      role: "system",
      __openclaw: { kind: "compaction", id: "compact-entry-1" },
    };

    const result = enrichChatHistoryCompactionMarkers([marker], undefined);

    expect(result[0]).toBe(marker);
  });
});
