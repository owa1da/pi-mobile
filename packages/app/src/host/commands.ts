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
// tmux: start / send / abort / attach
// ---------------------------------------------------------------------------

export interface TmuxTarget {
  tmux: string;
  socket: string;
}

export interface StartScriptInput extends TmuxTarget {
  nonce: string;
  cwd: string;
  /** Use $HOME when cwd is gone (a resumed session's folder was removed). */
  cwdFallbackHome: boolean;
  windowName: string;
  /** NAME=value pairs for `-e`. */
  env: string[];
  /** PATH for a tmux server this call starts (none existed): the login shell's. */
  serverPath?: string;
  /** node + cli + args, as argv. */
  argv: string[];
  /** Wait for the new pi's registry record (procsDir/<pid>.json), optionally naming this session. */
  waitReady?: { procsDir: string; sessionId?: string; timeoutMs: number };
  /** Paste stdin (base64) into the new pane once ready, then Enter. */
  pasteStdin?: boolean;
  /** Refuse (ERR file) unless this file exists (a resumed session's file). */
  requireFile?: string;
}

/**
 * Output: `<nonce> OK <session>\t<window>\t<pane>\t<pid>` (then `<nonce> READY`/`<nonce> PASTED`),
 * or `<nonce> ERR <reason>` with reason file|cwd|tmux|timeout|died|paste.
 */
export function startScript(input: StartScriptInput): string {
  const fmt = "#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}";
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
  const argv = input.argv.map(tq).join(" ");
  const serverEnv = input.serverPath ? `-e ${tq(`PATH=${input.serverPath}`)}` : "";
  const wait = input.waitReady;
  const sid = wait?.sessionId && /^[A-Za-z0-9._-]+$/.test(wait.sessionId) ? wait.sessionId : "";
  return `
N=${shQuote(input.nonce)}; T=${shQuote(input.tmux)}; S=${shQuote(input.socket)}; CW=${shQuote(input.cwd)}
CWT=${tq(tmuxFormatLiteral(input.cwd))}; RF=${shQuote(input.requireFile ?? "")}
${ALIVE_FN}
if [ -n "$RF" ] && [ ! -f "$RF" ]; then printf '%s ERR file\\n' "$N"; exit 0; fi
if [ ! -d "$CW" ]; then
  if [ ${input.cwdFallbackHome ? 1 : 0} = 1 ]; then CW=$HOME; CWT=$HOME; else printf '%s ERR cwd\\n' "$N"; exit 0; fi
fi
SD=\${S%/*}; [ -n "$SD" ] && [ ! -d "$SD" ] && (umask 077; mkdir -p "$SD")
TGT=$("$T" -S "$S" list-sessions -F '#{session_last_attached} #{session_id} #{session_name}' 2>/dev/null | grep -v ' pim-' | sort -rn | head -n 1 | cut -d' ' -f2)
if [ -n "$TGT" ]; then
  OUT=$("$T" -S "$S" new-window ${common} -t "$TGT:" -- ${argv} 2>&1) || { printf '%s ERR tmux %s\\n' "$N" "$OUT"; exit 0; }
else
  OUT=$("$T" -S "$S" new-session ${common} ${serverEnv} -s pi -- ${argv} 2>&1) || { printf '%s ERR tmux %s\\n' "$N" "$OUT"; exit 0; }
fi
printf '%s OK %s\\n' "$N" "$OUT"
${
  wait
    ? `
PANE=$(printf '%s' "$OUT" | cut -f3); PID=$(printf '%s' "$OUT" | cut -f4)
R=${shQuote(wait.procsDir)}/$PID.json; SID=${shQuote(sid)}
i=0; MAX=${Math.ceil(wait.timeoutMs / 250)}; ok=0
while [ "$i" -lt "$MAX" ]; do
  if [ -f "$R" ] && { [ -z "$SID" ] || grep -q "\\"sessionId\\":\\"$SID\\"" "$R"; }; then ok=1; break; fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.25; i=$((i + 1))
done
if [ "$ok" != 1 ]; then
  if kill -0 "$PID" 2>/dev/null; then printf '%s ERR timeout\\n' "$N"; else printf '%s ERR died\\n' "$N"; fi
  exit 0
fi
sleep 0.5
alive "$PID" "$R" || { printf '%s ERR died\\n' "$N"; exit 0; }
printf '%s READY\\n' "$N"
${
  input.pasteStdin
    ? `B="pim-$$-$PID"
if base64 -d | "$T" -S "$S" load-buffer -b "$B" - && "$T" -S "$S" paste-buffer -p -r -d -b "$B" -t "$PANE" && sleep 0.15 && "$T" -S "$S" send-keys -t "$PANE" Enter; then
  printf '%s PASTED\\n' "$N"
else printf '%s ERR paste\\n' "$N"; fi`
    : ""
}`
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
}

/** Shared guard: the record exists, is this process and session, and names the pane. */
function paneGuard(input: PaneScriptInput): string {
  const sid = input.sessionId && /^[A-Za-z0-9._-]+$/.test(input.sessionId) ? input.sessionId : "";
  return `
N=${shQuote(input.nonce)}; T=${shQuote(input.tmux)}; S=${shQuote(input.socket)}; P=${shQuote(input.pane)}
PID=${Math.floor(input.pid)}; R=${shQuote(input.procsDir)}/$PID.json; SID=${shQuote(sid)}
${ALIVE_FN}
if [ ! -f "$R" ] || ! alive "$PID" "$R"; then printf '%s CLOSED\\n' "$N"; exit 0; fi
if [ -n "$SID" ] && ! grep -q "\\"sessionId\\":\\"$SID\\"" "$R"; then printf '%s CLOSED\\n' "$N"; exit 0; fi
RP=$(sed -n 's/.*"tmux":{"socket":"\\([^"\\\\]*\\)","pane":"\\(%[0-9]*\\)".*/\\1\t\\2/p' "$R" | head -n 1)
if [ -n "$RP" ]; then S=\${RP%%\t*}; P=\${RP#*\t}; fi
case "$P" in %[0-9]*) ;; *) printf '%s NOTMUX\\n' "$N"; exit 0;; esac
INFO=$("$T" -S "$S" display-message -p -t "$P" '#{pane_id} #{pane_in_mode}' 2>/dev/null)
case "$INFO" in "$P "*) ;; *) printf '%s GONE\\n' "$N"; exit 0;; esac
`;
}

/** Output: `<nonce> OK|CLOSED|NOTMUX|GONE|WAITING|BUSY|ERR`. stdin: base64 of the prompt. */
export function sendScript(input: PaneScriptInput): string {
  return `${paneGuard(input)}
if grep -q '"state":"waiting"' "$R"; then printf '%s WAITING\\n' "$N"; exit 0; fi
[ "\${INFO#* }" = 0 ] || { printf '%s BUSY\\n' "$N"; exit 0; }
B="pim-$$-$PID"
if base64 -d | "$T" -S "$S" load-buffer -b "$B" - && "$T" -S "$S" paste-buffer -p -r -d -b "$B" -t "$P" && sleep 0.15 && "$T" -S "$S" send-keys -t "$P" Enter; then
  printf '%s OK\\n' "$N"
else printf '%s ERR\\n' "$N"; fi
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

export interface AttachScriptInput extends TmuxTarget {
  pane: string;
  sessionName: string;
  /** tmux >= 3.4: keep-last (never destroy the group's last session); else on. */
  keepLast: boolean;
  /** tmux >= 3.2: attach with -f ignore-size. */
  ignoreSize: boolean;
}

/**
 * A phone-private session grouped with the pane's session, showing the pane's window, attached
 * with ignore-size so a desktop client keeps its size; destroyed when the phone detaches.
 * Never touches the user's session's current window or clients.
 */
export function attachScript(input: AttachScriptInput): string {
  const name = input.sessionName;
  const flags = input.ignoreSize ? "-f ignore-size " : "";
  return `
T=${shQuote(input.tmux)}; S=${shQuote(input.socket)}; P=${shQuote(input.pane)}; NAME=${shQuote(name)}
W=$("$T" -S "$S" display-message -p -t "$P" '#{pane_id} #{session_id} #{window_id}' 2>/dev/null)
case "$W" in "$P "*) ;; *) echo "pi-mobile: this session's tmux pane is gone" >&2; exit 1;; esac
set -- $W
exec "$T" -u -S "$S" new-session -d -s "$NAME" -t "$2" \\; set-option -t "$NAME" destroy-unattached ${input.keepLast ? "keep-last" : "on"} \\; select-window -t "$NAME:$3" \\; attach-session ${flags}-t "$NAME"
`;
}

/** Kill the phone's session only while another session in its group still holds the windows. */
export function attachCleanupScript(input: TmuxTarget & { sessionName: string }): string {
  return `
T=${shQuote(input.tmux)}; S=${shQuote(input.socket)}; NAME=${shQuote(input.sessionName)}
case "$NAME" in pim-*) ;; *) exit 0;; esac
if "$T" -S "$S" list-sessions -F '#{session_name}\t#{session_group_size}' 2>/dev/null | awk -F'\t' -v n="$NAME" '$1 == n && $2 > 1 { f = 1 } END { exit !f }'; then
  "$T" -S "$S" kill-session -t "=$NAME" 2>/dev/null
fi
exit 0
`;
}

/** `test -f`, `test -d` on the host: prints `<nonce> <f|-> <d|->`. */
export function existsScript(file: string, dir: string, nonce: string): string {
  return `F=${shQuote(file)}; D=${shQuote(dir)}
a=-; b=-; [ -f "$F" ] && a=f; [ -d "$D" ] && b=d
printf '%s %s %s\\n' ${shQuote(nonce)} "$a" "$b"
`;
}
