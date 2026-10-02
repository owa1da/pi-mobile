import { describe, expect, it } from "vitest";
import type { SessionRow } from "@/host/types";
import {
  buildSections,
  CLOSED_SHOWN,
  countParts,
  formatAge,
  rowGlyph,
  shortModel,
} from "./view-model";

function row(over: Partial<SessionRow>): SessionRow {
  return {
    key: over.sessionId ?? "s",
    sessionId: "s",
    section: "completed",
    live: false,
    title: "t",
    cwd: "/home/me",
    state: "closed",
    since: 0,
    messages: 1,
    ...over,
  };
}

describe("buildSections", () => {
  it("orders Needs input, Working, Completed and leaves out empty sections", () => {
    const sections = buildSections(
      [
        row({ sessionId: "c", section: "completed" }),
        row({ sessionId: "n", section: "needs", live: true }),
      ],
      false,
    );
    expect(sections.map((s) => s.key)).toEqual(["needs", "completed"]);
  });

  it("shows every open completed row and the first closed ones, hiding the rest", () => {
    const closed = Array.from({ length: CLOSED_SHOWN + 3 }, (_, i) => row({ sessionId: `c${i}` }));
    const open = row({ sessionId: "open", live: true });
    const [completed] = buildSections([open, ...closed], false);
    expect(completed?.data).toHaveLength(CLOSED_SHOWN + 1);
    expect(completed?.hiddenCount).toBe(3);
    expect(buildSections([open, ...closed], true)[0]?.hiddenCount).toBe(0);
  });
});

describe("header counts and ages", () => {
  it("lists only non-empty sections in order", () => {
    expect(countParts({ needs: 3, working: 0, completed: 8 })).toEqual([
      { section: "needs", count: 3 },
      { section: "completed", count: 8 },
    ]);
  });

  it("formats ages against the host clock", () => {
    const now = 1_000_000;
    expect(formatAge((now - 41) * 1000, now)).toBe("41s");
    expect(formatAge((now - 5 * 60) * 1000, now)).toBe("5m");
    expect(formatAge((now - 3 * 3600 - 59) * 1000, now)).toBe("3h");
    expect(formatAge((now - 2 * 86400) * 1000, now)).toBe("2d");
    // phone clock ahead of host: never negative
    expect(formatAge((now + 30) * 1000, now)).toBe("0s");
  });
});

describe("short model and folder", () => {
  it("drops the vendor prefix and 'Claude', else reads the id as words", () => {
    expect(
      shortModel({ provider: "anthropic", id: "x", name: "Anthropic: Claude Sonnet 4.6" }),
    ).toBe("Sonnet 4.6");
    expect(shortModel({ provider: "z", id: "x", name: "GLM 5.3 Flash" })).toBe("GLM 5.3 Flash");
    expect(shortModel({ provider: "d", id: "deepseek-v4-flash" })).toBe("Deepseek V4 Flash");
    expect(shortModel({ provider: "anthropic", id: "claude-opus-5-5" })).toBe("Opus 5.5");
    expect(shortModel({ provider: "fake", id: "fake-1" })).toBe("Fake 1");
    expect(shortModel({ provider: "d", id: "a-very-long-model-name-that-goes-on" })?.length).toBe(
      20,
    );
    expect(shortModel(undefined)).toBeUndefined();
  });

  it("says nothing for a model pi reports as unknown", () => {
    expect(shortModel({ provider: "unknown", id: "unknown" })).toBeUndefined();
    expect(shortModel({ provider: "x", id: "Unknown", name: "unknown" })).toBeUndefined();
    expect(shortModel({ provider: "x", id: "" })).toBeUndefined();
    expect(shortModel({ provider: "x", id: "unknown", name: "Opus 5.5" })).toBe("Opus 5.5");
  });
});

describe("rowGlyph", () => {
  it("needs input, working and scheduled", () => {
    expect(rowGlyph(row({ section: "needs", live: true, asking: "Allow rm?" }))).toBe("needs");
    expect(rowGlyph(row({ section: "working", live: true, detail: "bash" }))).toBe("working");
    expect(rowGlyph(row({ section: "working", wake: { due: 1, missed: false } }))).toBe(
      "scheduled",
    );
  });

  it("completed rows: live, closed, gone, failed and interrupted", () => {
    expect(rowGlyph(row({ live: true }))).toBe("live");
    expect(rowGlyph(row({}))).toBe("closed");
    expect(rowGlyph(row({ endReason: "gone" }))).toBe("gone");
    expect(rowGlyph(row({ detail: "error: timeout" }))).toBe("failed");
    expect(rowGlyph(row({ detail: "interrupted" }))).toBe("interrupted");
  });
});
