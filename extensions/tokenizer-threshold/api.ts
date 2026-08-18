/** Public package surface for the tokenizer-threshold context engine plugin. */
export {
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_THRESHOLD_TOKENS,
  DEFAULT_TOKENIZER_ENCODING,
  resolveTokenizerThresholdConfig,
  type TokenizerThresholdConfig,
  type TokenizerThresholdEncoding,
} from "./src/config.js";
export {
  buildContextEngineCheckpointTrigger,
  createTokenizerThresholdContextEngine,
} from "./src/engine.js";
export {
  computeTokenizerThresholdCompaction,
  splitMessagesAtCutPoint,
  type EngineCompactComputation,
} from "./src/compact-logic.js";
export {
  findMessageCutPoint,
  findMessageTurnStartIndex,
  findValidMessageCutPoints,
  type MessageCutPoint,
  type MessageHistorySplit,
} from "./src/cut-point.js";
export {
  clearSessionCompactionState,
  getSessionCompactionState,
  resetTokenizerThresholdSessionStatesForTest,
  resolveSessionStateKey,
  setSessionCompactionState,
  type TokenizerThresholdSessionState,
} from "./src/session-state.js";
export {
  getCachedSystemPrompt,
  rememberSystemPrompt,
  resetSystemPromptCacheForTest,
} from "./src/system-prompt-cache.js";
export {
  countMessageTokens,
  countPromptTokens,
  countSystemPromptTokens,
  extractMessageText,
  type TokenCounter,
} from "./src/tokenizer.js";
export { windowMessagesToTokenBudget } from "./src/window.js";
