# Tokenizer Threshold Context Engine

Bundled OpenClaw context engine for the `v2026.6.6` line that **owns** threshold compaction:

1. Counts prompt tokens with a local `js-tiktoken` encoding (default `cl100k_base`)
2. Implements compaction inside the engine using the **native** shape — a summary wrapped as a user message (`<summary>...</summary>`) plus preserved recent turns — and does **not** call `delegateCompactionToRuntime`
3. Returns that compacted message list from `assemble` so mid-loop tool turns stay under the threshold without taking the session write lock
4. Optionally upgrades the extractive summary via `runtimeContext.llm` in `afterTurn` / `compact` when the host provides it
5. Exposes `CompactResult.tokensBefore` / `tokensAfter` so host checkpoint records can persist engine counts when the host calls `compact()`

## What the engine controls

| Surface                      | Engine effect                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt token estimate        | `assemble().estimatedTokens` (local tiktoken)                                                                                            |
| Mid-loop prompt size         | `assemble()` returns `[summary user message] + preserved recent turns` under `thresholdTokens`                                           |
| Compaction algorithm         | Engine-owned native-style assemble in `assemble` / `afterTurn` / `compact`                                                               |
| Host checkpoint token fields | `CompactResult.result.tokensBefore` / `tokensAfter` / `summary` when host invokes `compact()`                                            |
| Checkpoint reason label      | Host still chooses the persisted trigger path; engine attaches `details.checkpointTrigger` with `path: "context_engine"` for diagnostics |

`afterTurn` refreshes the engine-owned view (and may upgrade to an LLM summary). It does **not** write `sessions.json` compaction checkpoints by itself; those records are written by the host when it calls `compact()` (overflow, `/compact`, budget).

## Enable

```json5
{
  plugins: {
    slots: {
      contextEngine: "tokenizer-threshold",
    },
    entries: {
      "tokenizer-threshold": {
        enabled: true,
        config: {
          thresholdTokens: 113000,
          encoding: "cl100k_base", // or o200k_base | p50k_base | r50k_base
          recentTurnsPreserve: 3,
        },
      },
    },
  },
}
```

Restart the gateway after changing the slot.

## Notes

- `ownsCompaction: true` disables OpenClaw runtime in-attempt auto-compaction for the run.
- `assemble` has no LLM capability, so the first compacted view uses an extractive summary; `afterTurn` upgrades when `runtimeContext.llm` is present.
- Keep the threshold below the active model window with headroom.
