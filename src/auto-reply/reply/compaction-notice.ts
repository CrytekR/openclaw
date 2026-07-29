// Shared compaction formatting and user-facing notice payload helpers.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatTokenCount } from "../../utils/token-format.js";
import type { ReplyPayload } from "../types.js";

export type CompactionNoticePhase = "start" | "end" | "incomplete" | "skipped";

/**
 * Structured compaction trigger details for notices and Control UI agent events.
 * Adapted for 2026.6.11 trigger surfaces:
 * - preflight: tokens | transcript_bytes (compact API still uses trigger "budget")
 * - session auto: threshold | overflow | manual
 */
export type CompactionTriggerDetails = {
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
};

function formatCompactTokenCount(value: number): string {
  return formatTokenCount(Math.floor(value));
}

function formatCompactByteCount(bytes: number): string {
  const safe = Math.max(0, Math.floor(bytes));
  if (safe >= 1_000_000_000) {
    return `${(safe / 1_000_000_000).toFixed(1)}GB`;
  }
  if (safe >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(1)}MB`;
  }
  if (safe >= 1_000) {
    return `${(safe / 1_000).toFixed(1)}KB`;
  }
  return `${safe}B`;
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

export function shouldNotifyUserAboutCompaction(cfg?: OpenClawConfig): boolean {
  return cfg?.agents?.defaults?.compaction?.notifyUser === true;
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

/** Prefer explicit reasonText; otherwise derive a short label from compact trigger fields. */
export function resolveCompactionPersistReasonText(params: {
  reasonText?: string;
  trigger?: "budget" | "overflow" | "manual";
  preflightCompactionTrigger?: "tokens" | "transcript_bytes";
}): string | undefined {
  const explicit = normalizeOptionalString(params.reasonText);
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
