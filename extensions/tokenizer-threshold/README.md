# Tokenizer Threshold Context Engine

Bundled OpenClaw context engine for the `v2026.6.6` line that:

1. Loads a local tiktoken encoding via `js-tiktoken` (default `cl100k_base`)
2. Returns a trailing prompt window from `assemble` when the local count is at/over the threshold
3. Triggers durable compaction in `afterTurn` when the local count reaches the threshold **and** the session write lock is free
4. Delegates summarization to OpenClaw runtime via `delegateCompactionToRuntime`

During a live tool loop the attempt already holds the session write lock, so durable `afterTurn` compaction cannot safely open another session writer. The ownsCompaction loop hook still calls `assemble` after each new tool result; that prompt window is what keeps mid-loop model calls under the threshold. Durable compaction with a **Context engine** checkpoint runs when the lock is free (for example after an abort releases it, or outside the live attempt).

Same-turn overflow recovery still uses the host path: `compact()` → adopt successor transcript → retry → next `assemble` sees the compacted messages.

When this engine triggers durable compaction, the checkpoint reason is labeled **Context engine** and includes the local tokenizer count plus the configured threshold, for example:

`Context engine projectedTokens=120500 thresholdTokens=113000`

The gate always uses the local tiktoken count of session messages (not the last model `usage` snapshot).

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

- `ownsCompaction: true` disables OpenClaw runtime in-attempt auto-compaction for the run; this engine owns the threshold decision and delegates the summarization algorithm to `delegateCompactionToRuntime`.
- Mid-loop pressure is handled by `assemble` windowing under the live session lock; durable compaction is skipped (fail-fast) while that lock is held so the tool loop does not stall on lock acquire.
- Native char/tool-result guards can still fire if the prompt remains oversized; keep the threshold below the active model window with headroom.
