/**
 * Builds the operator-facing compaction checkpoint `reason` string.
 * Includes the concrete entry-path label plus path-specific gate calc numbers.
 */
import type {
  SessionCompactionCheckpointReason,
  SessionCompactionCheckpointTrigger,
  SessionCompactionCheckpointTriggerPath,
} from "../config/sessions/types.js";

const CHECKPOINT_REASON_PATH_LABELS = {
  preflight_tokens: "Preflight tokens",
  preflight_transcript_bytes: "Preflight transcript bytes",
  pre_prompt_precheck: "Pre-prompt precheck",
  char_overflow_guard: "Char overflow guard",
  midturn_precheck: "Mid-turn precheck",
  overflow_retry: "Overflow retry",
  timeout_retry: "Timeout retry",
  auto_threshold: "Auto threshold",
  manual: "Manual",
} as const satisfies Record<SessionCompactionCheckpointTriggerPath, string>;

function resolveCheckpointReasonPath(params: {
  trigger?: "budget" | "overflow" | "manual" | "timeout_recovery";
  timedOut?: boolean;
  checkpointTrigger?: SessionCompactionCheckpointTrigger;
}): SessionCompactionCheckpointTriggerPath {
  const path = params.checkpointTrigger?.path;
  if (path && path in CHECKPOINT_REASON_PATH_LABELS) {
    return path;
  }
  if (params.trigger === "manual") {
    return "manual";
  }
  if (params.timedOut || params.trigger === "timeout_recovery") {
    return "timeout_retry";
  }
  if (params.trigger === "overflow") {
    return "overflow_retry";
  }
  return "auto_threshold";
}

function pushFiniteIntField(parts: string[], key: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return;
  }
  parts.push(`${key}=${Math.floor(value)}`);
}

function appendPreflightTokenGateCalc(
  parts: string[],
  trigger: SessionCompactionCheckpointTrigger,
): void {
  pushFiniteIntField(parts, "projectedTokens", trigger.projectedTokens);
  pushFiniteIntField(parts, "thresholdTokens", trigger.thresholdTokens);
  pushFiniteIntField(parts, "contextWindowTokens", trigger.contextWindowTokens);
  const breakdown = trigger.projectedBreakdown;
  if (!breakdown) {
    return;
  }
  parts.push(`breakdownSource=${breakdown.source}`);
  pushFiniteIntField(parts, "baseTokens", breakdown.baseTokens);
  pushFiniteIntField(parts, "lastOutputTokens", breakdown.lastOutputTokens);
  pushFiniteIntField(parts, "promptEstimateTokens", breakdown.promptEstimateTokens);
  if (breakdown.recountMethod) {
    parts.push(`recountMethod=${breakdown.recountMethod}`);
  }
}

function appendPreflightTranscriptBytesGateCalc(
  parts: string[],
  trigger: SessionCompactionCheckpointTrigger,
): void {
  pushFiniteIntField(parts, "activeTranscriptBytes", trigger.activeTranscriptBytes);
  pushFiniteIntField(parts, "maxActiveTranscriptBytes", trigger.maxActiveTranscriptBytes);
  pushFiniteIntField(parts, "contextWindowTokens", trigger.contextWindowTokens);
}

function appendPrecheckGateCalc(
  parts: string[],
  trigger: SessionCompactionCheckpointTrigger,
): void {
  pushFiniteIntField(parts, "estimatedPromptTokens", trigger.estimatedPromptTokens);
  pushFiniteIntField(parts, "promptBudgetBeforeReserve", trigger.promptBudgetBeforeReserve);
  pushFiniteIntField(parts, "overflowTokens", trigger.overflowTokens);
  pushFiniteIntField(parts, "contextWindowTokens", trigger.contextWindowTokens);
  pushFiniteIntField(parts, "attempt", trigger.attempt);
  if (trigger.overflowRoute) {
    parts.push(`overflowRoute=${trigger.overflowRoute}`);
  }
  if (trigger.overflowSource) {
    parts.push(`overflowSource=${trigger.overflowSource}`);
  }
}

function appendCharOverflowGuardGateCalc(
  parts: string[],
  trigger: SessionCompactionCheckpointTrigger,
): void {
  pushFiniteIntField(parts, "estimatedContextChars", trigger.estimatedContextChars);
  pushFiniteIntField(parts, "maxContextChars", trigger.maxContextChars);
  pushFiniteIntField(parts, "contextWindowTokens", trigger.contextWindowTokens);
  pushFiniteIntField(parts, "attempt", trigger.attempt);
  if (trigger.overflowSource) {
    parts.push(`overflowSource=${trigger.overflowSource}`);
  }
}

function appendOverflowErrorText(
  parts: string[],
  trigger: SessionCompactionCheckpointTrigger,
): void {
  if (!trigger.overflowErrorText) {
    return;
  }
  // JSON-quote so spaces/punctuation in provider error text stay one field.
  parts.push(`overflowError=${JSON.stringify(trigger.overflowErrorText)}`);
}

function appendOverflowRetryGateCalc(
  parts: string[],
  trigger: SessionCompactionCheckpointTrigger,
): void {
  pushFiniteIntField(parts, "observedOverflowTokens", trigger.observedOverflowTokens);
  pushFiniteIntField(parts, "compactionTokens", trigger.compactionTokens);
  pushFiniteIntField(parts, "contextWindowTokens", trigger.contextWindowTokens);
  pushFiniteIntField(parts, "attempt", trigger.attempt);
  if (trigger.overflowSource) {
    parts.push(`overflowSource=${trigger.overflowSource}`);
  }
  appendOverflowErrorText(parts, trigger);
}

function appendTimeoutRetryGateCalc(
  parts: string[],
  trigger: SessionCompactionCheckpointTrigger,
): void {
  pushFiniteIntField(parts, "promptTokens", trigger.promptTokens);
  pushFiniteIntField(parts, "thresholdTokens", trigger.thresholdTokens);
  pushFiniteIntField(parts, "contextWindowTokens", trigger.contextWindowTokens);
  pushFiniteIntField(parts, "attempt", trigger.attempt);
}

function appendManualOrAutoGateCalc(
  parts: string[],
  trigger: SessionCompactionCheckpointTrigger,
): void {
  pushFiniteIntField(parts, "contextWindowTokens", trigger.contextWindowTokens);
  pushFiniteIntField(parts, "projectedTokens", trigger.projectedTokens);
  pushFiniteIntField(parts, "thresholdTokens", trigger.thresholdTokens);
}

/** Append path-specific gate evaluation numbers onto the reason string. */
export function appendCompactionCheckpointReasonGateCalc(
  parts: string[],
  path: SessionCompactionCheckpointTriggerPath,
  trigger: SessionCompactionCheckpointTrigger | undefined,
): void {
  if (!trigger) {
    return;
  }
  switch (path) {
    case "preflight_tokens":
      appendPreflightTokenGateCalc(parts, trigger);
      return;
    case "preflight_transcript_bytes":
      appendPreflightTranscriptBytesGateCalc(parts, trigger);
      return;
    case "pre_prompt_precheck":
    case "midturn_precheck":
      appendPrecheckGateCalc(parts, trigger);
      return;
    case "char_overflow_guard":
      appendCharOverflowGuardGateCalc(parts, trigger);
      return;
    case "overflow_retry":
      appendOverflowRetryGateCalc(parts, trigger);
      return;
    case "timeout_retry":
      appendTimeoutRetryGateCalc(parts, trigger);
      return;
    case "manual":
    case "auto_threshold":
      appendManualOrAutoGateCalc(parts, trigger);
      return;
  }
}

/** Resolve the stored checkpoint reason from compaction trigger state. */
export function resolveSessionCompactionCheckpointReason(params: {
  trigger?: "budget" | "overflow" | "manual" | "timeout_recovery";
  timedOut?: boolean;
  checkpointTrigger?: SessionCompactionCheckpointTrigger;
}): SessionCompactionCheckpointReason {
  const path = resolveCheckpointReasonPath(params);
  const parts = [CHECKPOINT_REASON_PATH_LABELS[path]];
  appendCompactionCheckpointReasonGateCalc(parts, path, params.checkpointTrigger);
  return parts.join(" ");
}
