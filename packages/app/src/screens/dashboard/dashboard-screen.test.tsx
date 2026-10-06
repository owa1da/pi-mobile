import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as starters from "@/stores/start-session";
import type { SessionRow, SessionsSnapshot } from "@/host/types";
import { DashboardScreen } from "./dashboard-screen";
import { commandCatalogStore } from "@/stores/app";
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
          type: "button",
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

const probe = vi.hoisted(() => ({ startSession: vi.fn(), listSessions: vi.fn(), push: vi.fn() }));
vi.mock("expo-router", () => ({
  router: { push: probe.push },
  useLocalSearchParams: () => ({ hostId: "h" }),
}));
vi.mock("@/stores/app", async () => {
  const { createStore } = await import("zustand/vanilla");
  const { createCommandCatalogStore } = await import("@/stores/command-catalog-store");
  const { createSessionsStore } = await import("@/stores/sessions-store");
  return {
    commandCatalogStore: createCommandCatalogStore({
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    }),
    connectionStore: createStore(() => ({
      getService: () => ({ startSession: probe.startSession, listSessions: probe.listSessions }),
      ensureConnected: vi.fn(),
    })),
    sessionsStore: createSessionsStore(),
    refreshSessions: vi.fn(),
    useHost: () => ({ label: "Host" }),
    useHostsLoaded: () => true,
    useHostConnection: () => ({ status: "connected" }),
    useSessionsEntry: () => undefined,
  };
});
vi.mock("@/stores/use-polling", () => ({
  useScreenFocused: () => true,
  useAppActive: () => true,
  usePoller: () => {},
}));
vi.mock("@/keyboard/shift", () => ({ useKeyboardShiftStyle: () => ({ style: {} }) }));
vi.mock("@/navigation/place-restorer", () => ({ useReportPlace: () => {} }));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn(), show: vi.fn() }),
}));
vi.mock("@/components/headers/back-header", () => ({ BackHeader: () => null }));
vi.mock("@/components/pi/connection-banner", () => ({ ConnectionBanner: () => null }));
vi.mock("@/components/pi/session-row", () => ({ SessionRow: () => null }));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children: ReactNode }) => <div>{children}</div> },
}));

const row = { sessionId: "new", live: true, pid: 42 } as SessionRow;

describe("dashboard slash handoff", () => {
  let root: Root;
  let container: HTMLElement;
  let dom: JSDOM;
  beforeEach(async () => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    probe.startSession.mockReset().mockResolvedValue({ pid: 42 });
    probe.listSessions.mockReset().mockResolvedValue({ rows: [row] } as SessionsSnapshot);
    probe.push.mockClear();
    await commandCatalogStore.getState().rememberLive("h", "/work", {
      view: "main",
      updatedAt: 100,
      commands: [{ name: "model", description: "Models" }],
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  });
  async function mount() {
    await act(async () => root.render(<DashboardScreen />));
  }
  it("dashboard / shows the menu from the latest host catalog", async () => {
    await mount();
    await act(async () => input.change("/"));
    expect(container.querySelector('[data-testid="slash-row-model"]')).not.toBeNull();
  });
  it("a picked command starts one empty session and is consumed exactly once including remount", async () => {
    await mount();
    await act(async () => input.change("/"));
    const button = container.querySelector('[data-testid="slash-row-model"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    await act(async () => {
      button.click();
      button.click();
    });
    expect(probe.startSession).toHaveBeenCalledExactlyOnceWith({ prompt: "" });
    expect(probe.push).toHaveBeenCalledTimes(1);
    expect(starters.takeDashboardCommand("h", "new")).toBe("/model");
    act(() => root.render(null));
    await mount();
    expect(starters.takeDashboardCommand("h", "new")).toBeUndefined();
    expect(probe.startSession).toHaveBeenCalledTimes(1);
  });
  it("ordinary dashboard text is passed to startSession unchanged, without a handoff", async () => {
    await mount();
    await act(async () => input.change("hello world"));
    await act(async () =>
      (container.querySelector('[data-testid="dashboard-send"]') as HTMLButtonElement).click(),
    );
    expect(probe.startSession).toHaveBeenCalledExactlyOnceWith({ prompt: "hello world" });
    expect(starters.takeDashboardCommand).toBeTypeOf("function");
    expect(starters.takeDashboardCommand("h", "new")).toBeUndefined();
  });
});
