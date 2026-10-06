import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallDetail } from "@/types/protocol/agent-types";
import { ToolCallSheetProvider, useToolCallSheet } from "./tool-call-sheet";
import { ToolCallDetailsContent } from "./tool-call-details";
import { HighlightedLines } from "./highlighted-content";

const state = vi.hoisted(() => ({
  modalProps: {} as Record<string, unknown>,
  bottom: 34,
  width: 393,
  height: 852,
  position: 340.8,
  keyboardHeight: 0,
  keyboardShown: false,
  dismissKeyboard: vi.fn(),
}));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  function flatten(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    return style && typeof style === "object" ? (style as Record<string, unknown>) : {};
  }
  function host(kind: string) {
    return ({
      children,
      style,
      contentContainerStyle,
      horizontal,
      testID,
      onPress,
    }: {
      children?: React.ReactNode;
      style?: unknown;
      contentContainerStyle?: unknown;
      horizontal?: boolean;
      testID?: string;
      onPress?: () => void;
    }) =>
      ReactModule.createElement(
        "div",
        {
          "data-kind": kind,
          "data-style": JSON.stringify(flatten(style)),
          "data-content-style": JSON.stringify(flatten(contentContainerStyle)),
          "data-horizontal": horizontal ? "true" : undefined,
          "data-testid": testID,
          onClick: onPress,
        },
        children,
      );
  }
  return {
    View: host("view"),
    Text: host("text"),
    Pressable: host("pressable"),
    ScrollView: host("scroll"),
    Platform: { OS: "web", select: (values: { default: unknown }) => values.default },
    Keyboard: { dismiss: state.dismissKeyboard },
    useWindowDimensions: () => ({ width: state.width, height: state.height }),
  };
});
vi.mock("react-native-gesture-handler", async () => {
  const { ScrollView } = await import("react-native");
  return { ScrollView };
});
vi.mock("react-native-reanimated", async () => {
  const { View } = await import("react-native");
  return { default: { View }, useAnimatedStyle: (factory: () => unknown) => factory() };
});
vi.mock("@gorhom/bottom-sheet", async () => {
  const { ScrollView } = await import("react-native");
  return {
    BottomSheetScrollView: ScrollView,
    KEYBOARD_STATUS: { SHOWN: 1, HIDDEN: 0 },
    useBottomSheetInternal: () => ({
      animatedLayoutState: { get: () => ({ containerHeight: state.height, handleHeight: 24 }) },
      animatedPosition: { get: () => state.position },
      animatedDetentsState: { get: () => ({ detents: [state.height * 0.4, state.height * 0.08] }) },
      animatedKeyboardState: {
        get: () => ({
          status: state.keyboardShown ? 1 : 0,
          heightWithinContainer: state.keyboardHeight,
        }),
      },
    }),
  };
});
vi.mock("@/components/ui/isolated-bottom-sheet-modal", async () => {
  const ReactModule = await import("react");
  return {
    IsolatedBottomSheetModal: ({ children, ...props }: { children?: React.ReactNode }) => {
      state.modalProps = props;
      return ReactModule.createElement("div", { "data-kind": "modal" }, children);
    },
    useIsolatedBottomSheetVisibility: () => ({
      sheetRef: null,
      handleSheetChange: () => {},
      handleSheetDismiss: () => {},
    }),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: state.bottom, left: 0 }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native-unistyles", () => ({
  withUnistyles: (component: unknown) => component,
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? factory({
            colors: {
              surface2: "#222",
              foreground: "#fff",
              foregroundMuted: "#aaa",
              border: "#333",
            },
            spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16 },
            borderWidth: { 1: 1 },
            borderRadius: { base: 4, full: 9999 },
            fontFamily: { mono: "monospace", ui: "sans-serif" },
            fontSize: { base: 16, code: 12, sm: 14 },
            fontWeight: { semibold: "600", normal: "400" },
          })
        : factory,
  },
}));
vi.mock("@/styles/syntax-token-styles", () => ({ syntaxTokenStyleFor: () => ({}) }));
vi.mock("@/utils/highlight-cache", () => ({
  extensionFromPath: (path: string) => (path.endsWith(".ts") ? "ts" : null),
  highlightToKeyedLines: (content: string, extension: string | null) =>
    extension && content.length <= 100_000
      ? content.split("\n").map((text, index) => ({
          key: String(index),
          tokens: text ? [{ key: "token", token: { text } }] : [],
        }))
      : null,
}));
vi.mock("@/utils/diff-highlight", () => ({
  highlightDiffLines: (lines: unknown) => lines,
  diffLinePrefix: () => "",
}));

let root: Root;
let dom: JSDOM;
function render(node: React.ReactNode) {
  act(() => root.render(node));
}
function readStyle(element: Element | null, attribute = "data-style") {
  expect(element).not.toBeNull();
  return JSON.parse(element!.getAttribute(attribute) ?? "{}");
}
function OpenTool({ detail }: { detail?: ToolCallDetail }) {
  const { openToolCall } = useToolCallSheet();
  const handleOpen = React.useCallback(
    () =>
      openToolCall({
        toolName: "read",
        displayName: "Read",
        detail,
        icon: () => null,
      }),
    [detail, openToolCall],
  );
  return (
    <button type="button" onClick={handleOpen}>
      Open
    </button>
  );
}
function openSheet(detail?: ToolCallDetail) {
  render(
    <ToolCallSheetProvider>
      <OpenTool detail={detail} />
    </ToolCallSheetProvider>,
  );
  act(() => document.querySelector("button")!.click());
}

beforeEach(() => {
  Object.assign(state, {
    bottom: 34,
    width: 393,
    height: 852,
    position: 340.8,
    keyboardHeight: 0,
    keyboardShown: false,
  });
  state.dismissKeyboard.mockClear();
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost",
  });
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  root = createRoot(document.getElementById("root")!);
});
afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

describe("tool-call drawer geometry", () => {
  it("opens short output at a 60% minimum and offers 92% expansion without dynamic sizing", () => {
    openSheet();
    expect(state.modalProps.snapPoints).toEqual(["60%", "92%"]);
    expect(state.modalProps.index).toBe(0);
    expect(state.modalProps.enableDynamicSizing).toBe(false);
  });
  it("bounds the viewport to the current detent with a fixed header and no nested height cap", () => {
    openSheet({ type: "read", filePath: "file.ts", content: "last line\n".repeat(200) });
    const close = document.querySelector('[data-testid="tool-call-sheet-close"]')!;
    const header = close.parentElement!;
    const container = header.parentElement!;
    const scroll = container.querySelector('[data-kind="scroll"]')!;
    expect(scroll.contains(header)).toBe(false);
    expect(readStyle(container)).toMatchObject({ flex: 1, minHeight: 0 });
    expect(readStyle(header).flexShrink).toBe(0);
    expect(readStyle(scroll)).toMatchObject({ flex: 1, minHeight: 0 });
    expect(readStyle(container.parentElement).height).toBeCloseTo(852 * 0.6 - 24);
    expect(container.querySelectorAll('[data-kind="scroll"]')).toHaveLength(1);
    for (const element of scroll.querySelectorAll("[data-style]")) {
      expect(readStyle(element).maxHeight).toBeUndefined();
    }
  });
  for (const bottom of [0, 34]) {
    it(`includes safe-area inset ${bottom} exactly once in bottom scroll clearance`, () => {
      state.bottom = bottom;
      openSheet({ type: "read", filePath: "file.ts", content: "tail" });
      const scroll = document.querySelector('[data-kind="modal"] [data-kind="scroll"]')!;
      const scrollPadding = readStyle(scroll, "data-content-style").paddingBottom ?? 0;
      const bodyPadding = readStyle(scroll.firstElementChild).paddingBottom ?? 0;
      expect(scrollPadding + bodyPadding).toBe(16 + bottom);
      expect(state.modalProps.bottomInset ?? 0).toBe(0);
    });
  }
  it("updates the visible viewport at expansion and above a keyboard", () => {
    state.position = 852 * 0.08;
    openSheet();
    const container = document.querySelector('[data-testid="tool-call-sheet-close"]')!
      .parentElement!.parentElement!;
    expect(readStyle(container.parentElement).height).toBeCloseTo(852 * 0.92 - 24);
    state.keyboardShown = true;
    state.keyboardHeight = 300;
    render(
      <ToolCallSheetProvider>
        <OpenTool />
      </ToolCallSheetProvider>,
    );
    expect(readStyle(container.parentElement).height).toBeCloseTo(852 * 0.92 - 24 - 300);
  });
  it("uses the expanded detent in landscape and dismisses the underlying composer keyboard", () => {
    state.width = 852;
    state.height = 393;
    state.position = 393 * 0.08;
    openSheet();
    expect(state.modalProps.snapPoints).toEqual(["92%"]);
    expect(state.dismissKeyboard).toHaveBeenCalled();
  });
});

describe("read preview wrapping", () => {
  for (const [name, filePath, content] of [
    ["highlighted", "file.ts", "const long = '" + "x".repeat(200) + "';\n\nlast"],
    ["unsupported", "file.unknown", "x".repeat(200)],
    ["oversized", "file.ts", "x".repeat(100_001)],
  ]) {
    const detail: ToolCallDetail = { type: "read", filePath, content, offset: 99 };
    it(`wraps ${name} reads without a horizontal ScrollView`, () => {
      render(React.createElement(ToolCallDetailsContent, { detail }));
      expect(document.querySelector('[data-horizontal="true"]')).toBeNull();
      const text = [...document.querySelectorAll('[data-kind="text"]')].find((element) =>
        element.textContent?.includes("x".repeat(200)),
      )!;
      expect(readStyle(text)).toMatchObject({
        flexShrink: 1,
        minWidth: 0,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      });
      if (name === "highlighted") {
        const gutter = text.previousElementSibling!;
        expect(gutter.textContent).toBe(" 99 ");
        expect(readStyle(gutter).flexShrink).toBe(0);
        expect(readStyle(text.parentElement).width).toBe("100%");
        expect(document.body.textContent).toContain("101 last");
      }
    });
  }
  const write: ToolCallDetail = { type: "write", filePath: "file.ts", content: "const a = 1;" };
  const edit: ToolCallDetail = {
    type: "edit",
    filePath: "file.ts",
    oldString: "old",
    newString: "new",
  };
  it("keeps write previews, diffs and default highlighted lines horizontal/unwrapped", () => {
    render(React.createElement(ToolCallDetailsContent, { detail: write }));
    expect(document.querySelector('[data-horizontal="true"]')).not.toBeNull();
    render(React.createElement(ToolCallDetailsContent, { detail: edit }));
    expect(document.querySelector('[data-horizontal="true"]')).not.toBeNull();
    render(
      <HighlightedLines
        lines={[{ key: "line", tokens: [{ key: "token", token: { text: "code", style: null } }] }]}
      />,
    );
    expect(readStyle(document.querySelector('[data-kind="text"]')).whiteSpace).toBe("pre");
  });
});
