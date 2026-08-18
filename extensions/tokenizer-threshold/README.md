# Tokenizer Threshold Context Engine

Bundled OpenClaw context engine for the `v2026.6.6` line that **owns** threshold compaction:

1. Counts prompt tokens with a local `js-tiktoken` encoding (default `cl100k_base`)
2. Observes `llm_input` to cache the rendered **system prompt**, then adds those tokens to the local threshold gate (messages alone are no longer the whole budget)
3. Implements compaction inside the engine using **agent-core `findCutPoint` semantics**: a summary wrapped as a user message (`<summary>...</summary>`) plus a contiguous verbatim tail sized by `keepRecentTokens` (default 20000) — does **not** call `delegateCompactionToRuntime`
4. Returns that compacted message list from `assemble` so mid-loop tool turns stay under the threshold without taking the session write lock
5. Optionally upgrades the extractive summary via `runtimeContext.llm` in `afterTurn` / `compact` when the host provides it
6. Exposes `CompactResult.tokensBefore` / `tokensAfter` so host checkpoint records can persist engine counts when the host calls `compact()`

## What the engine controls

| Surface                      | Engine effect                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt token estimate        | `assemble().estimatedTokens` (local tiktoken of messages + cached system prompt when available)                                          |
| Mid-loop prompt size         | `assemble()` returns `[summary user message] + keepRecentTokens tail` under `thresholdTokens`                                            |
| Compaction cut point         | Port of agent-core `findCutPoint` (token budget from newest end; never cuts on `toolResult`; optional split-turn prefix into summary)    |
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
        // Required for non-bundled installs so llm_input can cache system prompts:
        // hooks: { allowConversationAccess: true },
        config: {
          thresholdTokens: 113000,
          encoding: "cl100k_base", // or o200k_base | p50k_base | r50k_base
          keepRecentTokens: 20000,
        },
      },
    },
  },
}
```

Restart the gateway after changing the slot or plugin source.

## Notes

- `ownsCompaction: true` disables OpenClaw runtime in-attempt auto-compaction for the run.
- `assemble` has no LLM capability, so the first compacted view uses an extractive summary; `afterTurn` upgrades when `runtimeContext.llm` is present.
- System prompt tokens come from the plugin's `llm_input` hook cache. The first `assemble` of a brand-new session may still be messages-only until the first model call fills the cache.
- Tool JSON schemas are still **not** included in the local estimate (not exposed to the context engine).
- Keep `keepRecentTokens` below `thresholdTokens` (the plugin clamps it if needed).
- Keep the threshold below the active model window with headroom.
