import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  paneFrameScript,
  parseStartedLine,
  shQuote,
  startScript,
  tmuxCommandArgv,
  wrapWithHostTimeout,
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
import { parseTmuxVersion } from "./service";

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

  it("uses no tab separators in the start script", () => {
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
    expect(start).not.toContain("\t");
    expect(start).not.toContain("\\t");
  });
});

describe("pi editor frame detection (real pi 1.0.0 layouts)", () => {
  const RULE = "─".repeat(60);
  const FOOTER = "  /tmp/work · Dead 1 · ctx 4%/128k";
  const screens: Record<string, { lines: string[]; expect: string }> = {
    empty: { lines: ["※ tmux extended-keys is off", "", RULE, " ", RULE, FOOTER], expect: "EMPTY" },
    "empty, transcript above": {
      lines: ["❯ one", "  two", "  ⎿  API Error: Connection error.", RULE, "", RULE, FOOTER],
      expect: "EMPTY",
    },
    draft: { lines: ["", RULE, "hello draft ", RULE, FOOTER], expect: "DRAFT" },
    "multi-line draft": {
      lines: [RULE, "alpha", "beta", "", RULE, FOOTER],
      expect: "DRAFT",
    },
    "long draft (scroll rule)": {
      lines: [`${"─".repeat(20)} ↑ 3 more ${"─".repeat(20)}`, "line 4", "line 5", RULE, FOOTER],
      expect: "DRAFT",
    },
    "paste marker": { lines: [RULE, "[paste #1 +40 lines]", RULE, FOOTER], expect: "DRAFT" },
    "no editor (dialog/page)": {
      lines: ["Sessions", "  ✻ fix the tests", "  ✶ docs", "enter open · esc back"],
      expect: "NOFRAME",
    },
    "blank screen (not drawn yet)": { lines: ["", "", ""], expect: "NOFRAME" },
  };
  it.each(Object.keys(screens))("%s", (name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pim-frame-"));
    try {
      const screen = screens[name]!;
      fs.writeFileSync(path.join(dir, "screen"), `${screen.lines.join("\n")}\n`);
      const fake = path.join(dir, "tmux");
      fs.writeFileSync(fake, `#!/bin/sh\ncat ${shQuote(path.join(dir, "screen"))}\n`, {
        mode: 0o755,
      });
      const out = execFileSync(
        "/bin/sh",
        ["-c", paneFrameScript({ tmux: fake, socket: "/nope", pane: "%1" })],
        { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" } },
      );
      expect(out.trim()).toBe(screen.expect);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tmux command argv", () => {
  it("never hands tmux a one-element argv (it would run it through $SHELL -c)", () => {
    expect(tmuxCommandArgv(["/opt/my tools/pi"])).toEqual([
      "/bin/sh",
      "-c",
      'exec "$0"',
      "/opt/my tools/pi",
    ]);
    expect(tmuxCommandArgv(["/usr/bin/node", "/x/cli.js"])).toEqual(["/usr/bin/node", "/x/cli.js"]);
    // The wrapper execs the one program as-is, a path with spaces included.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pim argv "));
    try {
      const prog = path.join(dir, "say hi");
      fs.writeFileSync(prog, '#!/bin/sh\necho "pid=$$ arg0-ok"\n', { mode: 0o755 });
      const [cmd, ...rest] = tmuxCommandArgv([prog]);
      expect(execFileSync(cmd!, rest, { encoding: "utf8" })).toMatch(/^pid=\d+ arg0-ok\n$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escapes # in a $HOME fallback cwd and in the window name", () => {
    const script = startScript({
      nonce: "N",
      tmux: "tmux",
      socket: "/tmp/s",
      cwd: "/gone",
      cwdFallbackHome: true,
      windowName: "a#b",
      env: [],
      argv: ["pi", "x"],
    });
    expect(script).toContain("sed 's/#/##/g'");
    expect(script).toContain("'a##b'");
  });

  it("refuses a resume while a live record names the session, and forwards the server env", () => {
    const script = startScript({
      nonce: "N",
      tmux: "tmux",
      socket: "/tmp/s",
      cwd: "/tmp",
      cwdFallbackHome: false,
      windowName: "pi",
      env: [],
      serverEnv: ["PATH=/a:/b", "LANG=C.UTF-8"],
      argv: ["pi", "--session", "/f.jsonl"],
      refuseLive: { procsDir: "/p", sessionId: "abc-1" },
    });
    expect(script).toContain("ERR live");
    expect(script).toContain("env 'PATH=/a:/b' 'LANG=C.UTF-8' \"$T\"");
    expect(script).toContain("set-environment -g 'LANG' 'C.UTF-8'");
    expect(script).toContain("set-environment -g 'PATH' '/a:/b'");
    expect(script).not.toContain("sleep 0.5");
  });
});

describe("wrapWithHostTimeout", () => {
  it("runs the script with stdin, under timeout when the host has one", () => {
    const out = execFileSync(
      "/bin/sh",
      ["-c", wrapWithHostTimeout("printf 'x:'; cat; exit 0", 10)],
      { encoding: "utf8", input: "IN" },
    ).toString();
    expect(out).toBe("x:IN");
    let status: number | null = 0;
    try {
      execFileSync("/bin/sh", ["-c", wrapWithHostTimeout("exit 3", 10)], { stdio: "ignore" });
    } catch (error) {
      status = (error as { status: number | null }).status;
    }
    expect(status).toBe(3);
  });

  it("kills a script that outlives the host timeout (exit 124)", () => {
    const started = Date.now();
    let status: number | null = 0;
    try {
      execFileSync("/bin/sh", ["-c", wrapWithHostTimeout("sleep 20; echo late", 1)], {
        encoding: "utf8",
      });
    } catch (error) {
      status = (error as { status: number | null }).status;
    }
    expect(status).toBe(124);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("tmux version gate", () => {
  it("parses tmux versions and treats an unparseable one as unknown", () => {
    expect(parseTmuxVersion("tmux 3.6")).toEqual([3, 6]);
    expect(parseTmuxVersion("tmux next-3.7")).toEqual([3, 7]);
    expect(parseTmuxVersion("tmux 3.3a")).toEqual([3, 3]);
    expect(parseTmuxVersion("tmux master")).toBeUndefined();
  });
});
