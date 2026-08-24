import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getCachedSystemPrompt,
  rememberSystemPrompt,
  resetSystemPromptCacheForTest,
} from "./system-prompt-cache.js";

describe("system-prompt-cache", () => {
  beforeEach(() => {
    resetSystemPromptCacheForTest();
  });

  afterEach(() => {
    resetSystemPromptCacheForTest();
  });

  it("stores and resolves by sessionId and sessionKey", () => {
    rememberSystemPrompt({
      sessionId: "sid-1",
      sessionKey: "agent:main:main",
      systemPrompt: "You are OpenClaw.",
    });

    expect(getCachedSystemPrompt({ sessionId: "sid-1" })).toBe("You are OpenClaw.");
    expect(getCachedSystemPrompt({ sessionKey: "agent:main:main" })).toBe("You are OpenClaw.");
    expect(getCachedSystemPrompt({ sessionId: "missing" })).toBeUndefined();
  });

  it("ignores blank system prompts", () => {
    rememberSystemPrompt({
      sessionId: "sid-1",
      systemPrompt: "   ",
    });
    expect(getCachedSystemPrompt({ sessionId: "sid-1" })).toBeUndefined();
  });
});
