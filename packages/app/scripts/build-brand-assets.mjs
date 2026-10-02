// Rasterizes assets/brand/pi-mark.svg into every app icon, splash, notification icon and favicon.
// No dependencies: the mark is rects and polygons only (asserted), drawn with 4×4 supersampling and
// written as PNG through node:zlib. Run from packages/app: `node scripts/build-brand-assets.mjs`.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(appRoot, "assets/brand/pi-mark.svg");

// Theme tokens (src/styles/theme.ts): pure-black surface0, accentBright on dark, accent on light.
const BLACK = "#000000";
const ACCENT_BRIGHT = "#7ccba0";
const ACCENT = "#20744A";
const WHITE = "#ffffff";

function readGlyph(svg) {
  const group = /<g[^>]*data-role="glyph"[^>]*>([\s\S]*?)<\/g>/.exec(svg);
  if (!group) throw new Error('pi-mark.svg: missing <g data-role="glyph">');
  const polygons = [...group[1].matchAll(/<polygon\s+points="([^"]*)"\s*\/>/g)].map((match) => {
    const nums = match[1]
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (nums.length < 6 || nums.length % 2 || nums.some((n) => !Number.isFinite(n)))
      throw new Error("pi-mark.svg: polygon needs numeric x,y pairs");
    const points = [];
    for (let i = 0; i < nums.length; i += 2) points.push([nums[i], nums[i + 1]]);
    return { kind: "polygon", points };
  });
  const rects = [...group[1].matchAll(/<rect\s+([^>]*?)\/>/g)].map((match) => {
    const attrs = Object.fromEntries(
      [...match[1].matchAll(/([a-z]+)="([^"]*)"/g)].map((a) => [a[1], Number(a[2])]),
    );
    for (const key of ["x", "y", "width", "height"]) {
      if (!Number.isFinite(attrs[key])) throw new Error(`pi-mark.svg: rect without numeric ${key}`);
    }
    return {
      kind: "rect",
      x: attrs.x,
      y: attrs.y,
      w: attrs.width,
      h: attrs.height,
      r: attrs.rx || 0,
    };
  });
  const stripped = group[1]
    .replace(/<rect\s+[^>]*?\/>/g, "")
    .replace(/<polygon\s+[^>]*?\/>/g, "")
    .trim();
  if (stripped) throw new Error("pi-mark.svg: the glyph may contain only <rect/> and <polygon/>");
  const shapes = [...rects, ...polygons];
  if (shapes.length === 0) throw new Error("pi-mark.svg: empty glyph");
  return shapes;
}

function insidePolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideShape(px, py, shape) {
  return shape.kind === "polygon"
    ? insidePolygon(px, py, shape.points)
    : insideRoundedRect(px, py, shape);
}

function bounds(shape) {
  if (shape.kind === "polygon") {
    const xs = shape.points.map((p) => p[0]);
    const ys = shape.points.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }
  return { x0: shape.x, x1: shape.x + shape.w, y0: shape.y, y1: shape.y + shape.h };
}

function insideRoundedRect(px, py, rect) {
  if (px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) return false;
  const r = Math.min(rect.r, rect.w / 2, rect.h / 2);
  const cx = Math.min(Math.max(px, rect.x + r), rect.x + rect.w - r);
  const cy = Math.min(Math.max(py, rect.y + r), rect.y + rect.h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function hex(color) {
  const n = Number.parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const SS = 4;

/** Fraction of the pixel at (x, y) covered by the glyph, from SS×SS samples. */
function coverage(rects, x, y, offX, offY, unit) {
  let hits = 0;
  for (let sy = 0; sy < SS; sy += 1) {
    for (let sx = 0; sx < SS; sx += 1) {
      const ux = (x + (sx + 0.5) / SS - offX) / unit;
      const uy = (y + (sy + 0.5) / SS - offY) / unit;
      if (rects.some((shape) => insideShape(ux, uy, shape))) hits += 1;
    }
  }
  return hits / (SS * SS);
}

/** Glyph centered (by its bounds) at `scale` of the canvas, over `background` (or transparent). */
function render(rects, { size, scale, fg, background }) {
  const b = rects.map(bounds);
  const minX = Math.min(...b.map((r) => r.x0));
  const maxX = Math.max(...b.map((r) => r.x1));
  const minY = Math.min(...b.map((r) => r.y0));
  const maxY = Math.max(...b.map((r) => r.y1));
  const unit = (size * scale) / 100;
  const offX = size / 2 - ((minX + maxX) / 2) * unit;
  const offY = size / 2 - ((minY + maxY) / 2) * unit;
  const [fr, fg2, fb] = hex(fg);
  const bg = background ? hex(background) : null;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const a = coverage(rects, x, y, offX, offY, unit);
      const i = (y * size + x) * 4;
      if (bg) {
        pixels[i] = Math.round(bg[0] + (fr - bg[0]) * a);
        pixels[i + 1] = Math.round(bg[1] + (fg2 - bg[1]) * a);
        pixels[i + 2] = Math.round(bg[2] + (fb - bg[2]) * a);
        pixels[i + 3] = 255;
      } else {
        pixels[i] = fr;
        pixels[i + 1] = fg2;
        pixels[i + 2] = fb;
        pixels[i + 3] = Math.round(a * 255);
      }
    }
  }
  return encodePng(size, size, pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// scale = glyph grid (100 units) as a fraction of the canvas. The glyph's bounds are 64×64
// units (the pi agent logo's 4×4 block grid), so 0.8 fills ~51% of a legacy icon; adaptive and
// maskable icons keep the whole glyph inside the 61% safe circle (0.62 → diagonal ≈ 56%).
const OUTPUTS = [
  { file: "assets/images/icon.png", size: 1024, scale: 0.8, fg: ACCENT_BRIGHT, background: BLACK },
  { file: "assets/images/android-icon-foreground.png", size: 1024, scale: 0.62, fg: ACCENT_BRIGHT },
  { file: "assets/images/splash-icon.png", size: 200, scale: 1, fg: ACCENT },
  { file: "assets/images/splash-icon-dark.png", size: 200, scale: 1, fg: ACCENT_BRIGHT },
  { file: "assets/images/notification-icon.png", size: 96, scale: 0.9, fg: WHITE },
  { file: "assets/images/favicon.png", size: 48, scale: 1.1, fg: ACCENT_BRIGHT, background: BLACK },
  {
    file: "public/apple-touch-icon.png",
    size: 180,
    scale: 0.8,
    fg: ACCENT_BRIGHT,
    background: BLACK,
  },
  { file: "public/pwa-icon-192.png", size: 192, scale: 0.75, fg: ACCENT_BRIGHT, background: BLACK },
  { file: "public/pwa-icon-512.png", size: 512, scale: 0.75, fg: ACCENT_BRIGHT, background: BLACK },
];

const rects = readGlyph(fs.readFileSync(source, "utf8"));
for (const output of OUTPUTS) {
  const target = path.join(appRoot, output.file);
  fs.writeFileSync(target, render(rects, output));
  console.log(`wrote ${output.file} (${output.size}×${output.size})`);
}
