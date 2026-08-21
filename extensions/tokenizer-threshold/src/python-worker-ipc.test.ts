import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolvePipeFd, spawnPythonWorker, writePythonWorkerRequest } from "./python-worker-ipc.js";

describe("python-worker-ipc", () => {
  it("resolves pipe fds when public stream.fd is undefined (Node 22+/24)", () => {
    const child = spawn("python3", ["-c", "pass"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      expect(child.stdin.fd).toBeUndefined();
      expect(child.stdout.fd).toBeUndefined();
      expect(resolvePipeFd(child.stdin, "stdin")).toBeGreaterThanOrEqual(0);
      expect(resolvePipeFd(child.stdout, "stdout")).toBeGreaterThanOrEqual(0);
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("speaks JSONL with the stub python tokenizer without public .fd", () => {
    const handles = spawnPythonWorker({
      pythonPath: "python3",
      tokenizerModel: "deepseek-v4-flash",
      env: {
        TOKENIZER_THRESHOLD_STUB: "1",
      },
    });
    try {
      expect(handles.child.stdin.fd).toBeUndefined();
      expect(handles.child.stdout.fd).toBeUndefined();

      const ping = writePythonWorkerRequest(handles, { op: "ping" });
      expect(ping.ok).toBe(true);
      expect(ping.stub).toBe(true);

      const counted = writePythonWorkerRequest(handles, {
        op: "count",
        text: "hello world",
      });
      expect(counted.ok).toBe(true);
      expect(counted.tokens).toBeGreaterThan(0);
    } finally {
      try {
        handles.child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  });
});
