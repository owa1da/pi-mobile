// The pi agent logo's geometry on a 100×100 grid: five rects of a 4×4 grid of 16-unit cells.
// Mirrors assets/brand/pi-mark.svg (the launcher icon source); pi-mark-shapes.test.ts fails if the
// two drift.

export interface MarkRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PI_MARK_SHAPES: readonly MarkRect[] = [
  { x: 18, y: 18, width: 48, height: 16 },
  { x: 18, y: 34, width: 16, height: 48 },
  { x: 50, y: 34, width: 16, height: 16 },
  { x: 34, y: 50, width: 16, height: 16 },
  { x: 66, y: 50, width: 16, height: 32 },
];

/** Square, glyph centred with the margin upstream's 600-unit viewBox gives it (~11%). */
export const PI_MARK_VIEWBOX = "9 9 82 82";
