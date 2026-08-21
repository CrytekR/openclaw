/**
 * Local token counting for the context engine via Python transformers.
 * Default model: bundled deepseek-v4-flash (python/bundled/..., offline).
 */
import type { TokenizerThresholdConfig } from "./config.js";
import {
  pythonWorkerKey,
  spawnPythonWorker,
  writePythonWorkerRequest,
  type PythonWorkerHandles,
} from "./python-worker-ipc.js";

export type TokenCounter = {
  countText: (text: string) => number;
  /** True after at least one Python tokenizer failure on this counter. */
  isDegraded: () => boolean;
};

export type CreateTokenCounterOptions = {
  /** Rate-limited operator warning when the Python worker fails. */
  onWarn?: (message: string) => void;
};

const workers = new Map<string, PythonWorkerHandles>();

/** Approximate chars-per-token when the real tokenizer is unavailable. */
const FALLBACK_CHARS_PER_TOKEN = 4;
const WARN_COOLDOWN_MS = 30_000;

function ensureWorker(params: { pythonPath: string; tokenizerModel: string }): PythonWorkerHandles {
  const key = pythonWorkerKey(params);
  const existing = workers.get(key);
  if (existing && existing.child.exitCode === null && !existing.child.signalCode) {
    return existing;
  }
  if (existing) {
    workers.delete(key);
    try {
      existing.child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  const handles = spawnPythonWorker(params);

  handles.child.on("exit", () => {
    if (workers.get(key) === handles) {
      workers.delete(key);
    }
  });

  workers.set(key, handles);

  // Block until the tokenizer finishes loading (first request).
  writePythonWorkerRequest(handles, { op: "ping" });
  return handles;
}

/**
 * Fallback estimate when Python transformers is unavailable.
 * Prefer ~chars/4 over whitespace splits (awful for CJK).
 */
function estimateTokensFallback(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(Array.from(text).length / FALLBACK_CHARS_PER_TOKEN));
}

/** Vitest / TOKENIZER_THRESHOLD_STUB: same ~chars/4 estimate as the live fallback. */
function stubCountText(text: string): number {
  return estimateTokensFallback(text);
}

/**
 * Count tokens with Hugging Face transformers via a persistent Python worker.
 * Under Vitest / TOKENIZER_THRESHOLD_STUB=1, uses a deterministic char-count stub.
 * On worker failure: warn (rate-limited), mark degraded, and fall back to ~chars/4.
 */
export function createTokenCounter(
  config: TokenizerThresholdConfig,
  options: CreateTokenCounterOptions = {},
): TokenCounter {
  if (process.env.VITEST || process.env.TOKENIZER_THRESHOLD_STUB === "1") {
    return {
      countText: stubCountText,
      isDegraded: () => false,
    };
  }

  let degraded = false;
  let lastWarnAt = 0;
  const onWarn = options.onWarn;

  const markDegraded = (reason: string) => {
    degraded = true;
    const now = Date.now();
    if (now - lastWarnAt < WARN_COOLDOWN_MS) {
      return;
    }
    lastWarnAt = now;
    // Operators must notice silent under/over-counting; cooldown avoids log storms.
    onWarn?.(
      `tokenizer-threshold: Python tokenizer unavailable (${reason}); ` +
        `using ~chars/${FALLBACK_CHARS_PER_TOKEN} estimates until the worker recovers. ` +
        `Install: pip install 'transformers>=4.51'`,
    );
  };

  return {
    isDegraded: () => degraded,
    countText(text: string): number {
      if (!text) {
        return 0;
      }
      try {
        const handles = ensureWorker({
          pythonPath: config.pythonPath,
          tokenizerModel: config.tokenizerModel,
        });
        const response = writePythonWorkerRequest(handles, { op: "count", text });
        const tokens = response.tokens;
        if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
          throw new Error("tokenizer-threshold: worker returned invalid token count");
        }
        return Math.floor(tokens);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        markDegraded(reason);
        return estimateTokensFallback(text);
      }
    },
  };
}

/** @deprecated Prefer createTokenCounter(config); kept for call-site clarity in tests. */
export function getLocalTokenCounter(config: TokenizerThresholdConfig): TokenCounter {
  return createTokenCounter(config);
}

/** Best-effort shutdown of cached Python workers (tests / plugin dispose). */
export function disposeTokenizerWorkers(): void {
  for (const [key, handles] of workers) {
    workers.delete(key);
    try {
      handles.child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

/** Flatten assistant/user/tool message content into countable text. */
export function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as {
    role?: unknown;
    content?: unknown;
    errorMessage?: unknown;
    name?: unknown;
  };
  const parts: string[] = [];
  if (typeof record.role === "string" && record.role.trim()) {
    parts.push(record.role);
  }
  if (typeof record.name === "string" && record.name.trim()) {
    parts.push(record.name);
  }
  const content = record.content;
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const typed = block as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      if (typeof typed.text === "string") {
        parts.push(typed.text);
      }
      if (typeof typed.thinking === "string") {
        parts.push(typed.thinking);
      }
      if (typeof typed.name === "string") {
        parts.push(typed.name);
      }
      if (typed.arguments !== undefined) {
        try {
          parts.push(
            typeof typed.arguments === "string" ? typed.arguments : JSON.stringify(typed.arguments),
          );
        } catch {
          // Ignore non-serializable tool args for counting.
        }
      }
    }
  }
  if (typeof record.errorMessage === "string" && record.errorMessage.trim()) {
    parts.push(record.errorMessage);
  }
  return parts.join("\n");
}

/** Sum local tokenizer counts across a message list. */
export function countMessageTokens(params: {
  messages: readonly unknown[];
  counter: TokenCounter;
}): number {
  let total = 0;
  for (const message of params.messages) {
    // Per-message framing overhead is small vs content; keep the counter
    // content-faithful and deterministic for threshold decisions.
    total += params.counter.countText(extractMessageText(message));
    total += 4;
  }
  return total;
}

/** Count tokens for a cached system prompt string (0 when missing/blank). */
export function countSystemPromptTokens(params: {
  systemPrompt?: string;
  counter: TokenCounter;
}): number {
  const text = params.systemPrompt?.trim();
  if (!text) {
    return 0;
  }
  // Small framing overhead so system text is not treated cheaper than messages.
  return params.counter.countText(text) + 4;
}

/** Count tokens for provider-bound tool JSON schemas (0 when missing/blank). */
export function countToolsSchemaTokens(params: {
  toolsSchema?: string;
  toolsSchemaTokens?: number;
  counter: TokenCounter;
}): number {
  if (
    typeof params.toolsSchemaTokens === "number" &&
    Number.isFinite(params.toolsSchemaTokens) &&
    params.toolsSchemaTokens > 0
  ) {
    return Math.floor(params.toolsSchemaTokens);
  }
  const text = params.toolsSchema?.trim();
  if (!text) {
    return 0;
  }
  return params.counter.countText(text) + 4;
}

/**
 * Local prompt pressure: messages + cached system prompt + cached tool schemas.
 * Aligns better with OpenClaw's displayed provider prompt/context length.
 */
export function countPromptTokens(params: {
  messages: readonly unknown[];
  systemPrompt?: string;
  toolsSchema?: string;
  toolsSchemaTokens?: number;
  counter: TokenCounter;
}): number {
  return (
    countMessageTokens({ messages: params.messages, counter: params.counter }) +
    countSystemPromptTokens({
      systemPrompt: params.systemPrompt,
      counter: params.counter,
    }) +
    countToolsSchemaTokens({
      toolsSchema: params.toolsSchema,
      toolsSchemaTokens: params.toolsSchemaTokens,
      counter: params.counter,
    })
  );
}
