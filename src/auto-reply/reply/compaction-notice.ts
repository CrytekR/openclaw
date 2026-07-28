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
    const projected = formatCompactTokenCount(details.projectedTokens);
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
  const projectedTokens =
    typeof data.projectedTokens === "number" && Number.isFinite(data.projectedTokens)
      ? data.projectedTokens
      : undefined;
  const threshold =
    typeof data.threshold === "number" && Number.isFinite(data.threshold)
      ? data.threshold
      : undefined;
  const activeTranscriptBytes =
    typeof data.activeTranscriptBytes === "number" && Number.isFinite(data.activeTranscriptBytes)
      ? data.activeTranscriptBytes
      : undefined;
  const maxActiveTranscriptBytes =
    typeof data.maxActiveTranscriptBytes === "number" &&
    Number.isFinite(data.maxActiveTranscriptBytes)
      ? data.maxActiveTranscriptBytes
      : undefined;
  return {
    ...(trigger ? { trigger } : {}),
    ...(reason ? { reason } : {}),
    ...(projectedTokens !== undefined ? { projectedTokens } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(activeTranscriptBytes !== undefined ? { activeTranscriptBytes } : {}),
    ...(maxActiveTranscriptBytes !== undefined ? { maxActiveTranscriptBytes } : {}),
  };
}
