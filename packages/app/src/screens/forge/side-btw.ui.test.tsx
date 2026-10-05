import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteError } from "@/remote/errors";
import type { RemoteChannel } from "@/screens/session/use-remote-channel";
import type { ForgeViewProps } from "./forge-screen";
import { BtwView, SideView } from "./side-btw";
import { openForge } from "./parts";
import { useSideNavigationError } from "./use-side-navigation";

const navigation = vi.hoisted(() => ({
  focused: true,
  cleanup: undefined as undefined | (() => void),
}));
const composer = vi.hoisted(() => ({
  send: undefined as undefined | ((text: string) => Promise<boolean>),
}));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  const stack = { getState: () => ({ routes: [], index: 0, key: "stack" }), dispatch: vi.fn() };
  return {
    useNavigation: () => stack,
    useFocusEffect: (callback: () => void | (() => void)) => {
      const focused = navigation.focused;
      useEffect(() => {
        if (!focused) return;
        const cleanup = callback();
        navigation.cleanup = cleanup || undefined;
        return cleanup;
      }, [callback, focused]);
    },
  };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement("div", { "data-testid": testID }, children);
  return { View, Text: View, ScrollView: View };
});
vi.mock("@/screens/session/use-chat-feed", () => ({
  useChatFeed: (_host: string, source: unknown) => ({
    rows: source ? ["saved transcript"] : [],
    loading: false,
    boost: vi.fn(),
  }),
}));
vi.mock("@/components/pi/chat-view", () => ({
  ChatView: ({ rows }: { rows: string[] }) => <div data-testid="transcript">{rows.join("")}</div>,
}));
vi.mock("@/components/pi/composer", () => ({
  Composer: ({ onSubmit }: { onSubmit: (text: string) => Promise<boolean> }) => {
    composer.send = onSubmit;
    return <div data-testid="composer" />;
  },
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    onPress,
    children,
    testID,
  }: {
    onPress: () => void;
    children: ReactNode;
    testID: string;
  }) => (
    <button type="button" data-testid={testID} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/pi/confirm-sheet", () => ({ ConfirmSheet: () => null }));
vi.mock("@/components/pi/sheet-actions", () => ({
  SheetActions: ({ children }: { children: ReactNode }) => children,
  sheetActionStyles: {},
}));
vi.mock("@/components/pi/session-glyph", () => ({ SessionGlyph: () => null }));
vi.mock("@/components/markdown/renderer", () => ({ MarkdownRenderer: () => null }));
vi.mock("@/stores/app", () => ({
  connectionStore: { getState: () => ({ getService: () => ({ connection: {} }) }) },
}));
vi.mock("@/remote/client", () => ({ connectionRunner: () => ({}) }));
vi.mock("@/remote/session-file", () => ({
  readBtwHistory: async () => [{ question: "fork question", answer: "fork answer" }],
}));
vi.mock("@/stores/use-polling", async () => {
  const { useEffect } = await import("react");
  return {
    usePoller: (load: () => Promise<unknown>) => {
      useEffect(() => {
        void load();
      }, [load]);
      return vi.fn();
    },
  };
});
vi.mock("./parts", async () => {
  const { useState, useCallback } = await import("react");
  return {
    ForgeFrame: ({ children, right }: { children: ReactNode; right?: ReactNode }) => (
      <div>
        {right}
        {children}
      </div>
    ),
    TranscriptProviders: ({ children }: { children: ReactNode }) => children,
    Loading: () => <div>loading</div>,
    UpdateForge: () => <div>unsupported</div>,
    ErrorLine: ({ message }: { message: string | null }) => (
      <div data-testid="error">{message}</div>
    ),
    forgeStyles: {},
    openForge: vi.fn(),
    useForgeAction: (channel: RemoteChannel) => {
      const [actionError, setError] = useState<string | null>(null);
      const send = channel.send;
      const [unsupported, setUnsupported] = useState(false);
      const run = useCallback(
        async (action: Parameters<RemoteChannel["send"]>[0], args: Record<string, unknown>) => {
          try {
            const result = await send(action, args as never);
            return { ok: true, data: result?.data };
          } catch (error) {
            if (error instanceof RemoteError && error.code === "unknown-action")
              setUnsupported(true);
            else setError(String(error));
            return { ok: false, error };
          }
        },
        [send],
      );
      return { run, busy: null, error: actionError, unsupported, clearError: () => setError(null) };
    },
  };
});

function MainError({ hostId, row }: Pick<ForgeViewProps, "hostId" | "row">) {
  const errors = useSideNavigationError(hostId, row);
  return <div data-testid="main-error">{errors.error}</div>;
}

let counter = 0;
describe("SideView navigation", () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLElement;
  let props: ForgeViewProps;
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    container = document.createElement("div");
    root = createRoot(container);
    navigation.focused = true;
    send = vi.fn().mockResolvedValue({ ok: true });
    const state = {
      v: 1,
      pid: 42,
      sessionId: `ui-side-${++counter}`,
      rev: 1,
      updatedAt: 1,
      view: "side",
      draft: false,
      side: { open: true, working: false, sessionFile: "/saved-side" },
    };
    props = {
      hostId: "h",
      row: { pid: 42, sessionId: state.sessionId } as ForgeViewProps["row"],
      active: true,
      params: {},
      channel: {
        available: true,
        loaded: true,
        state,
        send,
        read: vi.fn(async () => props.channel.state),
        boost: vi.fn(),
      } as RemoteChannel,
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  });
  async function render() {
    await act(async () => root.render(<SideView {...props} />));
  }
  async function blur() {
    navigation.focused = false;
    await render();
  }
  it("Back/blur hides without closing, even when the stack retains the screen", async () => {
    await render();
    send.mockClear();
    await blur();
    expect(send).toHaveBeenCalledWith(
      "side.view",
      { open: false },
      expect.objectContaining({ sessionId: props.row.sessionId }),
    );
    expect(send).not.toHaveBeenCalledWith("side.close", expect.anything());
  });
  it("unmount hides once; app background alone does not hide", async () => {
    await render();
    send.mockClear();
    props.active = false;
    await render();
    expect(send).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(send).toHaveBeenCalledWith("side.view", { open: false }, expect.anything());
    root = createRoot(container);
  });
  it("hidden existing side keeps transcript and sends, never creates a fresh side", async () => {
    props.channel.state!.side!.open = false;
    await render();
    expect(container.textContent).toContain("saved transcript");
    expect(send).toHaveBeenCalledWith("side.view", { open: true }, expect.anything());
    await act(async () => {
      await composer.send!("more");
    });
    expect(send).toHaveBeenCalledWith("side.send", { text: "more" }, expect.anything());
    expect(send.mock.calls.some(([action]) => action === "side.open")).toBe(false);
  });
  it("route words never send or replace merely by opening a screen", async () => {
    props.params.arg = "seed words";
    await render();
    await render();
    expect(
      send.mock.calls.filter(([action]) => action === "side.send" || action === "side.open"),
    ).toEqual([]);
  });
  it("re-focus shows the same side after hiding", async () => {
    await render();
    await blur();
    send.mockClear();
    navigation.focused = true;
    await render();
    expect(send).toHaveBeenCalledWith("side.view", { open: true }, expect.anything());
    expect(container.textContent).toContain("saved transcript");
  });
  it("unpinned retained re-focus keeps its own hide ack, never a desktop generation", async () => {
    Object.assign(props.channel.state!.side!, { id: "A", gen: 1 });
    send.mockResolvedValue({ ok: true, data: { id: "A", gen: 1 } });
    await render();
    send.mockResolvedValue({ ok: true, data: { id: "A", gen: 2 } });
    await blur();
    Object.assign(props.channel.state!.side!, { open: false, gen: 5 });
    send.mockClear().mockRejectedValue(new RemoteError("stale"));
    navigation.focused = true;
    await render();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: true, id: "A", gen: 2 },
      expect.anything(),
    );
    expect(container.querySelector('[data-testid="error"]')!.textContent).toBe("");
  });
  it("unknown-action falls back without disabling transcript/composer/Close", async () => {
    send.mockImplementation(async (action) => {
      if (action === "side.view") throw new RemoteError("unknown-action");
      return { ok: true };
    });
    await render();
    await blur();
    navigation.focused = true;
    await render();
    expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();
    expect(container.textContent).toContain("saved transcript");
  });
  it("Close stays destructive and leave does not send another action", async () => {
    await render();
    send.mockClear();
    await act(async () =>
      (container.querySelector('[data-testid="side-close"]') as HTMLButtonElement).click(),
    );
    expect(send).toHaveBeenCalledWith("side.close", {}, expect.anything());
    send.mockClear();
    await blur();
    expect(send).not.toHaveBeenCalled();
  });
  it("hide failures are displayed on the existing error line", async () => {
    await render();
    send.mockRejectedValue(new RemoteError("refused", "busy side"));
    await blur();
    expect(container.querySelector('[data-testid="error"]')!.textContent).not.toBe("");
  });
  it("repeated navigation on a retained route never replays text", async () => {
    props.params = { arg: "same words", sideEntry: "1" };
    await render();
    props.params = { arg: "same words", sideEntry: "2" };
    await render();
    await render();
    expect(
      send.mock.calls.filter(([action]) => action === "side.send" || action === "side.open"),
    ).toHaveLength(0);
  });
  it("empty side does not create until explicit text", async () => {
    props.channel.state!.side = null;
    await render();
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      await composer.send!("first words");
    });
    expect(send).toHaveBeenCalledWith("side.open", { text: "first words" }, expect.anything());
  });
  it("rapid re-entry supersedes a hide waiting for fresh state", async () => {
    await render();
    send.mockClear();
    let resolve!: (state: RemoteChannel["state"]) => void;
    props.channel.read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockImplementation(async () => props.channel.state);
    await blur();
    navigation.focused = true;
    await render();
    await act(async () => resolve(props.channel.state));
    expect(
      send.mock.calls.filter(([name, args]) => name === "side.view" && args.open === false),
    ).toHaveLength(0);
    expect(send).toHaveBeenCalledWith("side.view", { open: true }, expect.anything());
  });
  it("queued re-entry show is invalidated on unmount, but leave still hides", async () => {
    Object.assign(props.channel.state!.side!, { id: "A", gen: 1 });
    send.mockResolvedValue({ ok: true, data: { id: "A", gen: 1 } });
    await render();
    send.mockClear();
    let acknowledge!: (value: unknown) => void;
    send.mockImplementationOnce(
      () =>
        new Promise((done) => {
          acknowledge = done;
        }),
    );
    await blur();
    navigation.focused = true;
    await render();
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => acknowledge({ data: { id: "A", gen: 2 } }));
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      { open: false, id: "A", gen: 1 },
      { open: false, id: "A", gen: 2 },
    ]);
  });
  it("Back that unmounts before its leave read finishes still hides", async () => {
    Object.assign(props.channel.state!.side!, { id: "A", gen: 1 });
    send.mockResolvedValue({ ok: true, data: { id: "A", gen: 1 } });
    await render();
    send.mockClear();
    let resolve!: (state: RemoteChannel["state"]) => void;
    props.channel.read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockImplementation(async () => props.channel.state);
    await blur();
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => resolve(props.channel.state));
    expect(send).toHaveBeenCalledWith(
      "side.view",
      { open: false, id: "A", gen: 1 },
      expect.anything(),
    );
  });
  it("text queued behind entry never sends after unmount", async () => {
    Object.assign(props.channel.state!.side!, { id: "A", gen: 1 });
    send.mockResolvedValue({ ok: true, data: { id: "A", gen: 1 } });
    let resolve!: (state: RemoteChannel["state"]) => void;
    props.channel.read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockImplementation(async () => props.channel.state);
    await render();
    let sent: Promise<boolean> | undefined;
    await act(async () => {
      sent = composer.send!("late words") as Promise<boolean>;
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => resolve(props.channel.state));
    await act(async () => {
      await sent;
    });
    expect(send.mock.calls.some(([action]) => action === "side.send")).toBe(false);
    expect(await sent).toBe(false);
  });
  it("show waiting for a read is invalidated on session change", async () => {
    Object.assign(props.channel.state!.side!, { id: "A", gen: 1 });
    const previous = props.channel.state;
    let read!: (value: RemoteChannel["state"]) => void;
    props.channel.read = vi.fn(
      () =>
        new Promise<RemoteChannel["state"]>((done) => {
          read = done;
        }),
    );
    await render();
    props.row = { ...props.row, sessionId: `${props.row.sessionId}-next` };
    props.channel = {
      ...props.channel,
      state: { ...previous!, sessionId: props.row.sessionId, side: null },
      read: vi.fn(async () => props.channel.state),
    };
    await render();
    await act(async () => read(previous));
    expect(send).not.toHaveBeenCalled();
  });
  it("unmount failure survives into the next side screen error line", async () => {
    await render();
    send.mockRejectedValueOnce(new RemoteError("refused", "busy"));
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.querySelector('[data-testid="error"]')!.textContent).not.toBe("");
  });
  it("a failed Back is surfaced by main's shared error line after unmount", async () => {
    await render();
    send.mockRejectedValueOnce(new RemoteError("refused", "busy"));
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<MainError hostId={props.hostId} row={props.row} />));
    expect(container.querySelector('[data-testid="main-error"]')!.textContent).not.toBe("");
  });
  it("an already-sent hide settles before re-entry shows again", async () => {
    await render();
    send.mockClear();
    let resolve!: () => void;
    send.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await blur();
    navigation.focused = true;
    await render();
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    expect(send.mock.calls.map((call) => call[1])).toEqual([{ open: false }, { open: true }]);
  });
  it("Back during first side.open hides the created side after acceptance", async () => {
    props.channel.state!.side = null;
    await render();
    let resolve!: () => void;
    let accepted: Promise<boolean>;
    send.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await act(async () => {
      accepted = composer.send!("first words");
    });
    await blur();
    props.channel.state!.side = { open: true, working: true, sessionFile: "/created-side" };
    await act(async () => {
      resolve();
      await accepted;
    });
    expect(send).toHaveBeenCalledWith("side.view", { open: false }, expect.anything());
  });
  it("fork navigation pins the accepted side despite a stale first poll", async () => {
    props.row.sessionFile = "/main";
    Object.assign(props.channel.state!.side!, { id: "A", gen: 4, open: false });
    send.mockResolvedValue({ ok: true, data: { id: "B", gen: 1 } });
    vi.mocked(openForge).mockClear();
    await act(async () => root.render(<BtwView {...props} />));
    await act(async () =>
      (container.querySelector('[data-testid="btw-fork"]') as HTMLButtonElement).click(),
    );
    expect(openForge).toHaveBeenCalledExactlyOnceWith(
      "h",
      props.row.sessionId,
      "side",
      { sideId: "B", sideGen: "1" },
      true,
    );
    props.params = { sideId: "B", sideGen: "1", sideEntry: "fork" };
    await render(); // Publication still shows hidden A; the accepted pins win.
    expect(send.mock.calls.filter(([name]) => name === "side.view")).toEqual([]);
    props.channel.state!.side = {
      id: "B",
      gen: 1,
      open: true,
      working: false,
      sessionFile: "/forked-side",
    };
    await render();
    send.mockClear();
    await blur();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: false, id: "B", gen: 1 },
      expect.anything(),
    );
  });
  it("fork ack B is hidden by immediate Back while publication still shows A", async () => {
    props.row.sessionFile = "/main";
    Object.assign(props.channel.state!.side!, { id: "A", gen: 4, open: false });
    send.mockResolvedValue({ ok: true, data: { id: "B", gen: 1 } });
    vi.mocked(openForge).mockClear();
    await act(async () => root.render(<BtwView {...props} />));
    await act(async () =>
      (container.querySelector('[data-testid="btw-fork"]') as HTMLButtonElement).click(),
    );
    expect(openForge).toHaveBeenCalledExactlyOnceWith(
      "h",
      props.row.sessionId,
      "side",
      { sideId: "B", sideGen: "1" },
      true,
    );
    props.params = { sideId: "B", sideGen: "1", sideEntry: "fork" };
    await render();
    send.mockClear();
    await blur();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: false, id: "B", gen: 1 },
      expect.anything(),
    );
  });
  it("missing creation ack pins capture the first visible state read at Back", async () => {
    // side.open succeeded without identity; its route is unpinned, not pending creation.
    props.params = { sideId: "", sideGen: "", sideEntry: "created-without-pins" };
    Object.assign(props.channel.state!.side!, { id: "A", gen: 4, open: false });
    await render();
    expect(send).not.toHaveBeenCalled();
    props.channel.read = vi.fn().mockResolvedValue({
      ...props.channel.state,
      side: { id: "B", gen: 1, open: true, working: true, sessionFile: null },
    });
    await blur();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: false, id: "B", gen: 1 },
      expect.anything(),
    );
  });
  it("unpinned entry waits past hidden A to capture the first visible B", async () => {
    Object.assign(props.channel.state!.side!, { id: "A", gen: 4, open: false });
    await render();
    expect(send).not.toHaveBeenCalled();
    props.channel.state!.side = {
      id: "B",
      gen: 1,
      open: true,
      working: false,
      sessionFile: "/forked-side",
    };
    send.mockResolvedValue({ ok: true, data: { id: "B", gen: 1 } });
    await render();
    send.mockClear();
    await blur();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: false, id: "B", gen: 1 },
      expect.anything(),
    );
  });
  it("Back never retargets to side B observed by polling", async () => {
    Object.assign(props.channel.state!.side!, { id: "A", gen: 1 });
    send.mockResolvedValue({ ok: true, data: { id: "A", gen: 1 } });
    await render();
    send.mockClear();
    props.channel.state!.side = {
      open: true,
      working: false,
      sessionFile: "/new-side",
      id: "B",
      gen: 1,
    };
    await render();
    expect(send).not.toHaveBeenCalled();
    await blur();
    expect(
      send.mock.calls.some(
        ([name, args]) => name === "side.view" && args.open === false && args.id !== "A",
      ),
    ).toBe(false);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: false, id: "A", gen: 1 },
      expect.anything(),
    );
  });
  it("Back during startup hides with id even before sessionFile exists", async () => {
    props.channel.state!.side = null;
    await render();
    send.mockImplementation(async (name) => {
      if (name === "side.open") {
        props.channel.state!.side = {
          open: true,
          working: true,
          sessionFile: null,
          id: "startup",
          gen: 1,
        };
        return { ok: true, data: { id: "startup", gen: 1 } };
      }
      return { ok: true, data: { id: "startup", gen: 2 } };
    });
    await act(async () => {
      await composer.send!("first words");
    });
    send.mockClear();
    await blur();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: false, id: "startup", gen: 1 },
      expect.anything(),
    );
  });
  it("a stale visibility generation is silent and never retried", async () => {
    Object.assign(props.channel.state!.side!, { id: "A", gen: 1 });
    send.mockResolvedValue({ ok: true, data: { id: "A", gen: 2 } });
    await render();
    Object.assign(props.channel.state!.side!, { gen: 4 });
    await render();
    send.mockClear();
    send.mockRejectedValue(new RemoteError("stale", "desktop moved"));
    await blur();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: false, id: "A", gen: 2 },
      expect.anything(),
    );
    expect(container.querySelector('[data-testid="error"]')!.textContent).toBe("");
  });
  it("enters an existing startup side with no sessionFile", async () => {
    props.channel.state!.side = {
      open: true,
      working: true,
      sessionFile: null,
      id: "startup",
      gen: 1,
    };
    send.mockResolvedValue({ ok: true, data: { id: "startup", gen: 1 } });
    await render();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: true, id: "startup", gen: 1 },
      expect.anything(),
    );
    send.mockClear();
    await blur();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: false, id: "startup", gen: 1 },
      expect.anything(),
    );
  });
  it("captures the first startup state after its own open when result has no identity", async () => {
    props.channel.state!.side = null;
    await render();
    send.mockImplementation(async (name) => {
      if (name === "side.open")
        props.channel.state!.side = {
          open: true,
          working: true,
          sessionFile: null,
          id: "startup",
          gen: 3,
        };
      return { ok: true };
    });
    await act(async () => {
      await composer.send!("first words");
    });
    send.mockClear();
    await blur();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: false, id: "startup", gen: 3 },
      expect.anything(),
    );
  });
  it("creation result pins A even when its following read sees B", async () => {
    props.channel.state!.side = null;
    await render();
    send.mockImplementation(async (name) => {
      if (name === "side.open") {
        props.channel.state!.side = {
          open: true,
          working: true,
          sessionFile: null,
          id: "B",
          gen: 1,
        };
        return { ok: true, data: { id: "A", gen: 1 } };
      }
      return { ok: true };
    });
    await act(async () => {
      await composer.send!("first words");
    });
    await render();
    send.mockClear();
    await blur();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: false, id: "A", gen: 1 },
      expect.anything(),
    );
  });
  it("Back during pending startup hides after side.open acceptance", async () => {
    props.channel.state!.side = null;
    await render();
    let resolve!: (value: unknown) => void;
    let accepted!: Promise<boolean>;
    send.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => {
      accepted = composer.send!("first words");
    });
    await blur();
    props.channel.state!.side = {
      open: true,
      working: true,
      sessionFile: null,
      id: "startup",
      gen: 1,
    };
    await act(async () => {
      resolve({ ok: true, data: { id: "startup", gen: 1 } });
      await accepted;
    });
    expect(send).toHaveBeenCalledWith(
      "side.view",
      { open: false, id: "startup", gen: 1 },
      expect.anything(),
    );
  });
  it("a switch route is bound to its accepted id/gen, without a duplicate show", async () => {
    props.params = { sideId: "A", sideGen: "3", sideEntry: "accepted" };
    Object.assign(props.channel.state!.side!, { id: "A", gen: 3 });
    await render();
    expect(send).not.toHaveBeenCalled();
    await blur();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: false, id: "A", gen: 3 },
      expect.anything(),
    );
  });
  it("an accepted route never adopts a replacement observed before its first poll", async () => {
    props.params = { sideId: "A", sideGen: "3", sideEntry: "accepted" };
    Object.assign(props.channel.state!.side!, { id: "B", gen: 1 });
    await render();
    await blur();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: false, id: "A", gen: 3 },
      expect.anything(),
    );
  });
  it("a stale show is silent and never retried", async () => {
    Object.assign(props.channel.state!.side!, { id: "A", gen: 1 });
    send.mockRejectedValue(new RemoteError("stale"));
    await render();
    await render();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: true, id: "A", gen: 1 },
      expect.anything(),
    );
    expect(container.querySelector('[data-testid="error"]')!.textContent).toBe("");
  });
  it("an explicit new creation after Close acquires its own cleanup ownership", async () => {
    Object.assign(props.channel.state!.side!, { id: "A", gen: 1 });
    send.mockResolvedValue({ ok: true, data: { id: "A", gen: 1 } });
    await render();
    await act(async () =>
      (container.querySelector('[data-testid="side-close"]') as HTMLButtonElement).click(),
    );
    props.channel.state!.side = null;
    await render();
    send.mockImplementation(async (name) => {
      if (name === "side.open")
        props.channel.state!.side = {
          id: "B",
          gen: 1,
          open: true,
          working: true,
          sessionFile: null,
        };
      return { ok: true, data: { id: "B", gen: 1 } };
    });
    await act(async () => {
      await composer.send!("new side");
    });
    send.mockClear();
    await blur();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: false, id: "B", gen: 1 },
      expect.anything(),
    );
  });
  it("does not hide a replacement session", async () => {
    await render();
    send.mockClear();
    props.channel.read = vi
      .fn()
      .mockResolvedValue({ ...props.channel.state, sessionId: "replacement" });
    await blur();
    expect(send).not.toHaveBeenCalled();
  });
  it("does not hide a replacement side or session", async () => {
    await render();
    send.mockClear();
    props.channel.read = vi.fn().mockResolvedValue({
      ...props.channel.state,
      side: { ...props.channel.state!.side, sessionFile: "/new-side" },
    });
    await blur();
    expect(send).not.toHaveBeenCalled();
  });
});
