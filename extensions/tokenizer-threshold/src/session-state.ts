/**
 * Process-local compaction view owned by the tokenizer-threshold engine.
 * Survives mid-loop assemble/afterTurn without touching the live session file.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

export type TokenizerThresholdSessionState = {
  /** Source transcript length when compactedMessages was produced. */
  compactedSourceLength: number;
  /** How many leading source messages were folded into the summary. */
  summarizableCount: number;
  /** Fingerprint of the summarizable prefix for cache reuse. */
  summarizableFingerprint: string;
  compactedMessages: AgentMessage[];
  tokensBefore: number;
  tokensAfter: number;
  summary: string;
  /** True when summary came from runtimeContext.llm rather than extractive text. */
  summaryFromLlm: boolean;
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

/** Stable fingerprint for the summarizable message prefix. */
export function fingerprintSummarizableMessages(messages: readonly AgentMessage[]): string {
  let totalChars = 0;
  const roles: string[] = [];
  for (const message of messages) {
    const role = (message as { role?: unknown }).role;
    roles.push(typeof role === "string" ? role : "?");
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      totalChars += content.length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          totalChars += (block as { text: string }).text.length;
        }
      }
    }
  }
  return `${messages.length}:${totalChars}:${roles.join(",")}`;
}
