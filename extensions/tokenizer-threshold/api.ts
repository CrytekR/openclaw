/** Public package surface for the tokenizer-threshold context engine plugin. */
export {
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
  type EngineCompactComputation,
} from "./src/compact-logic.js";
export {
  clearSessionCompactionState,
  getSessionCompactionState,
  resetTokenizerThresholdSessionStatesForTest,
  resolveSessionStateKey,
  setSessionCompactionState,
  type TokenizerThresholdSessionState,
} from "./src/session-state.js";
export { countMessageTokens, extractMessageText, type TokenCounter } from "./src/tokenizer.js";
export { windowMessagesToTokenBudget } from "./src/window.js";
