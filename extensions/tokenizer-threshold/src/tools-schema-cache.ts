/**
 * Process-local cache of llm_input tool-schema token estimates per session.
 *
 * OpenClaw's displayed context length is provider prompt usage and includes
 * tool JSON schemas. Context-engine assemble cannot see those schemas, so the
 * plugin caches a local count from llm_input.tools for threshold gating.
 */

const toolsSchemaTokensBySession = new Map<string, number>();

function normalizeKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function writeKeys(params: { sessionId?: string; sessionKey?: string }, tokens: number): void {
  const sessionId = normalizeKey(params.sessionId);
  const sessionKey = normalizeKey(params.sessionKey);
  if (sessionId) {
    toolsSchemaTokensBySession.set(sessionId, tokens);
  }
  if (sessionKey && sessionKey !== sessionId) {
    toolsSchemaTokensBySession.set(sessionKey, tokens);
  }
}

/** Serialize tool definitions the same way providers typically bill schema bytes. */
export function serializeToolsSchema(tools: unknown): string {
  if (!Array.isArray(tools) || tools.length === 0) {
    return "";
  }
  try {
    return JSON.stringify(tools);
  } catch {
    return "";
  }
}

/** Remember tool-schema token pressure observed on llm_input for a session. */
export function rememberToolsSchemaTokens(params: {
  sessionId?: string;
  sessionKey?: string;
  tokens: number;
}): void {
  const tokens =
    typeof params.tokens === "number" && Number.isFinite(params.tokens) && params.tokens > 0
      ? Math.floor(params.tokens)
      : 0;
  writeKeys(params, tokens);
}

/** Look up cached tool-schema tokens by session id and/or session key. */
export function getCachedToolsSchemaTokens(params: {
  sessionId?: string;
  sessionKey?: string;
}): number {
  const sessionKey = normalizeKey(params.sessionKey);
  if (sessionKey) {
    const byKey = toolsSchemaTokensBySession.get(sessionKey);
    if (typeof byKey === "number") {
      return byKey;
    }
  }
  const sessionId = normalizeKey(params.sessionId);
  if (sessionId) {
    return toolsSchemaTokensBySession.get(sessionId) ?? 0;
  }
  return 0;
}

/** Test-only: drop all cached tool-schema token counts. */
export function resetToolsSchemaCacheForTest(): void {
  toolsSchemaTokensBySession.clear();
}
