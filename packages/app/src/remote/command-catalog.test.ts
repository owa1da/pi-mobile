import { describe, expect, it } from "vitest";
import { CATALOG_MAX_BYTES, parseCommandCatalog, selectCatalogCommands } from "./command-catalog";

const catalog = (updatedAt = 100) => ({
  v: 1 as const,
  updatedAt,
  latest: { cwd: "/other", at: updatedAt, commands: [{ name: "latest", description: "Latest" }] },
  byCwd: { "/work": { at: updatedAt, commands: [{ name: "local", description: "Local" }] } },
});

describe("command catalog discovery", () => {
  it("parses v1 and sanitizes commands with the live-state rules", () => {
    const input = catalog();
    input.latest.commands = [
      { name: "/new-command", description: "\u001b[31mNew\ncommand\u0000" },
      { name: "bad name", description: "Bad" },
    ];
    expect(parseCommandCatalog(JSON.stringify(input))?.latest.commands).toEqual([
      { name: "new-command", description: "New command" },
    ]);
  });
  it("accepts known source values, tolerating missing and unknown sources", () => {
    const input = catalog();
    const sources = ["prompt", "skill", "extension", "builtin", "future", undefined, 42];
    const text = JSON.stringify({
      ...input,
      latest: {
        ...input.latest,
        commands: sources.map((source, i) => ({ name: `c${i}`, source })),
      },
    });
    expect(parseCommandCatalog(text)?.latest.commands.map((row) => row.source)).toEqual([
      "prompt",
      "skill",
      "extension",
      "builtin",
      undefined,
      undefined,
      undefined,
    ]);
  });
  it.each([
    "{",
    "null",
    "[]",
    JSON.stringify({ ...catalog(), v: 2 }),
    JSON.stringify({ ...catalog(), updatedAt: "100" }),
    JSON.stringify({ ...catalog(), latest: {} }),
  ])("ignores malformed/unknown catalog %s", (text) => {
    expect(parseCommandCatalog(text)).toBeUndefined();
  });
  it("rejects oversized UTF-8 input before parsing", () => {
    expect(
      parseCommandCatalog(
        JSON.stringify({ ...catalog(), extra: "é".repeat(CATALOG_MAX_BYTES / 2) }),
      ),
    ).toBeUndefined();
  });
  it("bounds cwd and command counts", () => {
    const input = catalog();
    input.latest.commands = Array.from({ length: 301 }, (_, i) => ({
      name: `c${i}`,
      description: "",
    }));
    expect(parseCommandCatalog(JSON.stringify(input))).toBeUndefined();
    const byCwd = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`/cwd${i}`, catalog().byCwd["/work"]]),
    );
    expect(parseCommandCatalog(JSON.stringify({ ...catalog(), byCwd }))).toBeUndefined();
  });
  it("selects cwd then latest, including an explicitly empty cwd list", () => {
    const parsed = parseCommandCatalog(JSON.stringify(catalog()))!;
    expect(selectCatalogCommands(parsed, "/work")?.[0].name).toBe("local");
    expect(selectCatalogCommands(parsed, "/missing")?.[0].name).toBe("latest");
    parsed.byCwd["/work"].commands = [];
    expect(selectCatalogCommands(parsed, "/work")).toEqual([]);
    expect(selectCatalogCommands(undefined, "/work")).toBeUndefined();
  });
});
