// Host command builders. Every script is POSIX sh; every value is single-quoted with shQuote, and
// every tmux argument goes through tmuxArg (and tmuxFormatLiteral where tmux expands formats).
// Payloads (prompts) travel on stdin, base64-encoded, never in argv.
//
// tmux 3.6 facts these builders rely on (verified on an isolated server):
// - an argument ending in ";" is a command separator; "\;" at the end yields a literal ";".
// - `new-window -c` expands formats ("##" is a literal "#"); `-e` values and the command argv are not expanded.
// - `display-message -p -t <missing pane>` exits 0 with empty output: compare the output, never the status.

import { base64EncodeText } from "./encoding";

export function shQuote(value: string): string {
  if (value.includes("\0")) throw new Error("NUL byte in shell argument");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** An argument tmux would otherwise read as a trailing command separator. */
export function tmuxArg(value: string): string {
  return value.endsWith(";") ? `${value.slice(0, -1)}\\;` : value;
}

/** A literal for a tmux option that expands #{formats} (new-window -c, -n). */
export function tmuxFormatLiteral(value: string): string {
  return value.replace(/#/g, "##");
}

/** shQuote(tmuxArg(value)): the usual way to put a value on a tmux command line. */
export function tq(value: string): string {
  return shQuote(tmuxArg(value));
}

/**
 * Run a POSIX sh script from whatever login shell sshd starts (bash, zsh, fish, dash, tcsh):
 * the outer command holds only `sh`, single quotes and base64, which every one of them reads alike.
 * The script's stdin is the channel's stdin.
 */
export function wrapForAnyShell(script: string): string {
  return `sh -c 'eval "$(printf %s ${base64EncodeText(script)} | base64 -d)"'`;
}

/**
 * wrapForAnyShell, with the script run under the host's `timeout` (coreutils/busybox) when it has
 * one: a mutating script (send, start, abort) is killed on the host before the phone's exec
 * timeout fires, so a timed-out send can never paste late. Exit 124/137 = killed by the timeout.
 */
export function wrapWithHostTimeout(script: string, seconds: number): string {
  const s = Math.max(1, Math.floor(seconds));
  const inner = `S=$(printf %s ${base64EncodeText(script)} | base64 -d)
if command -v timeout >/dev/null 2>&1; then
  if timeout -k 2 1 true >/dev/null 2>&1; then exec timeout -k 2 ${s} sh -c "$S"; fi
  exec timeout ${s} sh -c "$S"
fi
eval "$S"
`;
  return wrapForAnyShell(inner);
}

export function makeNonce(): string {
  let out = "";
  for (let i = 0; i < 16; i++) out += Math.floor(Math.random() * 16).toString(16);
  return `PIM${out}`;
}

/** forge's window name rule (handoff.ts windowName). */
export function windowName(prompt: string): string {
  const words = prompt
    .replace(/^\/skill:/, "")
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Za-z0-9._-]/g, ""))
    .filter(Boolean)
    .slice(0, 3);
  const name = words.join("-").slice(0, 20).replace(/-+$/, "");
  return name || "pi";
}

/** Shared sh helpers: a pid's procStart check against its registry record. */
const ALIVE_FN = `
alive() { # $1 pid, $2 record file
  kill -0 "$1" 2>/dev/null || return 1
  if [ -r "/proc/$1/stat" ]; then
    _ps=$(sed -n 's/.*"procStart":"\\([0-9]*\\)".*/\\1/p' "$2" 2>/dev/null | head -n 1)
    _cs=$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20)
    if [ -n "$_ps" ] && [ -n "$_cs" ] && [ "$_ps" != "$_cs" ]; then return 1; fi
  fi
  return 0
}
`;

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

export interface ProbeScriptInput {
  nonce: string;
  agentDirOverride?: string;
  socketOverride?: string;
  /** Skip the login shell (tests): search the exec PATH only. */
  useLoginShell: boolean;
}

/** Prints `<nonce> key=value` lines. */
export function probeScript(input: ProbeScriptInput): string {
  const N = input.nonce;
  return `
N=${shQuote(N)}
AO=${shQuote(input.agentDirOverride ?? "")}
SO=${shQuote(input.socketOverride ?? "")}
USELOGIN=${input.useLoginShell ? 1 : 0}
out() { printf '%s %s=%s\\n' "$N" "$1" "$2"; }
LSHELL=\${SHELL:-/bin/sh}
loginenv() {
  if command -v timeout >/dev/null 2>&1; then timeout 15 "$LSHELL" $1 -c "echo $N-ENV; env" </dev/null 2>/dev/null
  else "$LSHELL" $1 -c "echo $N-ENV; env" </dev/null 2>/dev/null; fi
}
ENVOUT=
getv() { printf '%s\\n' "$ENVOUT" | sed -n "/^$N-ENV\\$/,\\$p" | sed -n "s/^$1=//p" | head -n 1; }
findin() { (PATH="$LPATH:$PATH"; command -v "$1") 2>/dev/null; }
LPATH=
if [ "$USELOGIN" = 1 ]; then
  ENVOUT=$(loginenv -l); LPATH=$(getv PATH)
  if [ -z "$(findin node)" ] || [ -z "$(findin pi)" ] || [ -z "$(findin tmux)" ]; then
    E2=$(loginenv '-l -i'); if [ -n "$E2" ]; then ENVOUT=$E2; P2=$(getv PATH); [ -n "$P2" ] && LPATH=$P2; fi
  fi
fi
[ -n "$LPATH" ] || LPATH=$PATH
realp() { readlink -f "$1" 2>/dev/null || realpath "$1" 2>/dev/null || printf '%s\\n' "$1"; }
NODE=$(findin node); [ -n "$NODE" ] && NODE=$(realp "$NODE")
PI=$(findin pi); PIKIND=exec
if [ -n "$PI" ]; then
  PI=$(realp "$PI")
  case "$PI" in *.js|*.mjs|*.cjs) PIKIND=node;; esac
  if [ "$PIKIND" = exec ] && head -n 1 "$PI" 2>/dev/null | grep -q '^#!.*node'; then PIKIND=node; fi
fi
TM=$(findin tmux); TV=
[ -n "$TM" ] && TV=$("$TM" -V 2>/dev/null)
LAD=$(getv PI_CODING_AGENT_DIR)
A=$AO; [ -n "$A" ] || A=$LAD; [ -n "$A" ] || A=\${PI_CODING_AGENT_DIR:-}; [ -n "$A" ] || A="$HOME/.pi/agent"
case "$A" in "~") A=$HOME;; "~/"*) A="$HOME/\${A#\\~/}";; esac
FORGE=0
if [ -d "$A/forge/procs" ]; then FORGE=1
elif [ -f "$A/settings.json" ] && grep -q 'forge' "$A/settings.json" 2>/dev/null; then FORGE=1; fi
SOCK=$SO
if [ -z "$SOCK" ]; then
  for f in "$A"/forge/procs/*.json; do
    [ -f "$f" ] || continue
    s=$(sed -n 's/.*"tmux":{"socket":"\\([^"\\\\]*\\)".*/\\1/p' "$f" | head -n 1)
    [ -n "$s" ] && [ -S "$s" ] && printf '%s\\n' "$s"
  done > "\${TMPDIR:-/tmp}/pim-sock-$$" 2>/dev/null
  SOCK=$(sort "\${TMPDIR:-/tmp}/pim-sock-$$" 2>/dev/null | uniq -c | sort -rn | head -n 1 | sed 's/^ *[0-9]* //')
  rm -f "\${TMPDIR:-/tmp}/pim-sock-$$"
fi
if [ -z "$SOCK" ]; then TD=$(getv TMUX_TMPDIR); [ -n "$TD" ] || TD=\${TMUX_TMPDIR:-/tmp}; SOCK="$TD/tmux-$(id -u)/default"; fi
out host "$(uname -n 2>/dev/null || hostname)"
out home "$HOME"
out now "$(date +%s)"
out node "$NODE"
out pi "$PI"
out pikind "$PIKIND"
out tmux "$TM"
out tmuxv "$TV"
out agent "$A"
out forge "$FORGE"
out socket "$SOCK"
out lpath "$LPATH"
out env_PI_CODING_AGENT_DIR "$LAD"
out env_PI_CODING_AGENT_SESSION_DIR "$(getv PI_CODING_AGENT_SESSION_DIR)"
out env_PI_SKIP_VERSION_CHECK "$(getv PI_SKIP_VERSION_CHECK)"
if [ -n "$ENVOUT" ]; then LOCS=$(printf '%s\\n' "$ENVOUT" | sed -n "/^$N-ENV\\$/,\\$p"); else LOCS=$(env); fi
printf '%s\\n' "$LOCS" | grep -E '^(LANG|LC_[A-Z_]+)=' | while IFS= read -r l; do out loc "$l"; done
`;
}

// ---------------------------------------------------------------------------
// listing (one round trip per dashboard refresh)
// ---------------------------------------------------------------------------

/**
 * Output, each header line prefixed with the nonce:
 *   H <host> <now s>, B <bootId>, P <1|0 /proc exists>,
 *   L <pid> <procStart|-|X|K> <mtime s> <sessionFile exists 1|0|?> + record text,
 *   E + ended record text, R + removal marker text, C + forge.json text, Z.
 * procStart: field 22 of /proc/<pid>/stat; "X" no such process; "K" alive without /proc; "-" unreadable.
 */
export function listingScript(procsDir: string, configFile: string, nonce: string): string {
  return `
N=${shQuote(nonce)}; D=${shQuote(procsDir)}; C=${shQuote(configFile)}
printf '%s H %s %s\\n' "$N" "$(uname -n 2>/dev/null || hostname)" "$(date +%s)"
printf '%s B %s\\n' "$N" "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
if [ -r /proc/self/stat ]; then HP=1; else HP=0; fi
printf '%s P %s\\n' "$N" "$HP"
mt() { stat -c %Y "$1" 2>/dev/null || date -r "$1" +%s 2>/dev/null || echo 0; }
for f in "$D"/*.json; do
  [ -f "$f" ] || continue
  b=\${f##*/}; p=\${b%.json}
  case "$p" in ''|*[!0-9]*) continue;; esac
  if [ "$HP" = 1 ]; then
    if [ -r "/proc/$p/stat" ]; then st=$(sed 's/.*) //' "/proc/$p/stat" 2>/dev/null | cut -d' ' -f20); [ -n "$st" ] || st=-; else st=X; fi
  else
    if kill -0 "$p" 2>/dev/null || ps -p "$p" >/dev/null 2>&1; then st=K; else st=X; fi
  fi
  fe='?'
  sf=$(sed -n 's/.*"sessionFile":"\\([^"\\\\]*\\)".*/\\1/p' "$f" 2>/dev/null | head -n 1)
  if [ -n "$sf" ]; then if [ -f "$sf" ]; then fe=1; else fe=0; fi; fi
  printf '%s L %s %s %s %s\\n' "$N" "$p" "$st" "$(mt "$f")" "$fe"
  head -c 65536 "$f"; echo
done
for f in "$D"/ended/*.json; do
  [ -f "$f" ] || continue
  printf '%s E\\n' "$N"; head -c 65536 "$f"; echo
done
for f in "$D"/removed/*.json; do
  [ -f "$f" ] || continue
  printf '%s R\\n' "$N"; head -c 4096 "$f"; echo
done
if [ -f "$C" ]; then printf '%s C\\n' "$N"; head -c 262144 "$C"; echo; fi
printf '%s Z\\n' "$N"
`;
}

// ---------------------------------------------------------------------------
// chat reads
// ---------------------------------------------------------------------------

/**
 * Header `<nonce> D <mode fresh|inc> <size> <inode> <start>` then base64 of the bytes from
 * <start> (0-based), then `<nonce> Z`; or `<nonce> MISSING`.
 * inc: the byte before <offset> must be a newline and the inode unchanged, else fresh.
 * Bytes from a non-zero start begin inside a line (inc: the newline itself): the reader drops
 * through the first newline.
 */
export function chatReadScript(
  file: string,
  offset: number,
  inode: string,
  cap: number,
  nonce: string,
): string {
  return `
F=${shQuote(file)}; O=${Math.max(0, Math.floor(offset))}; I=${shQuote(inode)}; CAP=${Math.max(1024, Math.floor(cap))}; N=${shQuote(nonce)}
if [ ! -f "$F" ]; then printf '%s MISSING\\n' "$N"; exit 0; fi
S=$(wc -c < "$F" | tr -d ' ')
IN=$(stat -c %i "$F" 2>/dev/null || ls -id "$F" 2>/dev/null | awk '{print $1}')
M=inc
if [ "$O" -le 0 ] || [ "$I" != "$IN" ] || [ "$O" -gt "$S" ]; then M=fresh
elif [ "$(tail -c +"$O" "$F" | head -c 1 | wc -l | tr -d ' ')" != 1 ]; then M=fresh; fi
if [ "$M" = fresh ]; then
  if [ "$S" -gt "$CAP" ]; then ST=$((S - CAP)); else ST=0; fi; RL=$CAP
else
  ST=$((O - 1)); RL=$((CAP + 1))
fi
printf '%s D %s %s %s %s\\n' "$N" "$M" "$S" "$IN" "$ST"
if [ "$ST" -lt "$S" ]; then tail -c +$((ST + 1)) "$F" | head -c "$RL" | base64; fi
printf '%s Z\\n' "$N"
`;
}

/**
 * A line too long for one read: `<nonce> G <length incl. newline> <size> <ends with newline 1|0>`,
 * then base64 of its first <prefix> bytes, then `<nonce> Z`.
 */
export function longLineScript(
  file: string,
  position: number,
  prefix: number,
  nonce: string,
): string {
  return `
F=${shQuote(file)}; P=${Math.max(0, Math.floor(position))}; N=${shQuote(nonce)}
if [ ! -f "$F" ]; then printf '%s MISSING\\n' "$N"; exit 0; fi
L=$(tail -c +$((P + 1)) "$F" | head -n 1 | wc -c | tr -d ' ')
S=$(wc -c < "$F" | tr -d ' ')
E=$((P + L)); NL=0
if [ "$E" -gt 0 ] && [ "$(tail -c +"$E" "$F" | head -c 1 | wc -l | tr -d ' ')" = 1 ]; then NL=1; fi
printf '%s G %s %s %s\\n' "$N" "$L" "$S" "$NL"
tail -c +$((P + 1)) "$F" | head -c ${Math.max(256, Math.floor(prefix))} | base64
printf '%s Z\\n' "$N"
`;
}

// ---------------------------------------------------------------------------
// tmux: start / send / abort
// ---------------------------------------------------------------------------

export interface TmuxTarget {
  tmux: string;
  socket: string;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/**
 * pi's prompt editor as tmux's `capture-pane -p` shows it (pi-tui's Editor, verified on pi 1.0.0
 * with forge, fullscreen and inline): a rule of `─` above and below the input lines, the footer
 * under it. Empty editor: one blank line between the rules (the cursor is an inverse space, a
 * blank cell in plain capture). A draft: its lines (or a `[paste #1 …]` marker) between them. A
 * long draft puts `↑ N more` into a rule; the rule still holds a run of `─`.
 * `frame <pane>` prints EMPTY, DRAFT or NOFRAME (no editor on screen: a dialog, the sessions
 * page, or pi has not drawn yet). The last two rule lines on the screen frame the editor; anything
 * else in between counts as a draft, so an unknown layout refuses rather than glues.
 * pi-tui enables bracketed paste (`?2004h`) before its first render and tmux applies pane output
 * in order, so a drawn editor also means tmux will bracket a paste (tmux 3.6 has no format for it).
 */
const FRAME_FN = `
frame() {
  "$T" -S "$S" capture-pane -p -t "$1" 2>/dev/null | awk -v R='────────' '
    index($0, R) { n++; prev = last; last = NR }
    { line[NR] = $0 }
    END {
      if (n < 2) { print "NOFRAME"; exit }
      for (i = prev + 1; i < last; i++) {
        t = line[i]
        if (i == prev + 1) sub(/^❯ /, "", t)
        gsub(/[[:space:]]/, "", t)
        if (t != "") { print "DRAFT"; exit }
      }
      print "EMPTY"
    }'
}
`;

/** Prints EMPTY, DRAFT or NOFRAME for a pane (frame() alone; tests and diagnostics). */
export function paneFrameScript(input: TmuxTarget & { pane: string }): string {
  return `T=${shQuote(input.tmux)}; S=${shQuote(input.socket)}
${FRAME_FN}
frame ${shQuote(input.pane)}
`;
}

/** `livepid <procs dir> <sessionId>`: the pid of an alive live record of this host naming the session. */
const LIVEPID_FN = `
livepid() {
  _h=$(uname -n 2>/dev/null || hostname); _b=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)
  for _f in "$1"/*.json; do
    [ -f "$_f" ] || continue
    _p=\${_f##*/}; _p=\${_p%.json}
    case "$_p" in ''|*[!0-9]*) continue;; esac
    grep -qF "\\"sessionId\\":\\"$2\\"" "$_f" 2>/dev/null || continue
    grep -qF "\\"host\\":\\"$_h\\"" "$_f" 2>/dev/null || continue
    if [ -n "$_b" ] && grep -qF '"bootId":"' "$_f" && ! grep -qF "\\"bootId\\":\\"$_b\\"" "$_f"; then continue; fi
    if alive "$_p" "$_f"; then printf '%s\\n' "$_p"; return 0; fi
  done
  return 1
}
`;

/** `deliver <pane> <pid>`: stdin (base64) as one bracketed paste, then Enter. */
const DELIVER_FN = `
deliver() {
  _B="pim-$$-$2"
  if base64 -d | "$T" -S "$S" load-buffer -b "$_B" - && "$T" -S "$S" paste-buffer -p -r -d -b "$_B" -t "$1" && sleep 0.15 && "$T" -S "$S" send-keys -t "$1" Enter; then return 0; fi
  "$T" -S "$S" delete-buffer -b "$_B" 2>/dev/null
  return 1
}
`;

/**
 * tmux runs a one-element command through `$SHELL -c` (a path with spaces would split, and the
 * user's shell may be fish): give it an argv of more than one element, which tmux execs directly.
 * `exec` keeps the pane pid the program's pid.
 */
export function tmuxCommandArgv(argv: string[]): string[] {
  if (argv.length !== 1) return argv;
  return ["/bin/sh", "-c", 'exec "$0"', argv[0]!];
}

export interface StartScriptInput extends TmuxTarget {
  nonce: string;
  cwd: string;
  /** Use $HOME when cwd is gone (a resumed session's folder was removed). */
  cwdFallbackHome: boolean;
  windowName: string;
  /** NAME=value pairs for `-e`. */
  env: string[];
  /**
   * NAME=value pairs (the login shell's PATH, LANG and LC_*) for a tmux server this call starts
   * (none existed): its environment at start and its global environment, so later windows get them too.
   */
  serverEnv?: string[];
  /** node + cli + args, as argv. */
  argv: string[];
  /** A resume: refuse (`ERR live <pid>`) while an alive live record names this session. */
  refuseLive?: { procsDir: string; sessionId: string };
  /**
   * Wait for the new pi's registry record (procsDir/<pid>.json), optionally naming this session,
   * then (unless soft) for its empty prompt editor. soft: report `NOTREADY` instead of an error.
   */
  waitReady?: { procsDir: string; sessionId?: string; timeoutMs: number; soft?: boolean };
  /** Paste stdin (base64) into the new pane once ready, then Enter. */
  pasteStdin?: boolean;
  /** Refuse (ERR file) unless this file exists (a resumed session's file). */
  requireFile?: string;
}

function setEnvLine(pair: string): string {
  const eq = pair.indexOf("=");
  if (eq <= 0) return "";
  return `"$T" -S "$S" set-environment -g ${tq(pair.slice(0, eq))} ${tq(pair.slice(eq + 1))} 2>/dev/null`;
}

function waitBlock(wait: NonNullable<StartScriptInput["waitReady"]>): string {
  const sid = wait.sessionId && SAFE_ID.test(wait.sessionId) ? wait.sessionId : "";
  return `
PANE=$(printf '%s' "$OUT" | cut -d' ' -f2); PID=$(printf '%s' "$OUT" | cut -d' ' -f3)
R=${shQuote(wait.procsDir)}/$PID.json; SID=${shQuote(sid)}; SOFT=${wait.soft ? 1 : 0}
i=0; MAX=${Math.max(1, Math.ceil(wait.timeoutMs / 100))}; reg=0; ready=0; fr=
while [ "$i" -lt "$MAX" ]; do
  if [ "$reg" = 0 ] && [ -f "$R" ] && { [ -z "$SID" ] || grep -qF "\\"sessionId\\":\\"$SID\\"" "$R"; }; then reg=1; fi
  if [ "$reg" = 1 ]; then
    if [ "$SOFT" = 1 ]; then ready=1; break; fi
    fr=$(frame "$PANE"); if [ "$fr" = EMPTY ]; then ready=1; break; fi
  fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.1; i=$((i + 1))
done
if [ "$ready" != 1 ]; then
  if ! kill -0 "$PID" 2>/dev/null; then printf '%s ERR died\\n' "$N"
  elif [ "$SOFT" = 1 ]; then printf '%s NOTREADY\\n' "$N"
  elif [ "$fr" = DRAFT ]; then printf '%s ERR draft\\n' "$N"
  else printf '%s ERR timeout\\n' "$N"; fi
  exit 0
fi
alive "$PID" "$R" || { printf '%s ERR died\\n' "$N"; exit 0; }
printf '%s READY\\n' "$N"
`;
}

/**
 * Output: `<nonce> OK <window> <pane> <pid> <session>` (then `<nonce> READY|NOTREADY`/`<nonce> PASTED`),
 * or `<nonce> ERR <reason>` with reason live <pid>|file|cwd|tmux|timeout|died|draft|paste. The OK
 * fields are space-separated with the free-form session name last: tmux prints control characters
 * such as tabs as `_` in format output when the client is not UTF-8 (no LANG over SSH, no -u).
 */
export function startScript(input: StartScriptInput): string {
  const fmt = "#{window_id} #{pane_id} #{pane_pid} #{session_name}";
  const common = [
    "-d",
    "-P",
    "-F",
    shQuote(fmt),
    "-c",
    '"$CWT"',
    "-n",
    tq(tmuxFormatLiteral(input.windowName)),
    ...input.env.flatMap((pair) => ["-e", tq(pair)]),
  ].join(" ");
  const argv = tmuxCommandArgv(input.argv).map(tq).join(" ");
  const serverEnv = input.serverEnv ?? [];
  const serverPrefix = serverEnv.length > 0 ? `env ${serverEnv.map(shQuote).join(" ")} ` : "";
  const serverE = serverEnv.map((pair) => `-e ${tq(pair)}`).join(" ");
  const setEnv = serverEnv.map(setEnvLine).filter(Boolean).join("\n  ");
  const wait = input.waitReady;
  const refuse =
    input.refuseLive && SAFE_ID.test(input.refuseLive.sessionId) ? input.refuseLive : undefined;
  return `
N=${shQuote(input.nonce)}; T=${shQuote(input.tmux)}; S=${shQuote(input.socket)}; CW=${shQuote(input.cwd)}
CWT=${tq(tmuxFormatLiteral(input.cwd))}; RF=${shQuote(input.requireFile ?? "")}
${ALIVE_FN}${wait ? FRAME_FN : ""}${input.pasteStdin ? DELIVER_FN : ""}${refuse ? LIVEPID_FN : ""}
${
  refuse
    ? `if LP=$(livepid ${shQuote(refuse.procsDir)} ${shQuote(refuse.sessionId)}); then printf '%s ERR live %s\\n' "$N" "$LP"; exit 0; fi`
    : ""
}
if [ -n "$RF" ] && [ ! -f "$RF" ]; then printf '%s ERR file\\n' "$N"; exit 0; fi
if [ ! -d "$CW" ]; then
  if [ ${input.cwdFallbackHome ? 1 : 0} = 1 ]; then
    CW=$HOME; CWT=$(printf '%s' "$HOME" | sed 's/#/##/g')
    case "$CWT" in *';') CWT="\${CWT%;}\\;";; esac
  else printf '%s ERR cwd\\n' "$N"; exit 0; fi
fi
SD=\${S%/*}; [ -n "$SD" ] && [ ! -d "$SD" ] && (umask 077; mkdir -p "$SD")
TGT=$("$T" -S "$S" list-sessions -F '#{session_last_attached} #{session_id} #{session_name}' 2>/dev/null | grep -v ' pim-' | sort -rn | head -n 1 | cut -d' ' -f2)
if [ -n "$TGT" ]; then
  OUT=$("$T" -S "$S" new-window ${common} -t "$TGT:" -- ${argv} 2>&1) || { printf '%s ERR tmux %s\\n' "$N" "$OUT"; exit 0; }
else
  OUT=$(${serverPrefix}"$T" -S "$S" new-session ${common} ${serverE} -s pi -- ${argv} 2>&1) || { printf '%s ERR tmux %s\\n' "$N" "$OUT"; exit 0; }
  ${setEnv}
fi
printf '%s OK %s\\n' "$N" "$OUT"
${wait ? waitBlock(wait) : ""}${
    wait && input.pasteStdin
      ? `if deliver "$PANE" "$PID"; then printf '%s PASTED\\n' "$N"; else printf '%s ERR paste\\n' "$N"; fi`
      : ""
  }
`;
}

export interface PaneScriptInput extends TmuxTarget {
  nonce: string;
  pane: string;
  pid: number;
  sessionId?: string;
  procsDir: string;
  /** A pi that was just started (a joined resume): wait this long for its record and editor. */
  waitMs?: number;
}

/** Shared guard: the record exists, is this process and session, and names the pane. */
function paneGuard(input: PaneScriptInput): string {
  const sid = input.sessionId && SAFE_ID.test(input.sessionId) ? input.sessionId : "";
  const waitTicks = Math.ceil((input.waitMs ?? 0) / 100);
  return `
N=${shQuote(input.nonce)}; T=${shQuote(input.tmux)}; S=${shQuote(input.socket)}; P=${shQuote(input.pane)}
PID=${Math.floor(input.pid)}; R=${shQuote(input.procsDir)}/$PID.json; SID=${shQuote(sid)}
${ALIVE_FN}
i=0
while [ "$i" -lt ${waitTicks} ]; do
  if [ -f "$R" ] && { [ -z "$SID" ] || grep -qF "\\"sessionId\\":\\"$SID\\"" "$R"; }; then break; fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.1; i=$((i + 1))
done
if [ ! -f "$R" ] || ! alive "$PID" "$R"; then printf '%s CLOSED\\n' "$N"; exit 0; fi
if [ -n "$SID" ] && ! grep -qF "\\"sessionId\\":\\"$SID\\"" "$R"; then printf '%s CLOSED\\n' "$N"; exit 0; fi
RP=$(sed -n 's/.*"tmux":{"socket":"\\([^"\\\\]*\\)","pane":"\\(%[0-9]*\\)".*/\\1\t\\2/p' "$R" | head -n 1)
if [ -n "$RP" ]; then S=\${RP%%\t*}; P=\${RP#*\t}; fi
case "$P" in %[0-9]*) ;; *) printf '%s NOTMUX\\n' "$N"; exit 0;; esac
INFO=$("$T" -S "$S" display-message -p -t "$P" '#{pane_id} #{pane_in_mode}' 2>/dev/null)
case "$INFO" in "$P "*) ;; *) printf '%s GONE\\n' "$N"; exit 0;; esac
`;
}

/**
 * Output: `<nonce> OK|CLOSED|NOTMUX|GONE|WAITING|BUSY|DRAFT|NOPROMPT|ERR`. stdin: base64 of the prompt.
 * Never touches a draft: a non-empty editor is refused (DRAFT), and so is a screen without pi's
 * editor (NOPROMPT), after a short wait for pi to clear or draw it.
 */
export function sendScript(input: PaneScriptInput): string {
  const frameTicks = Math.max(20, Math.ceil((input.waitMs ?? 0) / 100));
  return `${paneGuard(input)}${FRAME_FN}${DELIVER_FN}
gate() {
  if grep -q '"state":"waiting"' "$R"; then echo WAITING; return; fi
  _I=$("$T" -S "$S" display-message -p -t "$P" '#{pane_id} #{pane_in_mode}' 2>/dev/null)
  case "$_I" in "$P "*) ;; *) echo GONE; return;; esac
  if [ "\${_I#* }" != 0 ]; then echo BUSY; return; fi
  frame "$P"
}
i=0; G=$(gate)
while [ "$G" != EMPTY ] && [ "$i" -lt ${frameTicks} ]; do
  case "$G" in WAITING|GONE|BUSY) break;; DRAFT) [ "$i" -ge 5 ] && break;; esac
  sleep 0.1; i=$((i + 1)); G=$(gate)
done
case "$G" in
  EMPTY) ;;
  NOFRAME) printf '%s NOPROMPT\\n' "$N"; exit 0;;
  *) printf '%s %s\\n' "$N" "$G"; exit 0;;
esac
if deliver "$P" "$PID"; then printf '%s OK\\n' "$N"; else printf '%s ERR\\n' "$N"; fi
`;
}

/** Output: `<nonce> OK|IDLE|CLOSED|NOTMUX|GONE|BUSY|ERR`: one Escape, only while the record says working. */
export function abortScript(input: PaneScriptInput): string {
  return `${paneGuard(input)}
grep -q '"state":"working"' "$R" || { printf '%s IDLE\\n' "$N"; exit 0; }
[ "\${INFO#* }" = 0 ] || { printf '%s BUSY\\n' "$N"; exit 0; }
if "$T" -S "$S" send-keys -t "$P" Escape; then printf '%s OK\\n' "$N"; else printf '%s ERR\\n' "$N"; fi
`;
}

/** The fields of startScript's `OK` line: `<window> <pane> <pid> <session name…>`. */
export function parseStartedLine(
  line: string,
): { tmuxSession: string; windowId: string; pane: string; pid: number } | undefined {
  const match = /^(@\d+) (%\d+) (\d+) (.*)$/.exec(line.trim());
  if (!match) return undefined;
  return { windowId: match[1]!, pane: match[2]!, pid: Number(match[3]), tmuxSession: match[4]! };
}

/** `test -f`, `test -d` on the host: prints `<nonce> <f|-> <d|->`. */
export function existsScript(file: string, dir: string, nonce: string): string {
  return `F=${shQuote(file)}; D=${shQuote(dir)}
a=-; b=-; [ -f "$F" ] && a=f; [ -d "$D" ] && b=d
printf '%s %s %s\\n' ${shQuote(nonce)} "$a" "$b"
`;
}
