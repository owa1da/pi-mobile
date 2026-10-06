import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRow, SessionsSnapshot } from "@/host/types";
import { sessionsStore } from "@/stores/app";
import { startDashboardSession } from "@/stores/start-session";
import { CommandUnavailableError, RemoteError } from "@/remote/errors";
import { SessionScreen } from "./session-screen";

const probe = vi.hoisted(() => ({
  sendPrompt: vi.fn(),
  runCommand: vi.fn(),
  remoteSend: vi.fn(),
  ensureRemoteSession: vi.fn(),
  open: vi.fn(),
  focused: true,
  serviceAvailable: true,
  submit: null as null | ((text: string) => Promise<boolean>),
  scrollCount: 0,
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement("div", { "data-testid": testID }, children);
  return {
    View,
    Text: View,
    Platform: { select: (values: Record<string, unknown>) => values.default },
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children: ReactNode }) => <div>{children}</div> },
}));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    router: { replace: vi.fn(), canGoBack: () => false },
    useLocalSearchParams: () => ({ hostId: "h", sessionId: "s" }),
    useFocusEffect: useEffect,
  };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/app", async () => {
  const { createSessionsStore } = await import("@/stores/sessions-store");
  const { useStore } = await import("zustand");
  const store = createSessionsStore();
  return {
    sessionsStore: store,
    refreshSessions: vi.fn(async () => true),
    useHostsLoaded: () => true,
    useHostConnection: () => ({ status: "connected" }),
    useSessionsEntry: () => useStore(store, (state) => state.entries.h),
    connectionStore: {
      getState: () => ({
        ensureConnected: vi.fn(),
        reportFailure: vi.fn(),
        getService: () =>
          probe.serviceAvailable
            ? {
                sendPrompt: probe.sendPrompt,
                runCommand: probe.runCommand,
                ensureRemoteSession: probe.ensureRemoteSession,
              }
            : null,
      }),
    },
  };
});
vi.mock("@/stores/use-polling", () => ({
  useScreenFocused: () => probe.focused,
  useAppActive: () => true,
  usePoller: () => {},
}));
vi.mock("@/keyboard/shift", () => ({ useKeyboardShiftStyle: () => ({ style: {} }) }));
vi.mock("@/navigation/place-restorer", () => ({ useReportPlace: () => {} }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock("@/assistant-file-links", () => ({
  AssistantFileLinkResolverProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/tool-call-sheet", () => ({
  ToolCallSheetProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/headers/back-header", () => ({
  BackHeader: ({ rightContent }: { rightContent: ReactNode }) => <div>{rightContent}</div>,
}));
vi.mock("@/components/pi/connection-banner", () => ({ ConnectionBanner: () => null }));
vi.mock("@/components/pi/empty-state", () => ({
  EmptyState: ({ testID }: { testID: string }) => <div data-testid={testID} />,
}));
vi.mock("@/components/pi/icons", () => ({ MutedSpinner: () => null }));
vi.mock("@/components/pi/session-glyph", () => ({ SessionGlyph: () => null }));
vi.mock("@/components/pi/inline-banner", () => ({ InlineBanner: () => null }));
vi.mock("@/components/pi/note-row", () => ({ NoteRow: () => null }));
vi.mock("@/components/pi/use-announce", () => ({
  useAnnounceOnChange: () => {},
  announce: () => {},
}));
vi.mock("@/components/pi/composer", () => ({
  Composer: ({ onSubmit }: { onSubmit: (text: string) => Promise<boolean> }) => {
    probe.submit = onSubmit;
    return <div data-testid="composer" />;
  },
}));
vi.mock("@/components/pi/chat-view", () => ({
  ChatView: ({ localSendCount }: { localSendCount: number }) => {
    probe.scrollCount = localSendCount;
    return <div data-testid="chat" />;
  },
}));
vi.mock("./use-chat-feed", async () => {
  const { useState } = await import("react");
  return {
    useChatFeed: () => {
      const [rows, setRows] = useState<never[]>([]);
      return {
        rows,
        hasFile: true,
        loading: false,
        boost: vi.fn(),
        addPending: () => {
          setRows([...rows]);
          return "pending";
        },
        removePending: vi.fn(),
      };
    },
  };
});
vi.mock("./use-remote-channel", () => ({
  useRemoteChannel: () => ({
    available: true,
    commands: [{ name: "compact" }],
    state: undefined,
    boost: vi.fn(),
    send: probe.remoteSend,
  }),
}));
vi.mock("./use-answers", () => ({
  useNotice: () => ({ notice: null, show: vi.fn(), dismiss: vi.fn() }),
  useAnswers: () => ({}),
}));
vi.mock("./answer-dock", () => ({
  openIdsOf: () => [],
  AnswerDock: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./side-switch", () => ({
  SideSwitch: ({
    channel,
  }: {
    channel: { send: (action: string, args: object) => Promise<unknown> };
  }) => {
    const switchSide = React.useCallback(() => void channel.send("side.view", {}), [channel]);
    return <button type="button" data-testid="side" onClick={switchSide} />;
  },
}));
vi.mock("@/screens/forge/sheets", () => ({ SessionSheets: () => null }));
vi.mock("@/screens/forge/parts", () => ({ openForge: probe.open }));
vi.mock("@/screens/forge/use-side-navigation", () => ({
  useSideNavigationError: () => ({ error: null, clearError: vi.fn() }),
}));
vi.mock("@/remote/for-service", () => ({
  remoteFor: () => ({ send: probe.remoteSend }),
  hostNow: () => 0,
}));

const row = {
  key: "s",
  sessionId: "s",
  live: true,
  pid: 42,
  state: "idle",
  cwd: "/work",
  title: "Session",
  since: 0,
} as SessionRow;
const snapshot = (rows: SessionRow[]) => ({ rows, hostNow: 0 }) as SessionsSnapshot;

describe("mounted session regressions", () => {
  let root: Root;
  let container: HTMLElement;
  let dom: JSDOM;
  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    sessionsStore.getState().clear("h");
    sessionsStore.getState().setSnapshot("h", snapshot([row]), 0);
    probe.focused = true;
    probe.serviceAvailable = true;
    probe.sendPrompt.mockReset().mockResolvedValue(undefined);
    probe.runCommand.mockReset().mockResolvedValue(undefined);
    probe.remoteSend.mockReset().mockResolvedValue({ data: {} });
    probe.ensureRemoteSession.mockReset().mockResolvedValue({ row, state: { rev: 1 } });
    probe.open.mockClear();
  });
  afterEach(() => {
    act(() => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  });
  const mount = async () => act(async () => root.render(<SessionScreen />));
  const listing = async (rows: SessionRow[]) =>
    act(async () => {
      sessionsStore.getState().setSnapshot("h", snapshot(rows), 0);
    });
  const gone = () => container.querySelector('[data-testid="session-not-found"]');
  it("keeps row → missing → row on screen and requires three real misses, even in one React commit", async () => {
    await mount();
    await listing([]);
    expect(gone()).toBeNull();
    expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();
    await listing([row]);
    expect(gone()).toBeNull();
    await listing([]);
    await listing([]);
    expect(gone()).toBeNull();
    await listing([]);
    expect(gone()).not.toBeNull();
    await listing([row]);
    expect(gone()).toBeNull();
    await act(async () => {
      for (let i = 0; i < 3; i++) sessionsStore.getState().setSnapshot("h", snapshot([]), 0);
    });
    expect(gone()).not.toBeNull();
  });
  it.each(["send", "side", "resume"])("never shows gone during a pending %s", async (kind) => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (kind === "send") probe.sendPrompt.mockReturnValueOnce(pending);
    else if (kind === "resume") probe.ensureRemoteSession.mockReturnValueOnce(pending);
    else probe.remoteSend.mockReturnValueOnce(pending);
    await mount();
    await act(async () => {
      if (kind === "send") void probe.submit!("hello");
      else if (kind === "resume") void probe.submit!("/model");
      else (container.querySelector('[data-testid="side"]') as HTMLButtonElement).click();
    });
    await listing([]);
    await listing([]);
    await listing([]);
    expect(gone()).toBeNull();
    await act(async () => finish());
    expect(gone()).not.toBeNull();
  });
  it("retention cannot authorize a send while the actual listing lacks the row", async () => {
    await mount();
    await listing([]);
    await act(async () => {
      expect(await probe.submit!("hello")).toBe(false);
    });
    expect(probe.sendPrompt).not.toHaveBeenCalled();
  });
  it("hands a dashboard command to the existing dispatcher once across rerender, remount and focus", async () => {
    await startDashboardSession(
      {
        startSession: vi.fn().mockResolvedValue({ pid: 42 }),
        listSessions: vi.fn().mockResolvedValue(snapshot([row])),
      },
      "h",
      "/compact",
    );
    await mount();
    expect(probe.runCommand).toHaveBeenCalledExactlyOnceWith(row, "/compact");
    expect(probe.sendPrompt).not.toHaveBeenCalled();
    await listing([row]);
    act(() => root.render(null));
    await mount();
    probe.focused = false;
    await mount();
    probe.focused = true;
    await mount();
    expect(probe.runCommand).toHaveBeenCalledTimes(1);
  });
  it("waits for the current row before consuming a dashboard command", async () => {
    await startDashboardSession(
      {
        startSession: vi.fn().mockResolvedValue({ pid: 42 }),
        listSessions: vi.fn().mockResolvedValue(snapshot([row])),
      },
      "h",
      "/compact",
    );
    await listing([]);
    await mount();
    expect(probe.runCommand).not.toHaveBeenCalled();
    await listing([row]);
    expect(probe.runCommand).toHaveBeenCalledExactlyOnceWith(row, "/compact");
    act(() => root.render(null));
    await mount();
    expect(probe.runCommand).toHaveBeenCalledTimes(1);
  });
  const queueCommand = () =>
    startDashboardSession(
      {
        startSession: vi.fn().mockResolvedValue({ pid: 42 }),
        listSessions: vi.fn().mockResolvedValue(snapshot([row])),
      },
      "h",
      "/compact",
    );
  it("an explicit composer submit cancels a dashboard command still waiting for its row", async () => {
    await queueCommand();
    await listing([]);
    await mount();
    expect(probe.runCommand).not.toHaveBeenCalled();
    await act(async () => {
      await probe.submit!("newer prompt");
    });
    await listing([row]);
    await mount();
    expect(probe.runCommand).not.toHaveBeenCalled();
  });
  it("waits for initial screen focus before consuming a dashboard command", async () => {
    await queueCommand();
    probe.focused = false;
    await mount();
    expect(probe.runCommand).not.toHaveBeenCalled();
    probe.focused = true;
    await mount();
    expect(probe.runCommand).toHaveBeenCalledExactlyOnceWith(row, "/compact");
  });
  it("waits for a service before consuming a dashboard command", async () => {
    await queueCommand();
    probe.serviceAvailable = false;
    await mount();
    expect(probe.runCommand).not.toHaveBeenCalled();
    probe.serviceAvailable = true;
    await mount();
    expect(probe.runCommand).toHaveBeenCalledExactlyOnceWith(row, "/compact");
  });
  it("waits for an idle dispatcher before consuming a dashboard command", async () => {
    let finish!: () => void;
    probe.sendPrompt.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await mount();
    await act(async () => {
      void probe.submit!("hello");
    });
    await queueCommand();
    await listing([row]);
    expect(probe.runCommand).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(probe.runCommand).toHaveBeenCalledExactlyOnceWith(row, "/compact");
  });
  it.each(["gone", "blur", "unmount"])(
    "drops an unconsumed dashboard command on %s",
    async (reason) => {
      await queueCommand();
      await listing([]);
      await mount();
      if (reason === "gone") {
        await listing([]);
        await listing([]);
        expect(gone()).not.toBeNull();
      } else if (reason === "blur") {
        probe.focused = false;
        await mount();
      } else act(() => root.render(null));
      await listing([row]);
      probe.focused = true;
      await mount();
      expect(probe.runCommand).not.toHaveBeenCalled();
      expect(probe.sendPrompt).not.toHaveBeenCalled();
    },
  );
  it("never retries a dashboard command with an uncertain execution", async () => {
    probe.runCommand.mockRejectedValueOnce(new RemoteError("timeout"));
    await queueCommand();
    await mount();
    await listing([row]);
    act(() => root.render(null));
    await mount();
    expect(probe.runCommand).toHaveBeenCalledExactlyOnceWith(row, "/compact");
    expect(probe.sendPrompt).not.toHaveBeenCalled();
  });
  it("native dashboard handoff keeps the existing native route instead of submitting text", async () => {
    await startDashboardSession(
      {
        startSession: vi.fn().mockResolvedValue({ pid: 42 }),
        listSessions: vi.fn().mockResolvedValue(snapshot([row])),
      },
      "h",
      "/model",
    );
    await mount();
    expect(probe.ensureRemoteSession).toHaveBeenCalledExactlyOnceWith(row);
    expect(probe.open).toHaveBeenCalledExactlyOnceWith("h", "s", "model", {});
    expect(probe.sendPrompt).not.toHaveBeenCalled();
    expect(probe.runCommand).not.toHaveBeenCalled();
  });
  it.each(["/skill:review words", "/removed words"])(
    "fresh live list routes dashboard %s as a message, not a cached authorization",
    async (line) => {
      await startDashboardSession(
        {
          startSession: vi.fn().mockResolvedValue({ pid: 42 }),
          listSessions: vi.fn().mockResolvedValue(snapshot([row])),
        },
        "h",
        line,
      );
      await mount();
      expect(probe.sendPrompt).toHaveBeenCalledExactlyOnceWith(row, line);
      expect(probe.runCommand).not.toHaveBeenCalled();
    },
  );
  it.each([new CommandUnavailableError(), new RemoteError("refused", "starts a turn")])(
    "fresh validation or template refusal falls back to one message",
    async (error) => {
      probe.runCommand.mockRejectedValueOnce(error);
      await startDashboardSession(
        {
          startSession: vi.fn().mockResolvedValue({ pid: 42 }),
          listSessions: vi.fn().mockResolvedValue(snapshot([row])),
        },
        "h",
        "/compact words",
      );
      await mount();
      expect(probe.runCommand).toHaveBeenCalledExactlyOnceWith(row, "/compact words");
      expect(probe.sendPrompt).toHaveBeenCalledExactlyOnceWith(row, "/compact words");
      act(() => root.render(null));
      await mount();
      expect(probe.sendPrompt).toHaveBeenCalledTimes(1);
    },
  );
  it("only local prompt echoes advance the ChatView signal", async () => {
    await mount();
    expect(probe.scrollCount).toBe(0);
    await listing([row]);
    expect(probe.scrollCount).toBe(0);
    await act(async () => {
      await probe.submit!("hello");
    });
    expect(probe.scrollCount).toBe(1);
    await listing([row]);
    expect(probe.scrollCount).toBe(1);
    await act(async () => {
      await probe.submit!("again");
    });
    expect(probe.scrollCount).toBe(2);
  });
});
