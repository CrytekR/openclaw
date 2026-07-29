/** Owns the shared checkpoint lifecycle around both compaction entry points. */
import {
  mergeCompactionReasonTextIntoDetails,
  resolveCompactionPersistReasonText,
} from "../../auto-reply/reply/compaction-notice.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createFileBackedCompactionCheckpointStore,
  readSessionLeafStateFromTranscriptAsync,
  resolveCompactionCheckpointTranscriptPosition,
  resolveSessionCompactionCheckpointReason,
  type CapturedCompactionCheckpointSnapshot,
} from "../../gateway/session-compaction-checkpoints.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { SessionManager } from "../sessions/index.js";
import { log } from "./logger.js";

export const compactionCheckpointStore = createFileBackedCompactionCheckpointStore();

/** Resolve the durable reason string for checkpoint + transcript details. */
export function resolveEmbeddedCompactionReasonText(params: {
  reasonText?: string;
  trigger?: "budget" | "overflow" | "manual";
  preflightCompactionTrigger?: "tokens" | "transcript_bytes";
}): string | undefined {
  return resolveCompactionPersistReasonText(params);
}

/**
 * Persist the trigger reason on the next compaction entry details so history
 * markers keep it even after checkpoints are trimmed.
 */
export function attachCompactionReasonTextToSessionManager(
  sessionManager: SessionManager,
  reasonText: string | undefined,
): void {
  const trimmed = reasonText?.trim();
  if (!trimmed) {
    return;
  }
  const originalAppendCompaction = sessionManager.appendCompaction.bind(sessionManager);
  sessionManager.appendCompaction = ((summary, firstKeptEntryId, tokensBefore, details, fromHook) =>
    originalAppendCompaction(
      summary,
      firstKeptEntryId,
      tokensBefore,
      mergeCompactionReasonTextIntoDetails(details, trimmed),
      fromHook,
    )) as SessionManager["appendCompaction"];
}

export async function persistCompactionCheckpoint(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId: string;
  trigger?: "budget" | "overflow" | "manual";
  snapshot?: CapturedCompactionCheckpointSnapshot | null;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  reasonText?: string;
  sessionFile: string;
  leafId?: string;
  createdAt?: number;
}): Promise<boolean> {
  if (!params.config || !params.sessionKey || !params.snapshot) {
    return false;
  }
  try {
    const transcriptState = await readSessionLeafStateFromTranscriptAsync(params.sessionFile);
    const checkpointPosition = resolveCompactionCheckpointTranscriptPosition({
      preferredLeafId: params.leafId,
      transcriptState,
    });
    const reasonText = params.reasonText?.trim();
    const stored = await compactionCheckpointStore.persistCheckpoint({
      cfg: params.config,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      reason: resolveSessionCompactionCheckpointReason({ trigger: params.trigger }),
      snapshot: params.snapshot,
      summary: params.summary,
      firstKeptEntryId: params.firstKeptEntryId,
      tokensBefore: params.tokensBefore,
      tokensAfter: params.tokensAfter,
      ...(reasonText ? { reasonText } : {}),
      postSessionFile: params.sessionFile,
      postLeafId: checkpointPosition.leafId,
      postEntryId: checkpointPosition.entryId,
      createdAt: params.createdAt,
    });
    return stored !== null;
  } catch (err) {
    log.warn("failed to persist compaction checkpoint", {
      errorMessage: formatErrorMessage(err),
    });
    return false;
  }
}
