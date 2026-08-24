/**
 * Process-local cache of the latest llm_input system prompt per session.
 *
 * Context-engine assemble does not receive system prompt text. The plugin
 * registers an llm_input hook that fills this map so threshold gating can add
 * system tokens to the local message count. First assemble of a turn may still
 * miss a cache entry until the first model call of that session.
 */

const systemPromptBySession = new Map<string, string>();

function normalizeKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Remember the system prompt observed on llm_input for a session. */
export function rememberSystemPrompt(params: {
  sessionId?: string;
  sessionKey?: string;
  systemPrompt: string;
}): void {
  const text = params.systemPrompt.trim();
  if (!text) {
    return;
  }
  const sessionId = normalizeKey(params.sessionId);
  const sessionKey = normalizeKey(params.sessionKey);
  if (sessionId) {
    systemPromptBySession.set(sessionId, text);
  }
  if (sessionKey && sessionKey !== sessionId) {
    systemPromptBySession.set(sessionKey, text);
  }
}

/** Look up a cached system prompt by session id and/or session key. */
export function getCachedSystemPrompt(params: {
  sessionId?: string;
  sessionKey?: string;
}): string | undefined {
  const sessionKey = normalizeKey(params.sessionKey);
  if (sessionKey) {
    const byKey = systemPromptBySession.get(sessionKey);
    if (byKey) {
      return byKey;
    }
  }
  const sessionId = normalizeKey(params.sessionId);
  if (sessionId) {
    return systemPromptBySession.get(sessionId);
  }
  return undefined;
}

/** Test-only: drop all cached system prompts. */
export function resetSystemPromptCacheForTest(): void {
  systemPromptBySession.clear();
}
