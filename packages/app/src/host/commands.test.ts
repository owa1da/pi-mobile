import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  attachCleanupScript,
  parseStartedLine,
  shQuote,
  startScript,
  tmuxArg,
  tmuxFormatLiteral,
  tq,
  windowName,
  wrapForAnyShell,
} from "./commands";
import {
  base64Decode,
  base64Encode,
  base64EncodeText,
  utf8ByteLength,
  utf8Decode,
  utf8Encode,
} from "./encoding";

const HOSTILE = [
  "",
  "plain",
  "it's",
  "''",
  `"double" and 'single'`,
  "$HOME ${PATH} $(id) `id`",
  "back\\slash \\' \\\\",
  "semi;colon; && || | > < &",
  "line1\nline2\n\n",
  "\ttab\r\ncrlf",
  "ünïcødé ✓ 🎉 日本語",
  "#{pane_id} ##",
  "trailing;",
  "-n --flag",
  "*.ts ? [a]",
  "!history",
];

function shells(): string[] {
  return ["/bin/sh", "/bin/bash", "/bin/dash", "/usr/bin/zsh", "/usr/bin/fish"].filter((s) => {
    try {
      execFileSync(s, ["-c", "true"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
}

describe("shQuote", () => {
  it.each(HOSTILE)("round-trips %j through sh and bash", (value) => {
    for (const sh of ["/bin/sh", "/bin/bash"]) {
      const out = execFileSync(sh, ["-c", `printf %s ${shQuote(value)}`], { encoding: "utf8" });
      expect(out).toBe(value);
    }
  });

  it("refuses NUL", () => {
    expect(() => shQuote("a\0b")).toThrow();
  });
});

describe("wrapForAnyShell", () => {
  const script = `V=${shQuote(HOSTILE.join("|"))}\nprintf '%s' "$V"\ncat\n`;
  it.each(shells())("runs a POSIX script with stdin from %s", (shell) => {
    const out = execFileSync(shell, ["-c", wrapForAnyShell(script)], {
      encoding: "utf8",
      input: "STDIN-OK",
    });
    expect(out).toBe(`${HOSTILE.join("|")}STDIN-OK`);
  });

  it("holds only sh, quotes and base64", () => {
    expect(wrapForAnyShell("echo '$x' \"`y`\"")).toMatch(
      /^sh -c 'eval "\$\(printf %s [A-Za-z0-9+/=]+ \| base64 -d\)"'$/,
    );
  });
});

describe("tmux escaping", () => {
  it("escapes a trailing semicolon only", () => {
    expect(tmuxArg("a;b")).toBe("a;b");
    expect(tmuxArg("end;")).toBe("end\\;");
    expect(tmuxArg(";")).toBe("\\;");
    expect(tmuxArg("x\\;")).toBe("x\\\\;");
  });

  it("doubles # for format-expanded options", () => {
    expect(tmuxFormatLiteral("a#{pane_id}#b")).toBe("a##{pane_id}##b");
  });

  it("tq = shQuote(tmuxArg)", () => {
    expect(tq("it's;")).toBe(`'it'\\''s\\;'`);
  });

  it("names windows like forge", () => {
    expect(windowName("fix the flaky test in ci")).toBe("fix-the-flaky");
    expect(windowName("/skill:review this pr")).toBe("review-this-pr");
    expect(windowName("$$$ ''' ```")).toBe("pi");
    expect(windowName("averyveryverylongwordthatgoeson x")).toBe("averyveryverylongwor");
  });
});

describe("encoding", () => {
  it.each(HOSTILE)("utf8 + base64 match Buffer for %j", (value) => {
    const bytes = utf8Encode(value);
    expect(Buffer.from(bytes).equals(Buffer.from(value, "utf8"))).toBe(true);
    expect(utf8ByteLength(value)).toBe(Buffer.byteLength(value, "utf8"));
    expect(base64EncodeText(value)).toBe(Buffer.from(value, "utf8").toString("base64"));
    expect(utf8Decode(base64Decode(base64Encode(bytes)))).toBe(value);
  });

  it("decodes wrapped base64 and replaces broken sequences", () => {
    const b64 = Buffer.from("x".repeat(100))
      .toString("base64")
      .replace(/(.{76})/g, "$1\n");
    expect(utf8Decode(base64Decode(b64))).toBe("x".repeat(100));
    expect(utf8Decode(Uint8Array.from([0x61, 0xe2, 0x9c]))).toBe("a\ufffd\ufffd");
  });
});

describe("tmux format output without a UTF-8 client", () => {
  // tmux prints control characters (tabs) as "_" in -F/-P output when the client is not UTF-8,
  // which is the case over SSH (no LANG is sent): formats must not rely on tabs.
  it("parses the start script's space-separated OK line, session name last", () => {
    expect(parseStartedLine("@4 %12 4242 pi")).toEqual({
      windowId: "@4",
      pane: "%12",
      pid: 4242,
      tmuxSession: "pi",
    });
    expect(parseStartedLine("@1 %2 3 my work session")?.tmuxSession).toBe("my work session");
    expect(parseStartedLine("pi_@10_%10_1490580")).toBeUndefined();
  });

  it("uses no tab separators in the start and attach-cleanup scripts", () => {
    const start = startScript({
      nonce: "N",
      tmux: "tmux",
      socket: "/tmp/s",
      cwd: "/tmp",
      cwdFallbackHome: false,
      windowName: "pi",
      env: [],
      argv: ["pi"],
      waitReady: { procsDir: "/tmp/p", timeoutMs: 1000 },
      pasteStdin: true,
    });
    const cleanup = attachCleanupScript({ tmux: "tmux", socket: "/tmp/s", sessionName: "pim-1-a" });
    for (const script of [start, cleanup]) {
      expect(script).not.toContain("\t");
      expect(script).not.toContain("\\t");
    }
  });
});
