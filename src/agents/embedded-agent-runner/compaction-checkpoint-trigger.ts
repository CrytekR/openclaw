/**
 * Builds and normalizes compaction-checkpoint trigger snapshots.
 * Keeps gate path + calculation facts on the durable checkpoint record.
 */
import type {
  SessionCompactionCheckpointProjectedBreakdown,
  SessionCompactionCheckpointTrigger,
  SessionCompactionCheckpointTriggerPath,
} from "../../config/sessions/types.js";

/** Structural preflight notice details used when mapping onto checkpoint triggers. */
export type CompactionCheckpointPreflightDetails = {
  trigger?: "tokens" | "transcript_bytes" | "overflow" | "manual" | "threshold" | "budget";
  projectedTokens?: number;
  projectedBreakdown?: SessionCompactionCheckpointProjectedBreakdown;
  threshold?: number;
  activeTranscriptBytes?: number;
  maxActiveTranscriptBytes?: number;
};

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function readNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

/** Keep provider error text short and single-line for sessions.json. */
const MAX_OVERFLOW_ERROR_TEXT_CHARS = 500;

function normalizeOverflowErrorText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= MAX_OVERFLOW_ERROR_TEXT_CHARS) {
    return trimmed;
  }
  return trimmed.slice(0, MAX_OVERFLOW_ERROR_TEXT_CHARS);
}

function normalizeProjectedBreakdown(
  value: SessionCompactionCheckpointProjectedBreakdown | undefined,
): SessionCompactionCheckpointProjectedBreakdown | undefined {
  if (!value) {
    return undefined;
  }
  const baseTokens = readNonNegativeInt(value.baseTokens);
  if (baseTokens === undefined) {
    return undefined;
  }
  if (
    value.source !== "transcript_usage" &&
    value.source !== "fresh_persisted" &&
    value.source !== "persisted"
  ) {
    return undefined;
  }
  const lastOutputTokens = readPositiveInt(value.lastOutputTokens);
  const promptEstimateTokens = readPositiveInt(value.promptEstimateTokens);
  const recountMethod =
    value.source === "transcript_usage" &&
    (value.recountMethod === "last_model_usage" ||
      value.recountMethod === "model_usage_plus_unread_tail" ||
      value.recountMethod === "recent_messages_estimate" ||
      value.recountMethod === "chat_log_file_size")
      ? value.recountMethod
      : undefined;
  return {
    source: value.source,
    baseTokens,
    ...(lastOutputTokens !== undefined ? { lastOutputTokens } : {}),
    ...(promptEstimateTokens !== undefined ? { promptEstimateTokens } : {}),
    ...(recountMethod ? { recountMethod } : {}),
  };
}

/** Drop invalid/empty fields so persisted checkpoints stay compact and typed. */
export function normalizeSessionCompactionCheckpointTrigger(
  value: SessionCompactionCheckpointTrigger | undefined,
): SessionCompactionCheckpointTrigger | undefined {
  if (!value?.path) {
    return undefined;
  }
  const path = value.path;
  if (
    path !== "preflight_tokens" &&
    path !== "preflight_transcript_bytes" &&
    path !== "pre_prompt_precheck" &&
    path !== "char_overflow_guard" &&
    path !== "midturn_precheck" &&
    path !== "overflow_retry" &&
    path !== "timeout_retry" &&
    path !== "auto_threshold" &&
    path !== "manual"
  ) {
    return undefined;
  }
  const trigger =
    value.trigger === "tokens" ||
    value.trigger === "transcript_bytes" ||
    value.trigger === "overflow" ||
    value.trigger === "manual" ||
    value.trigger === "threshold" ||
    value.trigger === "budget"
      ? value.trigger
      : undefined;
  const projectedTokens = readPositiveInt(value.projectedTokens);
  const projectedBreakdown = normalizeProjectedBreakdown(value.projectedBreakdown);
  const thresholdTokens = readPositiveInt(value.thresholdTokens);
  const contextWindowTokens = readPositiveInt(value.contextWindowTokens);
  const activeTranscriptBytes = readNonNegativeInt(value.activeTranscriptBytes);
  const maxActiveTranscriptBytes = readPositiveInt(value.maxActiveTranscriptBytes);
  const attempt = readPositiveInt(value.attempt);
  const overflowRoute =
    value.overflowRoute === "compact_only" ||
    value.overflowRoute === "truncate_tool_results_only" ||
    value.overflowRoute === "compact_then_truncate"
      ? value.overflowRoute
      : undefined;
  const overflowSource =
    value.overflowSource === "promptError" ||
    value.overflowSource === "assistantError" ||
    value.overflowSource === "mid-turn" ||
    value.overflowSource === "precheck"
      ? value.overflowSource
      : undefined;
  const overflowErrorText = normalizeOverflowErrorText(value.overflowErrorText);
  const estimatedPromptTokens = readPositiveInt(value.estimatedPromptTokens);
  const promptBudgetBeforeReserve = readPositiveInt(value.promptBudgetBeforeReserve);
  const overflowTokens = readPositiveInt(value.overflowTokens);
  const promptTokens = readPositiveInt(value.promptTokens);
  const observedOverflowTokens = readPositiveInt(value.observedOverflowTokens);
  const compactionTokens = readPositiveInt(value.compactionTokens);
  const estimatedContextChars = readPositiveInt(value.estimatedContextChars);
  const maxContextChars = readPositiveInt(value.maxContextChars);
  return {
    path,
    ...(trigger ? { trigger } : {}),
    ...(projectedTokens !== undefined ? { projectedTokens } : {}),
    ...(projectedBreakdown ? { projectedBreakdown } : {}),
    ...(thresholdTokens !== undefined ? { thresholdTokens } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(activeTranscriptBytes !== undefined ? { activeTranscriptBytes } : {}),
    ...(maxActiveTranscriptBytes !== undefined ? { maxActiveTranscriptBytes } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(overflowRoute ? { overflowRoute } : {}),
    ...(overflowSource ? { overflowSource } : {}),
    ...(overflowErrorText ? { overflowErrorText } : {}),
    ...(estimatedPromptTokens !== undefined ? { estimatedPromptTokens } : {}),
    ...(promptBudgetBeforeReserve !== undefined ? { promptBudgetBeforeReserve } : {}),
    ...(overflowTokens !== undefined ? { overflowTokens } : {}),
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(observedOverflowTokens !== undefined ? { observedOverflowTokens } : {}),
    ...(compactionTokens !== undefined ? { compactionTokens } : {}),
    ...(estimatedContextChars !== undefined ? { estimatedContextChars } : {}),
    ...(maxContextChars !== undefined ? { maxContextChars } : {}),
  };
}

/** Map preflight notice details onto the durable checkpoint trigger snapshot. */
export function buildCheckpointTriggerFromPreflightDetails(params: {
  details: CompactionCheckpointPreflightDetails;
  contextWindowTokens?: number;
}): SessionCompactionCheckpointTrigger {
  const path: SessionCompactionCheckpointTriggerPath =
    params.details.trigger === "transcript_bytes"
      ? "preflight_transcript_bytes"
      : "preflight_tokens";
  return normalizeSessionCompactionCheckpointTrigger({
    path,
    trigger:
      params.details.trigger ??
      (path === "preflight_transcript_bytes" ? "transcript_bytes" : "tokens"),
    ...(typeof params.details.projectedTokens === "number"
      ? { projectedTokens: params.details.projectedTokens }
      : {}),
    ...(params.details.projectedBreakdown
      ? { projectedBreakdown: params.details.projectedBreakdown }
      : {}),
    ...(typeof params.details.threshold === "number"
      ? { thresholdTokens: params.details.threshold }
      : {}),
    ...(typeof params.contextWindowTokens === "number"
      ? { contextWindowTokens: params.contextWindowTokens }
      : {}),
    ...(typeof params.details.activeTranscriptBytes === "number"
      ? { activeTranscriptBytes: params.details.activeTranscriptBytes }
      : {}),
    ...(typeof params.details.maxActiveTranscriptBytes === "number"
      ? { maxActiveTranscriptBytes: params.details.maxActiveTranscriptBytes }
      : {}),
  })!;
}

/**
 * Classify an overflow-recovery compaction into the concrete entry path that
 * operators expect to see on checkpoint `reason` / `trigger.path`.
 */
export function resolveOverflowCompactionTriggerPath(params: {
  preflightRecoverySource?: "mid-turn";
  promptErrorSource?: string | null;
  overflowErrorText?: string;
  /** Where the overflow was observed: prompt throw vs assistant/provider error text. */
  overflowErrorSource?: "promptError" | "assistantError";
}): Extract<
  SessionCompactionCheckpointTriggerPath,
  "pre_prompt_precheck" | "char_overflow_guard" | "midturn_precheck" | "overflow_retry"
> {
  if (params.preflightRecoverySource === "mid-turn") {
    return "midturn_precheck";
  }
  // OpenClaw-owned char-guard text from transformContext. The agent loop can
  // absorb that throw into an assistant stopReason=error, so observation may
  // be assistantError even though the message is not a provider API response.
  if (
    typeof params.overflowErrorText === "string" &&
    params.overflowErrorText.includes("exceeds safe threshold during tool loop")
  ) {
    return "char_overflow_guard";
  }
  if (params.promptErrorSource === "precheck") {
    return "pre_prompt_precheck";
  }
  return "overflow_retry";
}

/**
 * Build the path-specific overflow-recovery checkpoint trigger snapshot.
 * Keeps each path's gate fields distinct so reason strings do not reuse
 * preflight `projectedTokens` for provider/char/precheck recovery math.
 */
export function buildOverflowCompactionCheckpointTrigger(params: {
  path: Extract<
    SessionCompactionCheckpointTriggerPath,
    "pre_prompt_precheck" | "char_overflow_guard" | "midturn_precheck" | "overflow_retry"
  >;
  contextWindowTokens?: number;
  observedOverflowTokens?: number;
  compactionTokens?: number;
  attempt: number;
  overflowRoute?: SessionCompactionCheckpointTrigger["overflowRoute"];
  overflowSource?: SessionCompactionCheckpointTrigger["overflowSource"];
  /** Provider/stream error text; persisted for assistantError model-API failures. */
  overflowErrorText?: string;
  estimatedPromptTokens?: number;
  promptBudgetBeforeReserve?: number;
  overflowTokens?: number;
  maxContextChars?: number;
  estimatedContextChars?: number;
}): SessionCompactionCheckpointTrigger {
  const shared = {
    path: params.path,
    trigger: "overflow" as const,
    attempt: params.attempt,
    ...(typeof params.contextWindowTokens === "number"
      ? { contextWindowTokens: params.contextWindowTokens }
      : {}),
    ...(params.overflowRoute ? { overflowRoute: params.overflowRoute } : {}),
    ...(params.overflowSource ? { overflowSource: params.overflowSource } : {}),
    ...(params.overflowErrorText ? { overflowErrorText: params.overflowErrorText } : {}),
  };

  if (params.path === "char_overflow_guard") {
    return normalizeSessionCompactionCheckpointTrigger({
      ...shared,
      ...(typeof params.maxContextChars === "number"
        ? { maxContextChars: params.maxContextChars }
        : {}),
      ...(typeof params.estimatedContextChars === "number"
        ? { estimatedContextChars: params.estimatedContextChars }
        : {}),
    })!;
  }

  if (params.path === "pre_prompt_precheck" || params.path === "midturn_precheck") {
    return normalizeSessionCompactionCheckpointTrigger({
      ...shared,
      ...(typeof params.estimatedPromptTokens === "number"
        ? { estimatedPromptTokens: params.estimatedPromptTokens }
        : {}),
      ...(typeof params.promptBudgetBeforeReserve === "number"
        ? { promptBudgetBeforeReserve: params.promptBudgetBeforeReserve }
        : {}),
      ...(typeof params.overflowTokens === "number"
        ? { overflowTokens: params.overflowTokens }
        : {}),
    })!;
  }

  return normalizeSessionCompactionCheckpointTrigger({
    ...shared,
    ...(typeof params.observedOverflowTokens === "number"
      ? { observedOverflowTokens: params.observedOverflowTokens }
      : {}),
    ...(typeof params.compactionTokens === "number"
      ? { compactionTokens: params.compactionTokens }
      : {}),
  })!;
}

/**
 * Infer a checkpoint trigger snapshot from compact() params when the caller
 * did not supply an explicit gate evaluation record.
 */
export function resolveCompactionCheckpointTriggerFromParams(params: {
  checkpointTrigger?: SessionCompactionCheckpointTrigger;
  trigger?: "budget" | "overflow" | "manual" | "timeout_recovery";
  preflightCompactionTrigger?: "tokens" | "transcript_bytes";
  currentTokenCount?: number;
  contextTokenBudget?: number;
  attempt?: number;
}): SessionCompactionCheckpointTrigger | undefined {
  const explicit = normalizeSessionCompactionCheckpointTrigger(params.checkpointTrigger);
  if (explicit) {
    return explicit;
  }

  if (params.trigger === "timeout_recovery") {
    return normalizeSessionCompactionCheckpointTrigger({
      path: "timeout_retry",
      trigger: "budget",
      ...(typeof params.currentTokenCount === "number"
        ? { promptTokens: params.currentTokenCount }
        : {}),
      ...(typeof params.contextTokenBudget === "number"
        ? {
            contextWindowTokens: params.contextTokenBudget,
            thresholdTokens: Math.floor(params.contextTokenBudget * 0.65),
          }
        : {}),
      ...(typeof params.attempt === "number" ? { attempt: params.attempt } : {}),
    });
  }

  if (params.trigger === "overflow") {
    return normalizeSessionCompactionCheckpointTrigger({
      path: "overflow_retry",
      trigger: "overflow",
      ...(typeof params.currentTokenCount === "number"
        ? { compactionTokens: params.currentTokenCount }
        : {}),
      ...(typeof params.contextTokenBudget === "number"
        ? { contextWindowTokens: params.contextTokenBudget }
        : {}),
      ...(typeof params.attempt === "number" ? { attempt: params.attempt } : {}),
    });
  }

  if (params.preflightCompactionTrigger === "transcript_bytes") {
    return normalizeSessionCompactionCheckpointTrigger({
      path: "preflight_transcript_bytes",
      trigger: "transcript_bytes",
      ...(typeof params.currentTokenCount === "number"
        ? { projectedTokens: params.currentTokenCount }
        : {}),
      ...(typeof params.contextTokenBudget === "number"
        ? { contextWindowTokens: params.contextTokenBudget }
        : {}),
    });
  }

  if (params.preflightCompactionTrigger === "tokens") {
    return normalizeSessionCompactionCheckpointTrigger({
      path: "preflight_tokens",
      trigger: "tokens",
      ...(typeof params.currentTokenCount === "number"
        ? { projectedTokens: params.currentTokenCount }
        : {}),
      ...(typeof params.contextTokenBudget === "number"
        ? { contextWindowTokens: params.contextTokenBudget }
        : {}),
    });
  }

  if (params.trigger === "manual") {
    return normalizeSessionCompactionCheckpointTrigger({
      path: "manual",
      trigger: "manual",
      ...(typeof params.contextTokenBudget === "number"
        ? { contextWindowTokens: params.contextTokenBudget }
        : {}),
    });
  }

  if (params.trigger === "budget") {
    return normalizeSessionCompactionCheckpointTrigger({
      path: "auto_threshold",
      trigger: "budget",
      ...(typeof params.currentTokenCount === "number"
        ? { projectedTokens: params.currentTokenCount }
        : {}),
      ...(typeof params.contextTokenBudget === "number"
        ? { contextWindowTokens: params.contextTokenBudget }
        : {}),
    });
  }

  return undefined;
}
