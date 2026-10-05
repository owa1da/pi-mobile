// Mounted composer checks and structural session wiring, without booting stores/SSH.
import { readFileSync } from "node:fs";
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "@/components/pi/composer";
import type { HostService, SessionRow } from "@/host/types";
import type { RemoteCommand } from "@/remote/types";
import { cachedCommands, rememberCommands } from "./command-cache";
import { routeSessionCommand } from "./route-command";
import { workingRowVisible } from "./chrome";

const input = vi.hoisted(() => ({ value: "", change: (_text: string) => {} }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  interface Props {
    children?: ReactNode;
    testID?: string;
    disabled?: boolean;
    onPress?: () => void;
  }
  const View = ({ children, testID }: Props) =>
    createElement("div", { "data-testid": testID }, children);
  return {
    Platform: { select: (values: Record<string, unknown>) => values.default },
    View,
    ScrollView: View,
    Text: ({ children }: Props) => createElement("span", null, children),
    Pressable: ({ children, testID, disabled, onPress }: Props) =>
      createElement(
        "button",
        {
          "data-testid": testID,
          disabled,
          onClick: onPress,
        },
        children,
      ),
  };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/pi/icons", () => ({
  MutedSpinner: () => null,
  ThemedArrowUp: () => null,
  ThemedSquare: () => null,
  accentForegroundColor: () => ({}),
  extraMutedColor: () => ({}),
  surfaceSolid: () => ({}),
}));
vi.mock("@/components/adaptive-modal-sheet", async () => {
  const { createElement, useImperativeHandle } = await import("react");
  return {
    AdaptiveTextInput: ({
      ref,
      testID,
      onChangeText,
    }: {
      ref: React.Ref<unknown>;
      testID: string;
      onChangeText: (text: string) => void;
    }) => {
      input.change = (text: string) => {
        input.value = text;
        onChangeText(text);
      };
      useImperativeHandle(ref, () => ({
        reset: () => {
          input.value = "";
        },
        replaceText: (text: string) => {
          input.value = text;
        },
        focus: () => {},
      }));
      return createElement("textarea", { "data-testid": testID });
    },
  };
});

const source = ts.createSourceFile(
  "session-screen.tsx",
  readFileSync(new URL("./session-screen.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function findAll(predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
function variable(name: string): ts.VariableDeclaration {
  const nodes = findAll(
    (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name,
  );
  expect(nodes).toHaveLength(1);
  return nodes[0] as ts.VariableDeclaration;
}
function tag(name: string): ts.JsxSelfClosingElement {
  const nodes = findAll(
    (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === name,
  );
  expect(nodes).toHaveLength(1);
  return nodes[0] as ts.JsxSelfClosingElement;
}

describe("completed session commands UI wiring", () => {
  it("places the sole side switch in the existing header action slot, outside keyboard shift", () => {
    expect(variable("sideSwitch").getText(source)).toContain(tag("SideSwitch").getText(source));
    const body = findAll(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "SessionBody",
    )[0];
    expect(body.getText(source)).toContain("rightContent={sideSwitch}");
    expect(body.getText(source).indexOf("<BackHeader")).toBeLessThan(
      body.getText(source).indexOf("<Animated.View"),
    );
    expect(variable("pickNative").getText(source)).toContain("send(`/${command.name}`)");
  });
  it("offers cached host commands without requiring a live channel", () => {
    const prop = tag("Composer").attributes.properties.find(
      (node) => ts.isJsxAttribute(node) && node.name.getText(source) === "commands",
    ) as ts.JsxAttribute;
    expect(prop.initializer?.getText(source)).toBe("{channel.commands}");
  });
  it("does not gate native row selection on row.live", () => {
    expect(variable("pickNative").getText(source)).not.toContain("row.live");
    expect(variable("pickNative").getText(source)).toContain("send(");
  });
  it("routes typed slash commands through the resume-aware native router, never prompt submission first", () => {
    expect(variable("runCommand").getText(source)).toContain("routeSessionCommand(");
    expect(variable("send").getText(source)).not.toContain("row.live ? nativeTarget");
    expect(variable("send").getText(source)).toContain("commandName(text)");
  });
  it("sends a non-command slash line (a path) as a message instead of failing", () => {
    expect(variable("send").getText(source)).toContain("slashIsCommand(text, channel.commands)");
    expect(variable("runCommand").getText(source)).toContain("CommandUnavailableError");
  });
});

describe("completed session mounted command picker", () => {
  let root: Root;
  let container: HTMLElement;
  let dom: JSDOM;
  const closed = { live: false, sessionId: "completed" } as SessionRow;
  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    input.value = "";
    rememberCommands("ui-completed-host", [
      { name: "model", description: "Pick a model" },
      { name: "compact", description: "Compact" },
    ]);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  });
  async function mount(onPickNative?: (command: RemoteCommand) => Promise<boolean>) {
    await act(async () =>
      root.render(
        React.createElement(Composer, {
          commands: cachedCommands("ui-completed-host"),
          placeholder: "Resume and send",
          testID: "composer",
          sendTestID: "send",
          onSubmit: vi.fn().mockResolvedValue(true),
          onPickNative,
        }),
      ),
    );
    await act(async () => input.change("/"));
  }
  it("shows slash-menu rows from an earlier live session on that host", async () => {
    await mount();
    expect(container.querySelector('[data-testid="slash-menu"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="slash-row-model"]')?.textContent).toContain(
      "/model",
    );
    expect(container.querySelector('[data-testid="slash-row-compact"]')).not.toBeNull();
  });
  it("keeps the picker text until resume completes, then opens the native model screen", async () => {
    let ready!: () => void;
    const ensureRemoteSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const runCommand = vi.fn();
    const service = { ensureRemoteSession, runCommand } as unknown as HostService;
    const open = vi.fn().mockResolvedValue(undefined);
    await mount(async (command) => {
      await routeSessionCommand(service, closed, `/${command.name}`, open, vi.fn());
      return true;
    });
    await act(async () =>
      (container.querySelector('[data-testid="slash-row-model"]') as HTMLButtonElement).click(),
    );
    expect(ensureRemoteSession).toHaveBeenCalledExactlyOnceWith(closed);
    expect(open).not.toHaveBeenCalled();
    expect(input.value).toBe("/");
    await act(async () => ready());
    expect(open).toHaveBeenCalledExactlyOnceWith("model", "");
    expect(input.value).toBe("");
    expect(runCommand).not.toHaveBeenCalled();
  });
  it.each(["typed", "menu", "words"])(
    "main %s /side replaces an existing hidden side",
    async (entry) => {
      const live = { ...closed, live: true, pid: 42 };
      const session = {
        row: live,
        state: { rev: 4, side: { id: "previous", gen: 2, open: false } },
      };
      const service = {
        ensureRemoteSession: vi.fn().mockResolvedValue(session),
      } as unknown as HostService;
      const remote = vi.fn().mockResolvedValue({ data: { id: "replacement", gen: 1 } });
      const open = vi.fn().mockResolvedValue(undefined);
      const submit = async (line: string) => {
        await routeSessionCommand(service, live, line, open, remote);
        return true;
      };
      await act(async () =>
        root.render(
          React.createElement(Composer, {
            commands: [{ name: "side", description: "Start a side conversation" }],
            placeholder: "Message pi",
            testID: "composer",
            sendTestID: "send",
            onSubmit: submit,
            onPickNative: (command: RemoteCommand) => submit(`/${command.name}`),
          }),
        ),
      );
      const text = { menu: "/", words: "/side first words", typed: "/side" }[entry]!;
      await act(async () => input.change(text));
      await act(async () =>
        (
          container.querySelector(
            `[data-testid="${entry === "menu" ? "slash-row-side" : "send"}"]`,
          ) as HTMLButtonElement
        ).click(),
      );
      expect(remote).toHaveBeenCalledExactlyOnceWith(
        live,
        "side.open",
        entry === "words" ? { text: "first words" } : {},
        { rev: 4, sessionId: live.sessionId },
      );
      expect(open).toHaveBeenCalledExactlyOnceWith("side", "", {
        sideId: "replacement",
        sideGen: "1",
      });
      expect(input.value).toBe("");
    },
  );
  it("keeps text on a failed native command instead of completing or clearing it", async () => {
    await mount(async () => false);
    await act(async () =>
      (container.querySelector('[data-testid="slash-row-model"]') as HTMLButtonElement).click(),
    );
    expect(input.value).toBe("/");
    expect(container.querySelector('[data-testid="slash-menu"]')).not.toBeNull();
  });
});

describe("session activity UI wiring", () => {
  it("sends the sole WorkingRow to ChatView, never to a composer sibling", () => {
    const activity = variable("activity").initializer!;
    expect(ts.isCallExpression(activity)).toBe(true);
    const memo = activity as ts.CallExpression;
    expect(memo.expression.getText(source)).toBe("useMemo");
    expect(memo.arguments[1].getText(source)).toBe("[working, hostId, row.since, active]");
    const render = memo.arguments[0] as ts.ArrowFunction;
    expect(ts.isArrowFunction(render)).toBe(true);
    const body = render.body as ts.ParenthesizedExpression;
    expect(ts.isParenthesizedExpression(body)).toBe(true);
    const conditional = body.expression as ts.ConditionalExpression;
    expect(ts.isConditionalExpression(conditional)).toBe(true);
    expect(conditional.condition.getText(source)).toBe("working");
    expect(conditional.whenFalse.kind).toBe(ts.SyntaxKind.NullKeyword);
    expect(conditional.whenTrue).toBe(tag("WorkingRow"));
    expect(tag("WorkingRow").getText(source)).toContain("active={active}");
    const chat = tag("ChatView");
    const prop = chat.attributes.properties.find(
      (node) => ts.isJsxAttribute(node) && node.name.getText(source) === "activity",
    ) as ts.JsxAttribute;
    expect(prop?.initializer?.getText(source)).toBe("{activity}");
    // The branch is available before a session file appears, without adding fixed chrome.
    expect(chat.parent.parent.getText(source)).toContain("feed.hasFile || working");
  });

  it("uses the existing visibility contract: idle/waiting/closed/held/disconnected are not working", () => {
    expect(variable("working").initializer!.getText(source)).toBe(
      "workingRowVisible(row.state, connection.status, held)",
    );
    expect(workingRowVisible("working", "connected", false)).toBe(true);
    for (const state of ["idle", "waiting", "closed"] as const)
      expect(workingRowVisible(state, "connected", false)).toBe(false);
    expect(workingRowVisible("working", "connected", true)).toBe(false);
    for (const status of ["idle", "connecting", "reconnecting", "failed"] as const)
      expect(workingRowVisible("working", status, false)).toBe(false);
  });

  it("allows working text and elapsed clock to wrap at large text sizes", () => {
    const workingFunction = findAll(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "WorkingRow",
    )[0];
    expect(workingFunction.getText(source)).not.toContain("numberOfLines");
    expect(workingFunction.getText(source)).toContain("useNow(1000, active)");
    expect(workingFunction.getText(source)).toContain("workingClock(since, hostNow(");
    expect(workingFunction.getText(source)).toContain('testID="chat-working"');
  });
});
