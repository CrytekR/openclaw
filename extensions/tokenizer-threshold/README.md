# Tokenizer Threshold Context Engine

Bundled OpenClaw context engine for the `v2026.6.6` line that:

1. Loads a local tiktoken encoding via `js-tiktoken` (default `cl100k_base`)
2. Passes `assemble` messages through unchanged (reports a local tokenizer estimate only)
3. Triggers durable compaction in `afterTurn` when the local count reaches the threshold (default **113000**)
4. Delegates summarization to OpenClaw runtime via `delegateCompactionToRuntime`

Same-turn recovery still uses the host overflow path: `compact()` → adopt successor transcript → retry → next `assemble` sees the compacted messages.

When this engine triggers compaction, the checkpoint reason is labeled **Context engine** and includes the local tokenizer count plus the configured threshold, for example:

`Context engine projectedTokens=120500 thresholdTokens=113000`

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
- `assemble` does not compact or window; it returns the host-provided messages as-is.
- Proactive durable compaction runs in `afterTurn`, so the next turn's `assemble` receives host-reloaded post-compaction messages.
- Native char/tool-result guards can still fire if the prompt remains oversized; keep the threshold below the active model window with headroom.
