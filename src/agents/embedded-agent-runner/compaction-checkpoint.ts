/** Owns the shared checkpoint lifecycle around both compaction entry points. */
import type { SessionCompactionCheckpointTrigger } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createFileBackedCompactionCheckpointStore,
  readSessionLeafStateFromTranscriptAsync,
  resolveCompactionCheckpointTranscriptPosition,
  resolveSessionCompactionCheckpointReason,
  type CapturedCompactionCheckpointSnapshot,
} from "../../gateway/session-compaction-checkpoints.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveCompactionCheckpointTriggerFromParams } from "./compaction-checkpoint-trigger.js";
import { log } from "./logger.js";

export const compactionCheckpointStore = createFileBackedCompactionCheckpointStore();

export async function persistCompactionCheckpoint(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId: string;
  trigger?: "budget" | "overflow" | "manual" | "timeout_recovery";
  checkpointTrigger?: SessionCompactionCheckpointTrigger;
  preflightCompactionTrigger?: "tokens" | "transcript_bytes";
  currentTokenCount?: number;
  contextTokenBudget?: number;
  attempt?: number;
  snapshot?: CapturedCompactionCheckpointSnapshot | null;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  sessionFile: string;
  leafId?: string;
  createdAt?: number;
}): Promise<boolean> {
  if (!params.config || !params.sessionKey || !params.snapshot) {
    return false;
  }
  try {
    const checkpointTrigger = resolveCompactionCheckpointTriggerFromParams({
      checkpointTrigger: params.checkpointTrigger,
      trigger: params.trigger,
      preflightCompactionTrigger: params.preflightCompactionTrigger,
      currentTokenCount: params.currentTokenCount,
      contextTokenBudget: params.contextTokenBudget,
      attempt: params.attempt,
    });
    const transcriptState = await readSessionLeafStateFromTranscriptAsync(params.sessionFile);
    const checkpointPosition = resolveCompactionCheckpointTranscriptPosition({
      preferredLeafId: params.leafId,
      transcriptState,
    });
    const stored = await compactionCheckpointStore.persistCheckpoint({
      cfg: params.config,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      reason: resolveSessionCompactionCheckpointReason({
        trigger: params.trigger,
        checkpointTrigger,
      }),
      ...(checkpointTrigger ? { trigger: checkpointTrigger } : {}),
      snapshot: params.snapshot,
      summary: params.summary,
      firstKeptEntryId: params.firstKeptEntryId,
      tokensBefore: params.tokensBefore,
      tokensAfter: params.tokensAfter,
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
