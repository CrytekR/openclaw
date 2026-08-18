/**
 * Local token counting for the context engine via Python transformers.
 * Default model: deepseek-ai/DeepSeek-V4-Flash (deepseek-v4-flash).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TokenizerThresholdConfig } from "./config.js";

export type TokenCounter = {
  countText: (text: string) => number;
};

type WorkerRequest = {
  op: "count" | "ping";
  text?: string;
};

type WorkerResponse = {
  ok?: boolean;
  tokens?: number;
  error?: string;
};

type WorkerHandles = {
  child: ChildProcessWithoutNullStreams;
  stdinFd: number;
  stdoutFd: number;
  leftover: Buffer;
};

const workers = new Map<string, WorkerHandles>();

function pluginRootDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function workerScriptPath(): string {
  return join(pluginRootDir(), "python", "token_counter_server.py");
}

function workerKey(params: { pythonPath: string; tokenizerModel: string }): string {
  return `${params.pythonPath}\0${params.tokenizerModel}`;
}

function requireFd(stream: { fd?: number } | null | undefined, label: string): number {
  const fd = stream?.fd;
  if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0) {
    throw new Error(`tokenizer-threshold: missing ${label} fd for python worker`);
  }
  return fd;
}

function readLine(handles: WorkerHandles): string {
  for (;;) {
    const nl = handles.leftover.indexOf(0x0a);
    if (nl !== -1) {
      const line = handles.leftover.subarray(0, nl).toString("utf8");
      handles.leftover = handles.leftover.subarray(nl + 1);
      return line;
    }
    const buf = Buffer.alloc(8192);
    const n = readSync(handles.stdoutFd, buf, 0, buf.length, null);
    if (n === 0) {
      throw new Error("tokenizer-threshold: python worker closed stdout");
    }
    handles.leftover = Buffer.concat([handles.leftover, buf.subarray(0, n)]);
  }
}

function writeRequest(handles: WorkerHandles, request: WorkerRequest): WorkerResponse {
  if (handles.child.exitCode !== null || handles.child.signalCode) {
    throw new Error("tokenizer-threshold: python worker exited");
  }
  writeSync(handles.stdinFd, `${JSON.stringify(request)}\n`, null, "utf8");
  const line = readLine(handles);
  let parsed: WorkerResponse;
  try {
    parsed = JSON.parse(line) as WorkerResponse;
  } catch {
    throw new Error(`tokenizer-threshold: invalid worker response: ${line.slice(0, 200)}`);
  }
  if (parsed.ok !== true) {
    throw new Error(parsed.error?.trim() || "tokenizer-threshold: python worker failed");
  }
  return parsed;
}

function ensureWorker(params: { pythonPath: string; tokenizerModel: string }): WorkerHandles {
  const key = workerKey(params);
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

  const child = spawn(params.pythonPath, [workerScriptPath()], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      TOKENIZER_THRESHOLD_MODEL: params.tokenizerModel,
    },
  }) as ChildProcessWithoutNullStreams;

  const handles: WorkerHandles = {
    child,
    stdinFd: requireFd(child.stdin, "stdin"),
    stdoutFd: requireFd(child.stdout, "stdout"),
    leftover: Buffer.alloc(0),
  };

  child.on("exit", () => {
    if (workers.get(key) === handles) {
      workers.delete(key);
    }
  });

  workers.set(key, handles);

  // Block until the tokenizer finishes loading (first request).
  writeRequest(handles, { op: "ping" });
  return handles;
}

function whitespaceFallbackCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(/\s+/).filter(Boolean).length;
}

/** Vitest / TOKENIZER_THRESHOLD_STUB: ~chars/4 so small test budgets stay realistic. */
function stubCountText(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(Array.from(text).length / 4));
}

/**
 * Count tokens with Hugging Face transformers via a persistent Python worker.
 * Under Vitest / TOKENIZER_THRESHOLD_STUB=1, uses a deterministic char-count stub.
 */
export function createTokenCounter(config: TokenizerThresholdConfig): TokenCounter {
  if (process.env.VITEST || process.env.TOKENIZER_THRESHOLD_STUB === "1") {
    return { countText: stubCountText };
  }

  return {
    countText(text: string): number {
      if (!text) {
        return 0;
      }
      try {
        const handles = ensureWorker({
          pythonPath: config.pythonPath,
          tokenizerModel: config.tokenizerModel,
        });
        const response = writeRequest(handles, { op: "count", text });
        const tokens = response.tokens;
        if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
          throw new Error("tokenizer-threshold: worker returned invalid token count");
        }
        return Math.floor(tokens);
      } catch {
        return whitespaceFallbackCount(text);
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

/**
 * Local prompt pressure: session messages plus optional cached system prompt.
 * Tool JSON schemas are still outside this estimate (not available to the engine).
 */
export function countPromptTokens(params: {
  messages: readonly unknown[];
  systemPrompt?: string;
  counter: TokenCounter;
}): number {
  return (
    countMessageTokens({ messages: params.messages, counter: params.counter }) +
    countSystemPromptTokens({
      systemPrompt: params.systemPrompt,
      counter: params.counter,
    })
  );
}
