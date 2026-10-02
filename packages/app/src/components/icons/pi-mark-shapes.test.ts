import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PI_MARK_SHAPES, polygonPoints, type MarkShape } from "./pi-mark-shapes";

const SVG = path.resolve(__dirname, "../../../assets/brand/pi-mark.svg");

function shapesFromSvg(svg: string): MarkShape[] {
  const group = /<g[^>]*data-role="glyph"[^>]*>([\s\S]*?)<\/g>/.exec(svg);
  if (!group) throw new Error("no glyph group");
  const shapes: MarkShape[] = [];
  for (const match of group[1].matchAll(/<(rect|polygon)\s+([^>]*?)\/>/g)) {
    const attrs = Object.fromEntries(
      [...match[2].matchAll(/([a-z]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]),
    );
    if (match[1] === "polygon") {
      const nums = attrs.points
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      const points: [number, number][] = [];
      for (let i = 0; i < nums.length; i += 2) points.push([nums[i], nums[i + 1]]);
      shapes.push({ kind: "polygon", points });
    } else {
      shapes.push({
        kind: "rect",
        x: Number(attrs.x),
        y: Number(attrs.y),
        width: Number(attrs.width),
        height: Number(attrs.height),
        rx: Number(attrs.rx ?? 0),
      });
    }
  }
  return shapes;
}

describe("PI_MARK_SHAPES", () => {
  it("matches the launcher icon source, so the empty-state mark is the same drawing", () => {
    const fromSvg = shapesFromSvg(fs.readFileSync(SVG, "utf8"));
    const sortKey = (s: MarkShape) => JSON.stringify(s);
    expect(fromSvg.map(sortKey).sort()).toEqual([...PI_MARK_SHAPES].map(sortKey).sort());
  });

  it("formats polygon points for react-native-svg", () => {
    expect(
      polygonPoints({
        kind: "polygon",
        points: [
          [1, 2],
          [3, 4],
          [5, 6],
        ],
      }),
    ).toBe("1,2 3,4 5,6");
  });
});
