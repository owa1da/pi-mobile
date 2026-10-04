// adb helpers for scripts/e2e-emulator.mjs: UI dumps (React Native testIDs appear as
// resource-ids), taps, text input, keys and screenshots. Node only.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function adb(...args) {
  return execFileSync(
    "adb",
    [...(process.env.ANDROID_SERIAL ? ["-s", process.env.ANDROID_SERIAL] : []), ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m
    ? m[1]
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#10;/g, "\n")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
    : "";
}

/** Every node of the current window: { id, text, desc, cls, bounds: [x1,y1,x2,y2], ... }. */
export function dump() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Never read a stale dump: remove the file first and require the success line.
      adb("shell", "rm", "-f", "/sdcard/pim-ui.xml");
      const said = adb("shell", "uiautomator", "dump", "/sdcard/pim-ui.xml");
      if (!/dumped to/i.test(said)) throw new Error(said.trim());
      const xml = adb("exec-out", "cat", "/sdcard/pim-ui.xml");
      const nodes = [];
      for (const m of xml.matchAll(/<node\b[^>]*>/g)) {
        const tag = m[0];
        const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag);
        nodes.push({
          id: attr(tag, "resource-id").replace(/^[\w.]+:id\//, ""),
          text: attr(tag, "text"),
          desc: attr(tag, "content-desc"),
          cls: attr(tag, "class"),
          checked: attr(tag, "checked") === "true",
          selected: attr(tag, "selected") === "true",
          focused: attr(tag, "focused") === "true",
          enabled: attr(tag, "enabled") !== "false",
          clickable: attr(tag, "clickable") === "true",
          longClickable: attr(tag, "long-clickable") === "true",
          scrollable: attr(tag, "scrollable") === "true",
          pkg: attr(tag, "package"),
          bounds: b ? [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] : [0, 0, 0, 0],
        });
      }
      return nodes;
    } catch {
      // uiautomator fails while the UI is animating ("could not get idle state"); retry.
    }
  }
  return [];
}

export const byId = (id) => (n) => n.id === id;
export const byText = (text) => (n) =>
  text instanceof RegExp
    ? text.test(n.text) || text.test(n.desc)
    : n.text === text || n.desc === text;
export const idPrefix = (prefix) => (n) => n.id.startsWith(prefix);

export function find(pred, nodes = dump()) {
  return nodes.find(pred);
}

export async function waitNode(pred, timeoutMs = 15_000, label = "node") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const node = find(pred);
    if (node) return node;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(400);
  }
}

export async function waitGone(pred, timeoutMs = 15_000, label = "node to go") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!find(pred)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(400);
  }
}

export function center(node) {
  const [x1, y1, x2, y2] = node.bounds;
  return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
}

export function tapXY(x, y) {
  adb("shell", "input", "tap", String(x), String(y));
}

export function tapNode(node) {
  const [x, y] = center(node);
  tapXY(x, y);
}

export async function tap(pred, label = "node", timeoutMs = 15_000) {
  const node = await waitNode(pred, timeoutMs, label);
  tapNode(node);
  await sleep(350);
  return node;
}

/** Types ASCII text into the focused field (`input text` escaping for the device shell). */
export function typeText(text) {
  const chunks = text.match(/.{1,40}/gs) ?? [];
  for (const chunk of chunks) {
    const escaped = chunk.replace(/ /g, "%s").replace(/'/g, "'\\''");
    adb("shell", `input text '${escaped}'`);
  }
}

export function key(code) {
  adb("shell", "input", "keyevent", String(code));
}

export const KEY = { ENTER: 66, BACK: 4, DEL: 67, ESCAPE: 111, MOVE_END: 123, TAB: 61 };

export function swipe(x1, y1, x2, y2, ms = 300) {
  adb("shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), String(ms));
}

/** Pixels per dp (density / 160). */
export function dpScale() {
  const said = adb("shell", "wm", "density");
  const override = /Override density: (\d+)/.exec(said);
  const physical = /Physical density: (\d+)/.exec(said);
  return Number((override ?? physical)?.[1] ?? 420) / 160;
}

/** Android system font scale (1 = default). */
export function fontScale(value) {
  adb("shell", "settings", "put", "system", "font_scale", String(value));
}

export function screenSize() {
  const said = adb("shell", "wm", "size");
  const m = /Override size: (\d+)x(\d+)/.exec(said) ?? /Physical size: (\d+)x(\d+)/.exec(said);
  return m ? [Number(m[1]), Number(m[2])] : [1080, 2400];
}

export function screenshot(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const png = execFileSync(
    "adb",
    [
      ...(process.env.ANDROID_SERIAL ? ["-s", process.env.ANDROID_SERIAL] : []),
      "exec-out",
      "screencap",
      "-p",
    ],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const file = path.join(dir, name.endsWith(".png") ? name : `${name}.png`);
  fs.writeFileSync(file, png);
  return file;
}

export function hideKeyboard() {
  const shown = /mInputShown=true/.test(adb("shell", "dumpsys", "input_method"));
  if (shown) key(KEY.BACK);
  return shown;
}

export function keyboardShown() {
  return /mInputShown=true/.test(adb("shell", "dumpsys", "input_method"));
}

/**
 * Animator duration 0 = Android "remove animations"; React Native reports it as Reduce Motion, so
 * the app's spinners go static and uiautomator can reach an idle state.
 */
export function reduceMotion(on) {
  const scale = on ? "0" : "1";
  for (const name of [
    "animator_duration_scale",
    "transition_animation_scale",
    "window_animation_scale",
  ])
    adb("shell", "settings", "put", "global", name, scale);
}

export function nightMode(on) {
  adb("shell", "cmd", "uimode", "night", on ? "yes" : "no");
}

export function displayRotation() {
  const m = /mRotation=(\d)/.exec(adb("shell", "dumpsys", "window", "displays"));
  return m ? Number(m[1]) : -1;
}

/**
 * Portrait (0) or landscape (1) with auto-rotate off. `wm user-rotation lock` is used because a
 * plain `settings put system user_rotation` write can be overwritten by the window manager; this
 * waits (up to 5 s) until the display really is at that rotation.
 */
export function rotate(rotation) {
  adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
  adb("shell", "wm", "user-rotation", "lock", String(rotation));
  const deadline = Date.now() + 5000;
  while (displayRotation() !== rotation && Date.now() < deadline) {
    execFileSync("sleep", ["0.3"]);
  }
}

export function launch(pkg, { clear = false } = {}) {
  if (clear) adb("shell", "pm", "clear", pkg);
  adb("shell", "am", "force-stop", pkg);
  adb("shell", "am", "start", "-n", `${pkg}/.MainActivity`);
}
