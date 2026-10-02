import { describe, expect, it } from "vitest";
import { fontScaleChanged } from "./font-scale";

describe("fontScaleChanged", () => {
  it("is false for the same scale and true for a new one", () => {
    expect(fontScaleChanged(1, 1)).toBe(false);
    expect(fontScaleChanged(1, 1.0000001)).toBe(false);
    expect(fontScaleChanged(1, 1.3)).toBe(true);
    expect(fontScaleChanged(2, 1)).toBe(true);
  });
});
