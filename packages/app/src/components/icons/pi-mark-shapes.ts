// The π mark's geometry on a 100×100 grid. Mirrors assets/brand/pi-mark.svg (the launcher icon
// source); pi-mark-shapes.test.ts fails if the two drift.

export interface MarkRect {
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
}

export interface MarkPolygon {
  kind: "polygon";
  points: readonly (readonly [number, number])[];
}

export type MarkShape = MarkRect | MarkPolygon;

export const PI_MARK_SHAPES: readonly MarkShape[] = [
  { kind: "rect", x: 18, y: 24, width: 64, height: 12, rx: 6 },
  {
    kind: "polygon",
    points: [
      [34, 30],
      [46, 30],
      [38, 76],
      [26, 76],
    ],
  },
  { kind: "rect", x: 56, y: 30, width: 12, height: 40, rx: 0 },
  { kind: "rect", x: 56, y: 64, width: 22, height: 12, rx: 6 },
];

/** The glyph's bounds, so a renderer can center it. */
export const PI_MARK_VIEWBOX = "16 22 68 56";

export function polygonPoints(shape: MarkPolygon): string {
  return shape.points.map(([x, y]) => `${x},${y}`).join(" ");
}
