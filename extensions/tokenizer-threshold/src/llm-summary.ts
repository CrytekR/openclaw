/**
 * Optional LLM summary upgrade for afterTurn when runtimeContext.llm is present.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { extractMessageText } from "./tokenizer.js";

type LlmComplete = (params: {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  purpose?: string;
}) => Promise<{ text: string }>;

const SUMMARY_SYSTEM_PROMPT = `You are a conversation compaction assistant for OpenClaw.
Write a concise summary of the earlier conversation that preserves:
- goals, decisions, constraints, and open questions
- identifiers, file paths, URLs, commands, and error strings exactly
- tool outcomes that later turns may need
Do not invent facts. Prefer short paragraphs or bullets.`;

function serializeMessagesForSummary(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    const role = (message as { role?: unknown }).role;
    const label = typeof role === "string" ? role : "message";
    const text = extractMessageText(message).trim();
    if (!text) {
      continue;
    }
    parts.push(`[${label}]\n${text}`);
  }
  return parts.join("\n\n");
}

/** Ask the host LLM capability for a native-style compaction summary. */
export async function summarizeWithRuntimeLlm(params: {
  messages: AgentMessage[];
  llmComplete: LlmComplete;
  previousSummary?: string;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  if (params.messages.length === 0) {
    return "No prior history.";
  }
  if (params.signal?.aborted) {
    return undefined;
  }
  const body = serializeMessagesForSummary(params.messages);
  if (!body.trim()) {
    return "No prior history.";
  }
  const previous = params.previousSummary?.trim();
  const userContent = previous
    ? `Previous summary:\n${previous}\n\nNew messages to fold in:\n${body}`
    : `Conversation to summarize:\n${body}`;

  try {
    const result = await params.llmComplete({
      purpose: "tokenizer-threshold.compaction-summary",
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      maxTokens: 2048,
      temperature: 0,
      messages: [{ role: "user", content: userContent }],
    });
    const text = result.text?.trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}
