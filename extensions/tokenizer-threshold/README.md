# Tokenizer Threshold Context Engine

Bundled OpenClaw context engine for the `v2026.6.6` line that **owns** threshold compaction:

1. Counts prompt tokens with a local `js-tiktoken` encoding (default `cl100k_base`)
2. Implements compaction inside the engine (trailing local-tokenizer window) — does **not** call `delegateCompactionToRuntime`
3. Returns that window from `assemble` so mid-loop tool turns stay under the threshold without taking the session write lock
4. Exposes `CompactResult.tokensBefore` / `tokensAfter` so host checkpoint records can persist engine counts when the host calls `compact()`

## What the engine controls

| Surface                      | Engine effect                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt token estimate        | `assemble().estimatedTokens` (local tiktoken)                                                                                            |
| Mid-loop prompt size         | `assemble()` window under `thresholdTokens`                                                                                              |
| Compaction algorithm         | Engine-owned trailing window in `compact()` / `afterTurn`                                                                                |
| Host checkpoint token fields | `CompactResult.result.tokensBefore` / `tokensAfter` / `summary` when host invokes `compact()`                                            |
| Checkpoint reason label      | Host still chooses the persisted trigger path; engine attaches `details.checkpointTrigger` with `path: "context_engine"` for diagnostics |

`afterTurn` refreshes the engine-owned view only. It does **not** write `sessions.json` compaction checkpoints by itself; those records are written by the host when it calls `compact()` (overflow, `/compact`, budget).

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
        },
      },
    },
  },
}
```

Restart the gateway after changing the slot.

## Notes

- `ownsCompaction: true` disables OpenClaw runtime in-attempt auto-compaction for the run.
- Compaction is currently a deterministic local-tokenizer trailing window (no LLM summary rewrite of the session file).
- Keep the threshold below the active model window with headroom.
