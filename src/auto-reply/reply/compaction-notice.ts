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
 * - transcript_usage: transcript usage/estimate base + last output + prompt estimate
 * - fresh_persisted: session totalTokensFresh base + last output + prompt estimate
 * - persisted: raw persisted totalTokens floor (no additive terms)
 */
export type ProjectedTokenSource = "transcript_usage" | "fresh_persisted" | "persisted";

/** Additive terms that produced the winning projected-token count. */
export type ProjectedTokenBreakdown = {
  source: ProjectedTokenSource;
  /** Prompt/context base before adding the last completion and current prompt. */
  baseTokens: number;
  /** Previous assistant completion tokens, when used in the projection. */
  lastOutputTokens?: number;
  /** Estimated tokens for the current user prompt, when used in the projection. */
  promptEstimateTokens?: number;
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
      return "transcript";
    case "fresh_persisted":
      return "fresh session";
    case "persisted":
      return "persisted";
  }
}

function readNonNegativeTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
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
}): { projectedTokens: number; breakdown: ProjectedTokenBreakdown } | undefined {
  const transcriptPromptTokens = readNonNegativeTokenCount(params.transcriptPromptTokens);
  const transcriptOutputTokens = readNonNegativeTokenCount(params.transcriptOutputTokens);
  const freshPersistedTokens = readNonNegativeTokenCount(params.freshPersistedTokens);
  const persistedPromptTokens = readNonNegativeTokenCount(params.persistedPromptTokens);
  const promptEstimateTokens = readNonNegativeTokenCount(params.promptEstimateTokens);

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
  const base = formatCompactTokenCount(breakdown.baseTokens);
  const lastOutput =
    typeof breakdown.lastOutputTokens === "number" && breakdown.lastOutputTokens > 0
      ? formatCompactTokenCount(breakdown.lastOutputTokens)
      : undefined;
  const promptEstimate =
    typeof breakdown.promptEstimateTokens === "number" && breakdown.promptEstimateTokens > 0
      ? formatCompactTokenCount(breakdown.promptEstimateTokens)
      : undefined;
  if (!lastOutput && !promptEstimate) {
    return `${projected} (${source} ${base})`;
  }
  const parts = [`${base} base`];
  if (lastOutput) {
    parts.push(`${lastOutput} last-out`);
  }
  if (promptEstimate) {
    parts.push(`${promptEstimate} prompt`);
  }
  return `${projected} = ${parts.join(" + ")} [${source}]`;
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
  return {
    source,
    baseTokens,
    ...(lastOutputTokens !== undefined && lastOutputTokens > 0 ? { lastOutputTokens } : {}),
    ...(promptEstimateTokens !== undefined && promptEstimateTokens > 0
      ? { promptEstimateTokens }
      : {}),
  };
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
