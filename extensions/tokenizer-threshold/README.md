# Tokenizer Threshold Context Engine

Bundled OpenClaw context engine that:

1. Loads a local tiktoken encoding via `js-tiktoken` (default `cl100k_base`)
2. Counts prompt tokens before each model call (`assemble`) and after tool-loop turns (`afterTurn`)
3. Triggers compaction when the count reaches a fixed threshold (default **113000**)
4. Windows the in-flight prompt to stay under the threshold while durable compaction runs

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
- Native char/tool-result guards can still fire if the assembled view remains oversized; keep the threshold below the active model window with headroom.
