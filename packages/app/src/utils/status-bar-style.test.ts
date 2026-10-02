import { describe, expect, it } from "vitest";
import { statusBarStyleFor } from "./status-bar-style";

describe("statusBarStyleFor", () => {
  it("draws dark icons on a light theme", () => {
    expect(statusBarStyleFor("light")).toBe("dark-content");
  });

  it("draws light icons on a dark theme", () => {
    expect(statusBarStyleFor("dark")).toBe("light-content");
  });

  it("falls back to the system default for anything else", () => {
    expect(statusBarStyleFor(undefined)).toBe("default");
    expect(statusBarStyleFor("sepia")).toBe("default");
  });
});
