/**
 * Sync JSONL IPC to the persistent Python tokenizer worker.
 *
 * Node 22+/24 pipe sockets leave public `.fd` undefined and mark the libuv fd
 * O_NONBLOCK. We resolve the fd via the socket handle and retry EAGAIN so
 * readSync/writeSync still work without entering the event loop.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PythonWorkerRequest = {
  op: "count" | "ping";
  text?: string;
};

export type PythonWorkerResponse = {
  ok?: boolean;
  tokens?: number;
  error?: string;
  model?: string;
  stub?: boolean;
};

export type PythonWorkerHandles = {
  child: ChildProcessWithoutNullStreams;
  stdinFd: number;
  stdoutFd: number;
  leftover: Buffer;
};

const IPC_TIMEOUT_MS = 120_000;
const IPC_SPIN = new Int32Array(new SharedArrayBuffer(4));

type PipeSocket = {
  fd?: number;
  _handle?: { fd?: number } | null;
};

export function pluginPythonRootDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function tokenCounterServerPath(): string {
  return join(pluginPythonRootDir(), "python", "token_counter_server.py");
}

export function pythonWorkerKey(params: { pythonPath: string; tokenizerModel: string }): string {
  return `${params.pythonPath}\0${params.tokenizerModel}`;
}

/** Resolve a pipe socket fd even when Node hides public `.fd`. */
export function resolvePipeFd(stream: PipeSocket | null | undefined, label: string): number {
  const publicFd = stream?.fd;
  if (typeof publicFd === "number" && Number.isInteger(publicFd) && publicFd >= 0) {
    return publicFd;
  }
  // Node pipe sockets still expose the libuv fd on the internal handle.
  const handleFd = stream?._handle?.fd;
  if (typeof handleFd === "number" && Number.isInteger(handleFd) && handleFd >= 0) {
    return handleFd;
  }
  throw new Error(`tokenizer-threshold: missing ${label} fd for python worker`);
}

function sleepMs(ms: number): void {
  Atomics.wait(IPC_SPIN, 0, 0, Math.max(1, Math.floor(ms)));
}

function isAgainError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === "EAGAIN" || code === "EWOULDBLOCK";
}

export function writeSyncRetry(fd: number, payload: string, timeoutMs = IPC_TIMEOUT_MS): void {
  const bytes = Buffer.from(payload, "utf8");
  let offset = 0;
  const deadline = Date.now() + timeoutMs;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (err) {
      if (!isAgainError(err)) {
        throw err;
      }
      if (Date.now() > deadline) {
        throw new Error("tokenizer-threshold: timed out writing to python worker");
      }
      sleepMs(1);
    }
  }
}

export function readSyncRetry(fd: number, buffer: Buffer, timeoutMs = IPC_TIMEOUT_MS): number {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return readSync(fd, buffer, 0, buffer.length, null);
    } catch (err) {
      if (!isAgainError(err)) {
        throw err;
      }
      if (Date.now() > deadline) {
        throw new Error("tokenizer-threshold: timed out reading from python worker");
      }
      sleepMs(1);
    }
  }
}

export function readPythonWorkerLine(handles: PythonWorkerHandles): string {
  for (;;) {
    const nl = handles.leftover.indexOf(0x0a);
    if (nl !== -1) {
      const line = handles.leftover.subarray(0, nl).toString("utf8");
      handles.leftover = handles.leftover.subarray(nl + 1);
      return line;
    }
    const buf = Buffer.alloc(8192);
    const n = readSyncRetry(handles.stdoutFd, buf);
    if (n === 0) {
      throw new Error("tokenizer-threshold: python worker closed stdout");
    }
    handles.leftover = Buffer.concat([handles.leftover, buf.subarray(0, n)]);
  }
}

export function writePythonWorkerRequest(
  handles: PythonWorkerHandles,
  request: PythonWorkerRequest,
): PythonWorkerResponse {
  if (handles.child.exitCode !== null || handles.child.signalCode) {
    throw new Error("tokenizer-threshold: python worker exited");
  }
  writeSyncRetry(handles.stdinFd, `${JSON.stringify(request)}\n`);
  const line = readPythonWorkerLine(handles);
  let parsed: PythonWorkerResponse;
  try {
    parsed = JSON.parse(line) as PythonWorkerResponse;
  } catch {
    throw new Error(`tokenizer-threshold: invalid worker response: ${line.slice(0, 200)}`);
  }
  if (parsed.ok !== true) {
    throw new Error(parsed.error?.trim() || "tokenizer-threshold: python worker failed");
  }
  return parsed;
}

export function spawnPythonWorker(params: {
  pythonPath: string;
  tokenizerModel: string;
  env?: NodeJS.ProcessEnv;
}): PythonWorkerHandles {
  const child = spawn(params.pythonPath, [tokenCounterServerPath()], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      ...params.env,
      TOKENIZER_THRESHOLD_MODEL: params.tokenizerModel,
    },
  }) as ChildProcessWithoutNullStreams;

  // Keep pipe sockets paused so only sync fd reads consume stdout bytes.
  child.stdout.pause();

  return {
    child,
    stdinFd: resolvePipeFd(child.stdin, "stdin"),
    stdoutFd: resolvePipeFd(child.stdout, "stdout"),
    leftover: Buffer.alloc(0),
  };
}
