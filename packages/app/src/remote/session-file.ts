// Reads forge's hidden `forge-btw` entries from a session .jsonl over the host connection: only the
// matching lines (grep), the newest 200, framed by a nonce. The /btw screen derives its history
// from them as forge's panel does (history.ts: entries after the last `forge-btw-clear`).

import { shQuote } from "@/host/commands";
import { assertNonce, framed } from "./scripts";
import { makeRemoteNonce } from "./client";
import { btwHistory, type BtwExchange } from "./views";

/** Prints `<tag> LINES`, the matching lines, `<tag> END` (nothing between when none match). */
export function btwEntriesScript(sessionFile: string, tag: string): string {
  assertNonce(tag);
  if (!sessionFile.startsWith("/")) throw new Error("session file must be absolute");
  const f = shQuote(sessionFile);
  return [
    `printf '%s LINES\\n' ${tag}`,
    `[ -f ${f} ] && grep -F '"customType":"forge-btw' ${f} 2>/dev/null | tail -n 200`,
    `printf '%s END\\n' ${tag}`,
    "",
  ].join("\n");
}

/** The framed output → parsed entries (unparseable lines skipped). */
export function parseEntryLines(body: string | undefined): unknown[] {
  if (!body) return [];
  const out: unknown[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a line cut mid-write
    }
  }
  return out;
}

export async function readBtwHistory(
  run: (script: string, timeoutMs: number) => Promise<string>,
  sessionFile: string,
): Promise<BtwExchange[]> {
  const tag = makeRemoteNonce();
  const out = await run(btwEntriesScript(sessionFile, tag), 15_000);
  return btwHistory(parseEntryLines(framed(out, tag, "LINES")));
}
