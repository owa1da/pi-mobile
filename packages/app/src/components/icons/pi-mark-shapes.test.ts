import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PI_MARK_SHAPES, type MarkRect } from "./pi-mark-shapes";

const SVG = path.resolve(__dirname, "../../../assets/brand/pi-mark.svg");

function shapesFromSvg(svg: string): MarkRect[] {
  const group = /<g[^>]*data-role="glyph"[^>]*>([\s\S]*?)<\/g>/.exec(svg);
  if (!group) throw new Error("no glyph group");
  if (/<polygon/.test(group[1])) throw new Error("the pi agent logo is rects only");
  return [...group[1].matchAll(/<rect\s+([^>]*?)\/>/g)].map((match) => {
    const attrs = Object.fromEntries(
      [...match[1].matchAll(/([a-z]+)="([^"]*)"/g)].map((a) => [a[1], Number(a[2])]),
    );
    expect(attrs.rx ?? 0).toBe(0);
    return { x: attrs.x, y: attrs.y, width: attrs.width, height: attrs.height };
  });
}

/** The 4×4 cell pattern the rects cover (# filled), cells of 16 units from 18. */
function pattern(rects: readonly MarkRect[]): string[] {
  const rows: string[] = [];
  for (let r = 0; r < 4; r++) {
    let line = "";
    for (let c = 0; c < 4; c++) {
      const cx = 18 + c * 16 + 8;
      const cy = 18 + r * 16 + 8;
      const hit = rects.some(
        (s) => cx > s.x && cx < s.x + s.width && cy > s.y && cy < s.y + s.height,
      );
      line += hit ? "#" : ".";
    }
    rows.push(line);
  }
  return rows;
}

describe("PI_MARK_SHAPES", () => {
  it("matches the launcher icon source, so the empty-state mark is the same drawing", () => {
    const fromSvg = shapesFromSvg(fs.readFileSync(SVG, "utf8"));
    const sortKey = (s: MarkRect) => JSON.stringify(s);
    expect(fromSvg.map(sortKey).sort()).toEqual([...PI_MARK_SHAPES].map(sortKey).sort());
  });

  it("draws the pi agent logo (upstream's block P), not the math π", () => {
    expect(pattern(PI_MARK_SHAPES)).toEqual(["###.", "#.#.", "##.#", "#..#"]);
  });
});
