// Model short names, ported from forge's look (~/.pi/forge/extensions/_lib/look/palette.ts:
// plainLine, shortModel, nameFromId, modelName) so the app writes a model the way forge's
// sessions page, header and status line do: `Opus 5.5`, `Sonnet 4.6`, `GLM 5.3 Flash`.
// The escape stripping is a scanner rather than forge's regexes (oxlint's no-control-regex).

const ESC = 0x1b;
const BEL = 0x07;

function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/** Index just past a CSI (`ESC [ params intermediates final`) starting at `start`, or -1. */
function endOfCsi(text: string, start: number): number {
  let i = start + 2;
  while (i < text.length && /[0-9;:?]/.test(text[i]!)) i += 1;
  while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x2f) i += 1;
  const code = i < text.length ? text.charCodeAt(i) : -1;
  return code >= 0x40 && code <= 0x7e ? i + 1 : -1;
}

/** Index just past an OSC (`ESC ] … BEL` or `ESC ] … ESC \`) starting at `start`, or -1. */
function endOfOsc(text: string, start: number): number {
  for (let i = start + 2; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === BEL) return i + 1;
    if (code === ESC) return text[i + 1] === "\\" ? i + 2 : -1;
  }
  return -1;
}

/** Index just past the CSI or OSC escape starting at `start`, or -1 for anything else. */
function endOfEscape(text: string, start: number): number {
  const next = text[start + 1];
  if (next === "[") return endOfCsi(text, start);
  if (next === "]") return endOfOsc(text, start);
  return -1;
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

/** One line of plain text: escapes and control characters out, whitespace runs one space. */
export function plainLine(text: unknown): string {
  const source = toText(text);
  let out = "";
  let i = 0;
  while (i < source.length) {
    const code = source.charCodeAt(i);
    if (code === ESC) {
      const end = endOfEscape(source, i);
      if (end > 0) {
        i = end;
        continue;
      }
    }
    out += isControl(code) ? " " : source[i];
    i += 1;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** The id after the last `/`: `openrouter/z-ai/glm-5.3-flash` reads `glm-5.3-flash`. */
export function shortModelId(model: string): string {
  const at = model.lastIndexOf("/");
  return at >= 0 ? model.slice(at + 1) : model;
}

/**
 * A name read from a model id, for a model with no display name: the short id in words, each
 * capitalised (a short word with no vowel in capitals), single digits joined by `.`
 * (`deepseek-v4-flash` → `Deepseek V4 Flash`, `glm-5.3-flash` → `GLM 5.3 Flash`,
 * `claude-sonnet-4-6` → `Claude Sonnet 4.6`).
 */
export function nameFromId(id: string): string {
  const words: string[] = [];
  const parts = plainLine(shortModelId(String(id ?? "")))
    .split(/[-_:\s]+/)
    .filter(Boolean);
  for (const word of parts) {
    const last = words[words.length - 1];
    const joinsDigit =
      last !== undefined &&
      /^\d$/.test(word) &&
      /^\d+(\.\d+)*$/.test(last) &&
      /(^|\.)\d$/.test(last);
    if (joinsDigit) words[words.length - 1] = `${last}.${word}`;
    else if (/^[b-df-hj-np-tv-z]{2,4}$/i.test(word)) words.push(word.toUpperCase());
    else words.push(word.charAt(0).toUpperCase() + word.slice(1));
  }
  return words.join(" ");
}

export interface ModelNameInfo {
  id: string;
  name?: string | null;
}

/**
 * A model's short display name: pi's display name without a `Vendor: ` prefix or `Claude `
 * (`Z.ai: GLM 5.3 Flash` → `GLM 5.3 Flash`, `Claude Fable 5.1` → `Fable 5.1`), else one read
 * from the id (`nameFromId`). A bare string is an id. `Claude 3 Haiku` keeps its word.
 */
export function modelName(model: ModelNameInfo | string | null | undefined): string {
  if (!model) return "";
  const info = typeof model === "string" ? { id: model } : model;
  const id = String(info.id ?? "");
  const name = plainLine(info.name);
  const display = name && name !== id ? name.replace(/^[^:\s][^:]{0,29}:\s+/, "") : nameFromId(id);
  return display.replace(/^Claude\s+(?=[A-Za-z])/, "") || shortModelId(id);
}
