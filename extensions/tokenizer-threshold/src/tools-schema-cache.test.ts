import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  getCachedToolsSchemaTokens,
  rememberToolsSchemaTokens,
  resetToolsSchemaCacheForTest,
  serializeToolsSchema,
} from "./tools-schema-cache.js";

describe("tools-schema-cache", () => {
  beforeEach(() => {
    resetToolsSchemaCacheForTest();
  });
  afterEach(() => {
    resetToolsSchemaCacheForTest();
  });

  it("serializes tool arrays and ignores empty input", () => {
    expect(serializeToolsSchema(undefined)).toBe("");
    expect(serializeToolsSchema([])).toBe("");
    expect(serializeToolsSchema([{ name: "bash", parameters: { type: "object" } }])).toContain(
      "bash",
    );
  });

  it("remembers tokens by sessionId and sessionKey", () => {
    rememberToolsSchemaTokens({
      sessionId: "s1",
      sessionKey: "agent:main:main",
      tokens: 12_345,
    });
    expect(getCachedToolsSchemaTokens({ sessionId: "s1" })).toBe(12_345);
    expect(getCachedToolsSchemaTokens({ sessionKey: "agent:main:main" })).toBe(12_345);
    expect(getCachedToolsSchemaTokens({ sessionId: "missing" })).toBe(0);
  });
});
