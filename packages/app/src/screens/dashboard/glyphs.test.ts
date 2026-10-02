import { describe, expect, it } from "vitest";
import {
  WORKING_FRAMES,
  WORKING_STATIC,
  glyphFor,
  isDotGlyph,
  rowAccessibilityLabel,
  rowStateWord,
} from "./glyphs";

describe("glyphFor", () => {
  it("animates the working glyph through forge's frames", () => {
    expect(glyphFor("working", false, 0)).toBe(WORKING_FRAMES[0]);
    expect(glyphFor("working", false, 4)).toBe("✻");
    expect(glyphFor("working", false, WORKING_FRAMES.length + 1)).toBe(WORKING_FRAMES[1]);
  });

  it("uses a still ✢ under Reduce Motion, never the needs-input ✻", () => {
    for (let frame = 0; frame < 12; frame += 1) {
      expect(glyphFor("working", true, frame)).toBe(WORKING_STATIC);
    }
    expect(WORKING_STATIC).toBe("✢");
    expect(glyphFor("working", true)).not.toBe(glyphFor("needs", true));
  });

  it("keeps static glyphs the same with or without motion", () => {
    for (const kind of ["needs", "live", "closed", "failed", "scheduled"] as const) {
      expect(glyphFor(kind, true)).toBe(glyphFor(kind, false));
    }
    expect(glyphFor("needs", false)).toBe("✻");
    expect(glyphFor("closed", false)).toBe("●");
  });

  it("marks only the closed family as dots", () => {
    expect(isDotGlyph("closed")).toBe(true);
    expect(isDotGlyph("gone")).toBe(true);
    expect(isDotGlyph("needs")).toBe(false);
    expect(isDotGlyph("working")).toBe(false);
  });
});

describe("rowStateWord", () => {
  it("names each section, splitting completed by liveness", () => {
    expect(rowStateWord({ section: "needs", live: true })).toBe("needs");
    expect(rowStateWord({ section: "working", live: true })).toBe("working");
    expect(rowStateWord({ section: "completed", live: true })).toBe("completed");
    expect(rowStateWord({ section: "completed", live: false })).toBe("closed");
  });
});

describe("rowAccessibilityLabel", () => {
  it("includes the state word and drops empty parts", () => {
    expect(
      rowAccessibilityLabel({
        title: "Deploy staging",
        state: "needs input",
        model: "Opus 5.5",
        age: "40s",
      }),
    ).toBe("Deploy staging, needs input, Opus 5.5, 40s");
  });

  it("always carries the state even with no model", () => {
    expect(rowAccessibilityLabel({ title: "Refactor", state: "working", age: "2m" })).toBe(
      "Refactor, working, 2m",
    );
  });
});
