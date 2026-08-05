/**
 * Builds the operator-facing compaction checkpoint `reason` string.
 * Includes the concrete entry-path label plus available gate calc numbers.
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

/** Append gate evaluation numbers so operators can read them from `reason`. */
export function appendCompactionCheckpointReasonGateCalc(
  parts: string[],
  trigger: SessionCompactionCheckpointTrigger | undefined,
): void {
  if (!trigger) {
    return;
  }
  pushFiniteIntField(parts, "projectedTokens", trigger.projectedTokens);
  pushFiniteIntField(parts, "thresholdTokens", trigger.thresholdTokens);
  pushFiniteIntField(parts, "contextWindowTokens", trigger.contextWindowTokens);
  pushFiniteIntField(parts, "activeTranscriptBytes", trigger.activeTranscriptBytes);
  pushFiniteIntField(parts, "maxActiveTranscriptBytes", trigger.maxActiveTranscriptBytes);
  pushFiniteIntField(parts, "estimatedPromptTokens", trigger.estimatedPromptTokens);
  pushFiniteIntField(parts, "promptBudgetBeforeReserve", trigger.promptBudgetBeforeReserve);
  pushFiniteIntField(parts, "overflowTokens", trigger.overflowTokens);
  pushFiniteIntField(parts, "attempt", trigger.attempt);
  if (trigger.overflowRoute) {
    parts.push(`overflowRoute=${trigger.overflowRoute}`);
  }
  if (trigger.overflowSource) {
    parts.push(`overflowSource=${trigger.overflowSource}`);
  }
  const breakdown = trigger.projectedBreakdown;
  if (breakdown) {
    parts.push(`breakdownSource=${breakdown.source}`);
    pushFiniteIntField(parts, "baseTokens", breakdown.baseTokens);
    pushFiniteIntField(parts, "lastOutputTokens", breakdown.lastOutputTokens);
    pushFiniteIntField(parts, "promptEstimateTokens", breakdown.promptEstimateTokens);
    if (breakdown.recountMethod) {
      parts.push(`recountMethod=${breakdown.recountMethod}`);
    }
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
  appendCompactionCheckpointReasonGateCalc(parts, params.checkpointTrigger);
  return parts.join(" ");
}
