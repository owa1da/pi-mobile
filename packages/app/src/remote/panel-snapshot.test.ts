import { describe, expect, it } from "vitest";
import { parsePanelSnapshot, PANEL_MAX_BYTES } from "./panel-snapshot";

describe.each(["usage", "changelog"] as const)("%s display snapshot", (name) => {
  const data = name === "usage" ? { accounts: [] } : { markdown: "## Release" };
  const valid = { v: 1, at: 1234, data };
  it("parses v1 with its host time", () => {
    expect(parsePanelSnapshot(JSON.stringify(valid), name)).toEqual(valid);
  });
  it.each([
    undefined,
    "{",
    "null",
    "[]",
    JSON.stringify({ v: 2, at: 1234, data }),
    JSON.stringify({ v: 1, at: -1, data }),
    JSON.stringify({ v: 1, at: 1234 }),
    JSON.stringify({ v: 1, at: 1234, data: {} }),
  ])("ignores absent, malformed, unknown payload %s", (text) => {
    expect(parsePanelSnapshot(text, name)).toBeUndefined();
  });
  it("rejects oversized text and UTF-8 bytes", () => {
    expect(
      parsePanelSnapshot(
        JSON.stringify({ ...valid, extra: "x".repeat(PANEL_MAX_BYTES[name]) }),
        name,
      ),
    ).toBeUndefined();
    expect(
      parsePanelSnapshot(
        JSON.stringify({ ...valid, extra: "é".repeat(PANEL_MAX_BYTES[name] / 2) }),
        name,
      ),
    ).toBeUndefined();
  });
});
