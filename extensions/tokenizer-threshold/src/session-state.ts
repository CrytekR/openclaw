/**
 * Process-local compaction view owned by the tokenizer-threshold engine.
 * Survives mid-loop assemble/afterTurn without touching the live session file.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

export type TokenizerThresholdSessionState = {
  /** Source transcript length when compactedMessages was produced. */
  compactedSourceLength: number;
  compactedMessages: AgentMessage[];
  tokensBefore: number;
  tokensAfter: number;
  summary: string;
};

const sessionStates = new Map<string, TokenizerThresholdSessionState>();

export function resolveSessionStateKey(params: { sessionId: string; sessionKey?: string }): string {
  const sessionKey = params.sessionKey?.trim();
  return sessionKey || params.sessionId;
}

export function getSessionCompactionState(key: string): TokenizerThresholdSessionState | undefined {
  return sessionStates.get(key);
}

export function setSessionCompactionState(
  key: string,
  state: TokenizerThresholdSessionState,
): void {
  sessionStates.set(key, state);
}

export function clearSessionCompactionState(key: string): void {
  sessionStates.delete(key);
}

/** Test-only: drop all in-memory session compaction views. */
export function resetTokenizerThresholdSessionStatesForTest(): void {
  sessionStates.clear();
}
