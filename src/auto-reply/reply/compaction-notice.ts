// Shared compaction formatting and user-facing notice payload helpers.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../types.js";

export type CompactionNoticePhase =
  | "start"
  | "end"
  | "incomplete"
  | "skipped"
  | "memory_flush_degraded";

/**
 * Which candidate won the preflight projected-token max().
 * - transcript_usage: recount from the session transcript (may differ from the UI meter)
 * - fresh_persisted: same fresh session totalTokens snapshot as the UI context meter
 * - persisted: saved session totalTokens used as a floor without reply/prompt additives
 */
export type ProjectedTokenSource = "transcript_usage" | "fresh_persisted" | "persisted";

/**
 * Which transcript recount algorithm produced the chat-log base.
 * - last_model_usage: latest provider usage prompt tokens
 * - model_usage_plus_unread_tail: usage prompt + unread trailing bytes/4
 * - recent_messages_estimate: estimateMessagesTokens over recent transcript messages
 * - chat_log_file_size: ceil(transcript bytes / 4)
 */
export type TranscriptRecountMethod =
  | "last_model_usage"
  | "model_usage_plus_unread_tail"
  | "recent_messages_estimate"
  | "chat_log_file_size";

/** Additive terms that produced the winning projected-token count. */
export type ProjectedTokenBreakdown = {
  source: ProjectedTokenSource;
  /** Prompt/context base before adding the last completion and current prompt. */
  baseTokens: number;
  /** Previous assistant completion tokens, when used in the projection. */
  lastOutputTokens?: number;
  /** Estimated tokens for the current user prompt, when used in the projection. */
  promptEstimateTokens?: number;
  /** Specific chat-log recount algorithm when source is transcript_usage. */
  recountMethod?: TranscriptRecountMethod;
};

/** Structured compaction trigger details for notices and Control UI agent events. */
export type CompactionTriggerDetails = {
  /**
   * Specific preflight / recovery trigger when known.
   * - tokens: projected context crossed the soft token budget
   * - transcript_bytes: active transcript file exceeded maxActiveTranscriptBytes
   * - overflow: provider rejected the prompt as context overflow
   * - manual: user/API requested compaction
   * - threshold: session auto-compaction at turn-end threshold (generic)
   * - budget: generic budget compaction without a more specific trigger
   */
  trigger?: "tokens" | "transcript_bytes" | "overflow" | "manual" | "threshold" | "budget";
  /** Session-level reason used by AgentSession compaction events. */
  reason?: "manual" | "threshold" | "overflow";
  /** Next-turn projected prompt tokens used for the token-budget gate. */
  projectedTokens?: number;
  /** How projectedTokens was computed when the token-budget gate fired. */
  projectedBreakdown?: ProjectedTokenBreakdown;
  /** Token-budget compaction threshold (contextWindow - reserve - soft). */
  threshold?: number;
  /** Active transcript byte size when the size gate fired. */
  activeTranscriptBytes?: number;
  /** Configured max active transcript bytes. */
  maxActiveTranscriptBytes?: number;
};

const COMPACTION_NOTICE_TEXT: Record<CompactionNoticePhase, string> = {
  start: "🧹 Compacting context...",
  end: "🧹 Compaction complete",
  incomplete: "🧹 Compaction incomplete",
  skipped: "🧹 Compaction not needed",
  memory_flush_degraded: "⚠️ Memory maintenance temporarily failed; continuing your reply.",
};

export function formatCompactionModelRef(provider?: string, model?: string): string {
  const normalizedProvider = normalizeOptionalString(provider);
  const normalizedModel = normalizeOptionalString(model);
  if (normalizedProvider && normalizedModel) {
    return `${sanitizeForLog(normalizedProvider)}/${sanitizeForLog(normalizedModel)}`;
  }
  if (normalizedProvider) {
    return sanitizeForLog(normalizedProvider);
  }
  if (normalizedModel) {
    return sanitizeForLog(normalizedModel);
  }
  return "unknown model";
}

export function shouldNotifyUserAboutCompaction(cfg?: OpenClawConfig): boolean {
  return cfg?.agents?.defaults?.compaction?.notifyUser === true;
}

function formatCompactTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "0";
  }
  const rounded = Math.round(value);
  if (rounded >= 1_000_000) {
    const millions = rounded / 1_000_000;
    return `${millions >= 10 || Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}m`;
  }
  if (rounded >= 1_000) {
    const thousands = rounded / 1_000;
    return `${thousands >= 10 || Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
  }
  return String(rounded);
}

function formatCompactByteCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "0B";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}MB`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}KB`;
  }
  return `${Math.floor(value)}B`;
}

function resolveCompactionTriggerLabel(details?: CompactionTriggerDetails): string | undefined {
  const trigger = details?.trigger ?? details?.reason;
  switch (trigger) {
    case "tokens":
      return "token budget";
    case "transcript_bytes":
      return "transcript size limit";
    case "overflow":
      return "context overflow";
    case "manual":
      return "manual";
    case "threshold":
      return "context threshold";
    case "budget":
      return "context budget";
    default:
      return undefined;
  }
}

function resolveProjectedTokenSourceLabel(source: ProjectedTokenSource): string {
  switch (source) {
    case "transcript_usage":
      // Recomputed from the session transcript; may differ from the UI meter.
      return "chat-log recount";
    case "fresh_persisted":
      // Same persisted prompt/context snapshot the Control UI context meter shows.
      return "context meter";
    case "persisted":
      // Saved session total used as a floor without adding reply/prompt estimates.
      return "saved context floor";
  }
}

function resolveTranscriptRecountMethodLabel(method: TranscriptRecountMethod): string {
  switch (method) {
    case "last_model_usage":
      return "last model usage";
    case "model_usage_plus_unread_tail":
      return "model usage + unread tail";
    case "recent_messages_estimate":
      return "recent messages estimate";
    case "chat_log_file_size":
      return "chat-log size ÷ 4";
  }
}

function readNonNegativeTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function readTranscriptRecountMethod(value: unknown): TranscriptRecountMethod | undefined {
  return value === "last_model_usage" ||
    value === "model_usage_plus_unread_tail" ||
    value === "recent_messages_estimate" ||
    value === "chat_log_file_size"
    ? value
    : undefined;
}

/** Additive projection used by preflight token-budget gating. */
export function resolveEffectivePromptTokens(
  basePromptTokens?: number,
  lastOutputTokens?: number,
  promptTokenEstimate?: number,
): number {
  const base = Math.max(0, basePromptTokens ?? 0);
  const output = Math.max(0, lastOutputTokens ?? 0);
  const estimate = Math.max(0, promptTokenEstimate ?? 0);
  return base + output + estimate;
}

/**
 * Select the winning projected-token candidate for preflight compaction.
 * Mirrors: max(usageProjected, freshProjected, persistedFloor).
 */
export function resolveProjectedTokenProjection(params: {
  transcriptPromptTokens?: number;
  transcriptOutputTokens?: number;
  freshPersistedTokens?: number;
  persistedPromptTokens?: number;
  promptEstimateTokens?: number;
  transcriptRecountMethod?: TranscriptRecountMethod;
}): { projectedTokens: number; breakdown: ProjectedTokenBreakdown } | undefined {
  const transcriptPromptTokens = readNonNegativeTokenCount(params.transcriptPromptTokens);
  const transcriptOutputTokens = readNonNegativeTokenCount(params.transcriptOutputTokens);
  const freshPersistedTokens = readNonNegativeTokenCount(params.freshPersistedTokens);
  const persistedPromptTokens = readNonNegativeTokenCount(params.persistedPromptTokens);
  const promptEstimateTokens = readNonNegativeTokenCount(params.promptEstimateTokens);
  const transcriptRecountMethod = readTranscriptRecountMethod(params.transcriptRecountMethod);

  const usageProjected =
    transcriptPromptTokens !== undefined
      ? resolveEffectivePromptTokens(
          transcriptPromptTokens,
          transcriptOutputTokens,
          promptEstimateTokens,
        )
      : undefined;
  const freshProjected =
    freshPersistedTokens !== undefined
      ? resolveEffectivePromptTokens(
          freshPersistedTokens,
          transcriptOutputTokens,
          promptEstimateTokens,
        )
      : undefined;
  const persistedFloor =
    persistedPromptTokens !== undefined && persistedPromptTokens > 0
      ? persistedPromptTokens
      : undefined;

  const projectedTokens = Math.max(usageProjected ?? 0, freshProjected ?? 0, persistedFloor ?? 0);
  if (!Number.isFinite(projectedTokens) || projectedTokens <= 0) {
    return undefined;
  }

  // Prefer additive sources when they tie the max, so the UI can show the sum.
  if (usageProjected === projectedTokens && transcriptPromptTokens !== undefined) {
    return {
      projectedTokens,
      breakdown: {
        source: "transcript_usage",
        baseTokens: transcriptPromptTokens,
        ...(transcriptOutputTokens !== undefined && transcriptOutputTokens > 0
          ? { lastOutputTokens: transcriptOutputTokens }
          : {}),
        ...(promptEstimateTokens !== undefined && promptEstimateTokens > 0
          ? { promptEstimateTokens }
          : {}),
        ...(transcriptRecountMethod ? { recountMethod: transcriptRecountMethod } : {}),
      },
    };
  }
  if (freshProjected === projectedTokens && freshPersistedTokens !== undefined) {
    return {
      projectedTokens,
      breakdown: {
        source: "fresh_persisted",
        baseTokens: freshPersistedTokens,
        ...(transcriptOutputTokens !== undefined && transcriptOutputTokens > 0
          ? { lastOutputTokens: transcriptOutputTokens }
          : {}),
        ...(promptEstimateTokens !== undefined && promptEstimateTokens > 0
          ? { promptEstimateTokens }
          : {}),
      },
    };
  }
  return {
    projectedTokens,
    breakdown: {
      source: "persisted",
      baseTokens: persistedPromptTokens ?? projectedTokens,
    },
  };
}

/** Formats the winning projected-token expression for notices and UI. */
export function formatProjectedTokenExpression(params: {
  projectedTokens: number;
  breakdown?: ProjectedTokenBreakdown;
}): string {
  const projected = formatCompactTokenCount(params.projectedTokens);
  const breakdown = params.breakdown;
  if (!breakdown) {
    return projected;
  }
  const source = resolveProjectedTokenSourceLabel(breakdown.source);
  const recountMethod =
    breakdown.source === "transcript_usage" && breakdown.recountMethod
      ? resolveTranscriptRecountMethodLabel(breakdown.recountMethod)
      : undefined;
  const sourceLabel = recountMethod ? `${source} via ${recountMethod}` : source;
  const base = formatCompactTokenCount(breakdown.baseTokens);
  const lastOutput =
    typeof breakdown.lastOutputTokens === "number" && breakdown.lastOutputTokens > 0
      ? formatCompactTokenCount(breakdown.lastOutputTokens)
      : undefined;
  const promptEstimate =
    typeof breakdown.promptEstimateTokens === "number" && breakdown.promptEstimateTokens > 0
      ? formatCompactTokenCount(breakdown.promptEstimateTokens)
      : undefined;
  // Spell out what each term means so the indicator is readable without
  // knowing internal source ids (fresh_persisted / transcript_usage / persisted).
  const baseTerm = `${base} ${sourceLabel}`;
  if (!lastOutput && !promptEstimate) {
    return `${projected} (${baseTerm})`;
  }
  const parts = [baseTerm];
  if (lastOutput) {
    parts.push(`${lastOutput} previous reply`);
  }
  if (promptEstimate) {
    parts.push(`${promptEstimate} this message`);
  }
  return `${projected} = ${parts.join(" + ")}`;
}

function readProjectedTokenBreakdown(value: unknown): ProjectedTokenBreakdown | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const sourceRaw = typeof record.source === "string" ? record.source : undefined;
  const source =
    sourceRaw === "transcript_usage" || sourceRaw === "fresh_persisted" || sourceRaw === "persisted"
      ? sourceRaw
      : undefined;
  const baseTokens = readNonNegativeTokenCount(record.baseTokens);
  if (!source || baseTokens === undefined) {
    return undefined;
  }
  const lastOutputTokens = readNonNegativeTokenCount(record.lastOutputTokens);
  const promptEstimateTokens = readNonNegativeTokenCount(record.promptEstimateTokens);
  const recountMethod = readTranscriptRecountMethod(record.recountMethod);
  return {
    source,
    baseTokens,
    ...(lastOutputTokens !== undefined && lastOutputTokens > 0 ? { lastOutputTokens } : {}),
    ...(promptEstimateTokens !== undefined && promptEstimateTokens > 0
      ? { promptEstimateTokens }
      : {}),
    ...(source === "transcript_usage" && recountMethod ? { recountMethod } : {}),
  };
}

/** Merge a durable UI reason into compaction entry details without dropping harness fields. */
export function mergeCompactionReasonTextIntoDetails(
  details: unknown,
  reasonText: string,
): unknown {
  const trimmed = reasonText.trim();
  if (!trimmed) {
    return details;
  }
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return { ...(details as Record<string, unknown>), reasonText: trimmed };
  }
  if (details === undefined) {
    return { reasonText: trimmed };
  }
  return { value: details, reasonText: trimmed };
}

/** Read a previously persisted compaction trigger reason from entry details. */
export function readCompactionReasonTextFromDetails(details: unknown): string | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const reasonText = (details as Record<string, unknown>).reasonText;
  if (typeof reasonText !== "string") {
    return undefined;
  }
  const trimmed = reasonText.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Prefer an explicit reasonText; otherwise derive a short label from the compact
 * trigger fields that every compaction entry point already carries.
 */
export function resolveCompactionPersistReasonText(params: {
  reasonText?: string;
  trigger?: "budget" | "overflow" | "manual";
  preflightCompactionTrigger?: "tokens" | "transcript_bytes";
}): string | undefined {
  const explicit = params.reasonText?.trim();
  if (explicit) {
    return explicit;
  }
  return formatCompactionTriggerReason({
    trigger:
      params.preflightCompactionTrigger ??
      (params.trigger === "overflow"
        ? "overflow"
        : params.trigger === "manual"
          ? "manual"
          : params.trigger === "budget"
            ? "budget"
            : undefined),
  });
}

/** Builds a short human-readable reason suffix for compaction notices and UI. */
export function formatCompactionTriggerReason(
  details?: CompactionTriggerDetails,
): string | undefined {
  const label = resolveCompactionTriggerLabel(details);
  if (!label) {
    return undefined;
  }
  if (
    (details?.trigger === "tokens" || (!details?.trigger && details?.reason === "threshold")) &&
    typeof details.projectedTokens === "number" &&
    Number.isFinite(details.projectedTokens) &&
    details.projectedTokens > 0
  ) {
    const projected = formatProjectedTokenExpression({
      projectedTokens: details.projectedTokens,
      breakdown: details.projectedBreakdown,
    });
    if (
      typeof details.threshold === "number" &&
      Number.isFinite(details.threshold) &&
      details.threshold > 0
    ) {
      return `${label}: projected ${projected} ≥ ${formatCompactTokenCount(details.threshold)}`;
    }
    return `${label}: projected ${projected}`;
  }
  if (
    details?.trigger === "transcript_bytes" &&
    typeof details.activeTranscriptBytes === "number" &&
    Number.isFinite(details.activeTranscriptBytes) &&
    details.activeTranscriptBytes > 0
  ) {
    const usedBytes = formatCompactByteCount(details.activeTranscriptBytes);
    if (
      typeof details.maxActiveTranscriptBytes === "number" &&
      Number.isFinite(details.maxActiveTranscriptBytes) &&
      details.maxActiveTranscriptBytes > 0
    ) {
      return `${label}: ${usedBytes} ≥ ${formatCompactByteCount(details.maxActiveTranscriptBytes)}`;
    }
    return `${label}: ${usedBytes}`;
  }
  return label;
}

export function formatCompactionNoticeText(
  phase: CompactionNoticePhase,
  details?: CompactionTriggerDetails,
): string {
  const base = COMPACTION_NOTICE_TEXT[phase];
  if (phase !== "start" && phase !== "end" && phase !== "incomplete") {
    return base;
  }
  const reason = formatCompactionTriggerReason(details);
  if (!reason) {
    return base;
  }
  if (phase === "start") {
    return `🧹 Compacting context (${reason})...`;
  }
  if (phase === "end") {
    return `🧹 Compaction complete (${reason})`;
  }
  return `🧹 Compaction incomplete (${reason})`;
}

/** Build agent-event `data` fields for Control UI compaction indicators. */
export function buildCompactionAgentEventData(
  phase: "start" | "end",
  details?: CompactionTriggerDetails,
  extras?: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    phase,
    ...extras,
  };
  if (details?.trigger) {
    data.trigger = details.trigger;
  }
  if (details?.reason) {
    data.reason = details.reason;
  }
  if (
    typeof details?.projectedTokens === "number" &&
    Number.isFinite(details.projectedTokens) &&
    details.projectedTokens > 0
  ) {
    data.projectedTokens = Math.floor(details.projectedTokens);
  }
  if (details?.projectedBreakdown) {
    data.projectedBreakdown = {
      source: details.projectedBreakdown.source,
      baseTokens: Math.floor(details.projectedBreakdown.baseTokens),
      ...(typeof details.projectedBreakdown.lastOutputTokens === "number"
        ? { lastOutputTokens: Math.floor(details.projectedBreakdown.lastOutputTokens) }
        : {}),
      ...(typeof details.projectedBreakdown.promptEstimateTokens === "number"
        ? {
            promptEstimateTokens: Math.floor(details.projectedBreakdown.promptEstimateTokens),
          }
        : {}),
      ...(details.projectedBreakdown.source === "transcript_usage" &&
      details.projectedBreakdown.recountMethod
        ? { recountMethod: details.projectedBreakdown.recountMethod }
        : {}),
    };
  }
  if (
    typeof details?.threshold === "number" &&
    Number.isFinite(details.threshold) &&
    details.threshold > 0
  ) {
    data.threshold = Math.floor(details.threshold);
  }
  if (
    typeof details?.activeTranscriptBytes === "number" &&
    Number.isFinite(details.activeTranscriptBytes) &&
    details.activeTranscriptBytes >= 0
  ) {
    data.activeTranscriptBytes = Math.floor(details.activeTranscriptBytes);
  }
  if (
    typeof details?.maxActiveTranscriptBytes === "number" &&
    Number.isFinite(details.maxActiveTranscriptBytes) &&
    details.maxActiveTranscriptBytes > 0
  ) {
    data.maxActiveTranscriptBytes = Math.floor(details.maxActiveTranscriptBytes);
  }
  const reasonText = formatCompactionTriggerReason(details);
  if (reasonText) {
    data.reasonText = reasonText;
  }
  return data;
}

export function createCompactionNoticePayload(params: {
  phase: CompactionNoticePhase;
  details?: CompactionTriggerDetails;
  currentMessageId?: string;
  applyReplyToMode?: (payload: ReplyPayload) => ReplyPayload;
}): ReplyPayload {
  const payload: ReplyPayload = {
    text: formatCompactionNoticeText(params.phase, params.details),
    ...(params.currentMessageId ? { replyToId: params.currentMessageId } : {}),
    replyToCurrent: true,
    isCompactionNotice: true,
  };
  return params.applyReplyToMode ? params.applyReplyToMode(payload) : payload;
}

export function readCompactionHookMessages(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function createCompactionHookNoticePayload(params: {
  messages: string[];
  currentMessageId?: string;
  applyReplyToMode?: (payload: ReplyPayload) => ReplyPayload;
}): ReplyPayload | undefined {
  if (params.messages.length === 0) {
    return undefined;
  }
  const payload: ReplyPayload = {
    text: params.messages.join("\n\n"),
    ...(params.currentMessageId ? { replyToId: params.currentMessageId } : {}),
    replyToCurrent: true,
    isCompactionNotice: true,
  };
  return params.applyReplyToMode ? params.applyReplyToMode(payload) : payload;
}

/** Parse structured trigger details from a compaction agent-event payload. */
export function readCompactionTriggerDetails(
  data: Record<string, unknown>,
): CompactionTriggerDetails {
  const triggerRaw = typeof data.trigger === "string" ? data.trigger : undefined;
  const reasonRaw = typeof data.reason === "string" ? data.reason : undefined;
  const trigger =
    triggerRaw === "tokens" ||
    triggerRaw === "transcript_bytes" ||
    triggerRaw === "overflow" ||
    triggerRaw === "manual" ||
    triggerRaw === "threshold" ||
    triggerRaw === "budget"
      ? triggerRaw
      : undefined;
  const reason =
    reasonRaw === "manual" || reasonRaw === "threshold" || reasonRaw === "overflow"
      ? reasonRaw
      : undefined;
  const projectedTokens = readNonNegativeTokenCount(data.projectedTokens);
  const projectedBreakdown = readProjectedTokenBreakdown(data.projectedBreakdown);
  const threshold = readNonNegativeTokenCount(data.threshold);
  const activeTranscriptBytes = readNonNegativeTokenCount(data.activeTranscriptBytes);
  const maxActiveTranscriptBytes = readNonNegativeTokenCount(data.maxActiveTranscriptBytes);
  return {
    ...(trigger ? { trigger } : {}),
    ...(reason ? { reason } : {}),
    ...(projectedTokens !== undefined && projectedTokens > 0 ? { projectedTokens } : {}),
    ...(projectedBreakdown ? { projectedBreakdown } : {}),
    ...(threshold !== undefined && threshold > 0 ? { threshold } : {}),
    ...(activeTranscriptBytes !== undefined ? { activeTranscriptBytes } : {}),
    ...(maxActiveTranscriptBytes !== undefined && maxActiveTranscriptBytes > 0
      ? { maxActiveTranscriptBytes }
      : {}),
  };
}
