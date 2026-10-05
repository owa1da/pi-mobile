import { readFileSync } from "node:fs";
import { transformSync } from "@babel/core";
import React, { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hostNow, setHostSkew } from "@/remote/for-service";
import type { PiHostService } from "@/host/service";
import { workingClock } from "./chrome";
import {
  buildSections,
  formatAge,
  resetHostClocks,
  shortModel,
  steadyHostNow,
} from "../dashboard/view-model";
import { rowAccessibilityLabel, rowStateWord } from "../dashboard/glyphs";
import { createPoller } from "@/stores/poller";
import { createSessionsRefresher, createSessionsStore } from "@/stores/sessions-store";
import type { SessionsSnapshot } from "@/host/types";

// Compile the actual components, not a clock facsimile: unit Vite does not enable Expo's compiler.
function declarations(path: string, names: string[]): string {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return source.statements
    .filter((node) =>
      names.some((name) => {
        if (ts.isFunctionDeclaration(node)) return node.name?.text === name;
        return (
          ts.isVariableStatement(node) &&
          node.declarationList.declarations.some((d) => d.name.getText(source) === name)
        );
      }),
    )
    .map((node) => node.getText(source).replace(/^export /, ""))
    .join("\n");
}

const service = {} as PiHostService;
const styles = new Proxy({}, { get: () => ({}) });
const t = (key: string, args?: { clock: string }) => (args ? `Working… (${args.clock})` : key);
const onPress = vi.fn();
function compile<T>(source: string, exports: string, bindings: Record<string, unknown>): T {
  const code = transformSync(`${source}\nexport { ${exports} };`, {
    filename: "live-clocks.tsx",
    configFile: false,
    babelrc: false,
    plugins: [
      [
        "babel-plugin-react-compiler",
        {
          target: "19",
          environment: { enableResetCacheOnSourceFileChanges: false },
          panicThreshold: "NONE",
        },
      ],
      ["@babel/plugin-transform-typescript", { isTSX: true }],
      "@babel/plugin-transform-react-jsx",
      "@babel/plugin-transform-modules-commonjs",
    ],
  })!.code!;
  const result = {};
  const require = (name: string) => {
    if (name === "react/compiler-runtime") return ReactCompilerRuntime;
    throw new Error(`Unexpected compiled import: ${name}`);
  };
  new Function("exports", "require", ...Object.keys(bindings), code)(
    result,
    require,
    ...Object.values(bindings),
  );
  return result as T;
}
import * as ReactCompilerRuntime from "react/compiler-runtime";
const Text = ({ children }: { children?: React.ReactNode }) =>
  React.createElement("span", null, children);
const View = ({ children }: { children?: React.ReactNode }) =>
  React.createElement("div", null, children);
const common = {
  React,
  ...React,
  styles,
  Text,
  View,
  Pressable: View,
  SessionGlyph: () => null,
  useWindowDimensions: () => ({ fontScale: 1 }),
  useTranslation: () => ({ t }),
  workingClock,
  hostNow,
  formatAge,
  steadyHostNow,
  shortModel,
  rowAccessibilityLabel,
  rowStateWord,
  rowGlyph: () => "closed",
  connectionStore: { getState: () => ({ getService: () => service }) },
};
// The hook is absent on the baseline; the baseline components still compile and mount.
const hookPath = new URL("../../hooks/use-now.ts", import.meta.url);
let useNow: unknown;
try {
  useNow = compile<{ useNow: unknown }>(
    readFileSync(hookPath, "utf8").replace(/^import .*\n/gm, ""),
    "useNow",
    common,
  ).useNow;
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
}
const { WorkingRow } = compile<{
  WorkingRow: ComponentType<{ hostId: string; since: number; active: boolean }>;
}>(declarations("./session-screen.tsx", ["useSecondTick", "WorkingRow"]), "WorkingRow", {
  ...common,
  useNow,
});
const { SessionRow } = compile<{ SessionRow: ComponentType }>(
  declarations("../../components/pi/session-row.tsx", ["SessionRow", "LARGE_FONT_SCALE"]),
  "SessionRow",
  common,
);
let reportVisible: (props: { viewableItems: { item: { key: string } }[] }) => void;
const SectionList = ({
  sections,
  renderItem,
  onViewableItemsChanged,
}: {
  sections: ReturnType<typeof buildSections>;
  renderItem: (props: { item: unknown }) => React.ReactNode;
  onViewableItemsChanged: typeof reportVisible;
}) => {
  reportVisible = onViewableItemsChanged;
  return React.createElement(
    "div",
    null,
    sections.flatMap((section) =>
      section.data.map((item) =>
        React.createElement("div", { key: item.key }, renderItem({ item })),
      ),
    ),
  );
};
const { SessionsList } = compile<{ SessionsList: ComponentType<Record<string, unknown>> }>(
  declarations("../dashboard/dashboard-screen.tsx", ["SessionsList", "keyOf"]),
  "SessionsList",
  {
    ...common,
    useNow,
    buildSections,
    SectionList,
    SessionRow,
    EmptyState: () => null,
    openSession: onPress,
  },
);

let root: Root;
let container: HTMLElement;
let dom: JSDOM;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  resetHostClocks();
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  setHostSkew(service, 500_000);
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  dom.window.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTime(ms));
}
it("compiled WorkingRow advances 4s → 5s → 6s with unchanged props and host skew", async () => {
  await act(async () =>
    root.render(React.createElement(WorkingRow, { hostId: "h", since: 596_000, active: true })),
  );
  expect(container.textContent).toContain("(4s)");
  await advance(1000);
  expect(container.textContent).toContain("(5s)");
  await advance(1000);
  expect(container.textContent).toContain("(6s)");
});
it.each(["unfocused", "backgrounded"])(
  "working clock stops when %s, catches up on return",
  async () => {
    const render = (active: boolean) =>
      act(async () =>
        root.render(React.createElement(WorkingRow, { hostId: "h", since: 596_000, active })),
      );
    await render(true);
    await render(false);
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
    await render(true);
    expect(container.textContent).toContain("(14s)");
  },
);
const snapshot: SessionsSnapshot = {
  hostName: "Host",
  counts: { needs: 0, working: 0, completed: 1 },
  hostNow: 600,
  rows: [
    {
      key: "r",
      sessionId: "r",
      title: "Clock",
      cwd: "/tmp",
      messages: 0,
      since: 596_000,
      live: false,
      section: "completed",
      state: "closed",
    },
  ],
};
const listProps = {
  hostId: "h",
  hostLabel: "Host",
  snapshot,
  summary: "",
  fetchedAt: 100_000,
  active: true,
};
it("compiled dashboard age advances without a new snapshot", async () => {
  await act(async () => root.render(React.createElement(SessionsList, listProps)));
  expect(container.textContent).toContain("4s");
  await advance(1000);
  expect(container.textContent).toContain("5s");
  await advance(1000);
  expect(container.textContent).toContain("6s");
});
it("a late snapshot sampled before a slow reply never moves an age backwards", async () => {
  await act(async () => root.render(React.createElement(SessionsList, listProps)));
  await advance(10_000);
  expect(container.textContent).toContain("14s");
  const late = { ...snapshot, hostNow: 608 };
  await act(async () =>
    root.render(
      React.createElement(SessionsList, { ...listProps, snapshot: late, fetchedAt: 110_000 }),
    ),
  );
  expect(container.textContent).toContain("14s");
  await advance(3000);
  expect(container.textContent).toContain("15s");
});
it("dashboard uses the slower clock after the youngest row reaches a minute", async () => {
  await act(async () => root.render(React.createElement(SessionsList, listProps)));
  for (let i = 0; i < 60; i++) await advance(1000);
  expect(container.textContent).toContain("1m");
  expect(vi.getTimerCount()).toBe(1);
  await advance(60_000);
  expect(container.textContent).toContain("2m");
});
it("dashboard stops both clocks while inactive and catches up on resume", async () => {
  await act(async () => root.render(React.createElement(SessionsList, listProps)));
  await act(async () =>
    root.render(React.createElement(SessionsList, { ...listProps, active: false })),
  );
  expect(vi.getTimerCount()).toBe(0);
  await advance(10_000);
  await act(async () => root.render(React.createElement(SessionsList, listProps)));
  expect(container.textContent).toContain("14s");
});
it("working rows share one timer until the final subscriber leaves", async () => {
  const row = (key: string) =>
    React.createElement(WorkingRow, { key, hostId: "h", since: 596_000, active: true });
  await act(async () => root.render(React.createElement(React.Fragment, null, row("a"), row("b"))));
  expect(vi.getTimerCount()).toBe(1);
  await advance(1000);
  expect(container.textContent?.match(/\(5s\)/g)).toHaveLength(2);
  await act(async () => root.render(React.createElement(React.Fragment, null, row("a"))));
  expect(vi.getTimerCount()).toBe(1);
});
it("only visible young dashboard rows request second ticks", async () => {
  const old = { ...snapshot.rows[0], key: "old", sessionId: "old", since: 500_000 };
  const withOld = { ...snapshot, rows: [...snapshot.rows, old] };
  await act(async () =>
    root.render(React.createElement(SessionsList, { ...listProps, snapshot: withOld })),
  );
  expect(vi.getTimerCount()).toBe(2);
  await act(async () => reportVisible({ viewableItems: [{ item: old }] }));
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => reportVisible({ viewableItems: [] }));
  expect(vi.getTimerCount()).toBe(0);
});
it("the unchanged focused listing poll publishes fresh snapshots and updates compiled rows", async () => {
  const store = createSessionsStore();
  const listSessions = vi.fn(async () => ({ ...snapshot, hostNow: Date.now() / 1000 + 500 }));
  const refresh = createSessionsRefresher({
    getService: () => ({ listSessions }),
    reportFailure: vi.fn(),
    store,
  });
  const render = () => {
    const entry = store.getState().entries.h;
    root.render(React.createElement(SessionsList, { ...listProps, ...entry }));
  };
  const unsubscribe = store.subscribe(render);
  const poller = createPoller({ intervalMs: 2000, run: () => refresh("h").then(() => undefined) });
  try {
    poller.start();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const first = store.getState().entries.h.snapshot;
    expect(container.textContent).toContain("4s");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(store.getState().entries.h.snapshot).not.toBe(first);
    expect(store.getState().entries.h.fetchedAt).toBe(102_000);
    expect(container.textContent).toContain("6s");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(container.textContent).toContain("8s");
    expect(listSessions).toHaveBeenCalledTimes(3);
  } finally {
    poller.stop();
    unsubscribe();
  }
});
