import { describe, expect, it } from "vitest";

import { sanitizePrompt } from "./sanitize";

describe("sanitizePrompt", () => {
  it("removes an ESC[201~ mid-prompt so the bracketed paste cannot end early", () => {
    const out = sanitizePrompt("before\x1b[201~after\x1b[200~ more");
    expect(out).toBe("before[201~after[200~ more");
    expect(out).not.toContain("\x1b");
  });

  it("normalizes CRLF and CR to LF and keeps LF and TAB", () => {
    expect(sanitizePrompt("a\r\nb\rc\nd\te")).toBe("a\nb\nc\nd\te");
    expect(sanitizePrompt("\r\r\n")).toBe("\n\n");
  });

  it("drops every other C0 and C1 control character and DEL", () => {
    let c0 = "";
    for (let code = 0; code < 0x20; code++) c0 += String.fromCharCode(code);
    let c1 = "";
    for (let code = 0x80; code <= 0x9f; code++) c1 += String.fromCharCode(code);
    // C0 keeps TAB and LF; its CR (0x0d) becomes a second LF.
    expect(sanitizePrompt(`x${c0}y${c1}z\x7f!`)).toBe("x\t\n\nyz!");
  });

  it("keeps ordinary text, unicode and emoji untouched", () => {
    const text = "ünïcødé ✓ 🎉 日本語 'q' \"dq\" $HOME `id` #{pane_id}";
    expect(sanitizePrompt(text)).toBe(text);
  });
});
