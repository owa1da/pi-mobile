// POSIX sh scripts for the remote channel. Every path and payload is shell-quoted; the action
// JSON travels base64-encoded and is written with tmp + mv exactly as the contract's App side
// says, so forge never reads a half-written inbox file. Output lines are framed by a nonce.

import { shQuote } from "@/host/commands";
import { CATALOG_MAX_BYTES } from "./command-catalog";
import { isHostPanel, PANEL_MAX_BYTES, type HostPanel } from "./panel-snapshot";

/** Display-only files, read with the same bounded trusted exec as host command discovery. */
export function readPanelSnapshotScript(agentDir: string, name: HostPanel, tag: string): string {
  assertNonce(tag);
  if (!isHostPanel(name)) throw new Error("bad host panel");
  const file = shQuote(`${agentDir.replace(/\/+$/, "")}/forge/remote/${name}.json`);
  return [
    `f=${file}`,
    `if [ -f "$f" ]; then printf '%s SNAPSHOT\\n' ${tag}; head -c ${PANEL_MAX_BYTES[name] + 1} "$f" 2>/dev/null; printf '\\n%s END\\n' ${tag};`,
    `else printf '%s NONE\\n' ${tag}; fi`,
    "",
  ].join("\n");
}

/** Bounded even if the file grows mid-read; cap + 1 lets the parser reject oversized files. */
export function readCommandCatalogScript(agentDir: string, tag: string): string {
  assertNonce(tag);
  const file = shQuote(`${agentDir.replace(/\/+$/, "")}/forge/remote/commands.json`);
  return [
    `f=${file}`,
    `if [ -f "$f" ]; then printf '%s CATALOG\\n' ${tag}; head -c ${CATALOG_MAX_BYTES + 1} "$f" 2>/dev/null; printf '\\n%s END\\n' ${tag};`,
    `else printf '%s NONE\\n' ${tag}; fi`,
    "",
  ].join("\n");
}

/** Inbox/result file names: the nonce is ours, but it still never reaches a path unchecked. */
export const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad pid ${String(pid)}`);
}

export function assertNonce(nonce: string): void {
  if (!NONCE_RE.test(nonce)) throw new Error(`bad nonce ${nonce}`);
}

/** `<agentDir>/forge/remote/<pid>` (agentDir without a trailing slash). */
export function remoteDir(agentDir: string, pid: number): string {
  assertPid(pid);
  return `${agentDir.replace(/\/+$/, "")}/forge/remote/${pid}`;
}

/** Prints `<tag> STATE` then the file and `<tag> END`, or `<tag> NONE` when there is no state. */
export function readStateScript(agentDir: string, pid: number, tag: string): string {
  assertNonce(tag);
  const file = shQuote(`${remoteDir(agentDir, pid)}/state.json`);
  return [
    `f=${file}`,
    `if [ -f "$f" ]; then printf '%s STATE\\n' ${tag}; cat "$f" 2>/dev/null; printf '\\n%s END\\n' ${tag};`,
    `else printf '%s NONE\\n' ${tag}; fi`,
    "",
  ].join("\n");
}

/**
 * Prints the result `results/<nonce>.json` once it is whole (ends in `}`), and removes it:
 * `<tag> RESULT`, the JSON, `<tag> END`. Polls up to `polls` times `interval` seconds first
 * (a fractional sleep where the host's sleep takes one, else whole seconds); else `<tag> PENDING`.
 */
function pollResultLines(
  dir: string,
  nonce: string,
  tag: string,
  polls: number,
  interval: string,
): string[] {
  return [
    `r=${shQuote(`${dir}/results/${nonce}.json`)}`,
    `i=0`,
    `while :; do`,
    `  if [ -f "$r" ]; then`,
    `    c=$(cat "$r" 2>/dev/null)`,
    `    case "$c" in *"}") printf '%s RESULT\\n%s\\n%s END\\n' ${tag} "$c" ${tag}; rm -f "$r"; exit 0;; esac`,
    `  fi`,
    `  i=$((i+1)); [ "$i" -gt ${polls} ] && break`,
    `  sleep ${interval} 2>/dev/null || sleep 1`,
    `done`,
    `printf '%s PENDING\\n' ${tag}`,
  ];
}

export interface SendScriptInput {
  agentDir: string;
  pid: number;
  nonce: string;
  /** base64 of the inbox action JSON. */
  payloadB64: string;
  tag: string;
  /** Polls for the result before returning PENDING. */
  polls: number;
  /** Seconds between polls, as sleep's argument ("0.2"). */
  interval: string;
}

/**
 * Writes the inbox file the contract's way and waits briefly for its result:
 * `d=<agentDir>/forge/remote/<pid>/inbox; [ -d "$d" ] && printf %s "$B64" | base64 -d > "$d/.$N.tmp" && mv "$d/.$N.tmp" "$d/$N.json"`.
 * Prints `<tag> NOINBOX` (no channel), `<tag> WRITEFAIL`, or `<tag> SENT` then the poll's lines.
 */
export function sendScript(input: SendScriptInput): string {
  assertNonce(input.nonce);
  assertNonce(input.tag);
  if (!/^[A-Za-z0-9+/=]*$/.test(input.payloadB64)) throw new Error("payload is not base64");
  if (!/^\d+(\.\d+)?$/.test(input.interval)) throw new Error(`bad interval ${input.interval}`);
  const dir = remoteDir(input.agentDir, input.pid);
  const n = input.nonce;
  return [
    `d=${shQuote(`${dir}/inbox`)}`,
    `B64=${shQuote(input.payloadB64)}`,
    `N=${shQuote(n)}`,
    `if [ ! -d "$d" ]; then printf '%s NOINBOX\\n' ${input.tag}; exit 0; fi`,
    `if printf %s "$B64" | base64 -d > "$d/.$N.tmp" && mv "$d/.$N.tmp" "$d/$N.json"; then`,
    `  printf '%s SENT\\n' ${input.tag}`,
    `else rm -f "$d/.$N.tmp"; printf '%s WRITEFAIL\\n' ${input.tag}; exit 0; fi`,
    ...pollResultLines(dir, n, input.tag, input.polls, input.interval),
    "",
  ].join("\n");
}

/** Waits for a result already written for (see sendScript). */
export function pollScript(
  agentDir: string,
  pid: number,
  nonce: string,
  tag: string,
  polls: number,
  interval: string,
): string {
  assertNonce(nonce);
  assertNonce(tag);
  if (!/^\d+(\.\d+)?$/.test(interval)) throw new Error(`bad interval ${interval}`);
  const dir = remoteDir(agentDir, pid);
  return [
    `if [ ! -d ${shQuote(dir)} ]; then printf '%s GONE\\n' ${tag}; exit 0; fi`,
    ...pollResultLines(dir, nonce, tag, polls, interval),
    "",
  ].join("\n");
}

/** Removes an inbox file nobody read (give-up path), so a late forge never acts on it. */
export function withdrawScript(agentDir: string, pid: number, nonce: string, tag: string): string {
  assertNonce(nonce);
  assertNonce(tag);
  const file = shQuote(`${remoteDir(agentDir, pid)}/inbox/${nonce}.json`);
  return `if rm ${file} 2>/dev/null; then printf '%s WITHDRAWN\\n' ${tag}; else printf '%s TAKEN\\n' ${tag}; fi\n`;
}

/** The text between `<tag> <START>` and `<tag> END`, else undefined. */
export function framed(stdout: string, tag: string, start: string): string | undefined {
  const lines = stdout.split("\n");
  const from = lines.indexOf(`${tag} ${start}`);
  if (from < 0) return undefined;
  const to = lines.indexOf(`${tag} END`, from + 1);
  if (to < 0) return undefined;
  return lines.slice(from + 1, to).join("\n");
}

/** The status words this script printed (`<tag> WORD`). */
export function statuses(stdout: string, tag: string): string[] {
  const prefix = `${tag} `;
  return stdout
    .split("\n")
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.slice(prefix.length).trim());
}
