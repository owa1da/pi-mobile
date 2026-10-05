import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteError } from "@/remote/errors";
import type { SessionRow } from "@/host/types";
import type { RemoteChannel } from "./use-remote-channel";
import { useSideNavigation, useSideNavigationError } from "@/screens/forge/use-side-navigation";
import { SideSwitch } from "./side-switch";

const focus = vi.hoisted(() => ({ active: true }));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  const stack = { getState: () => ({ routes: [], index: 0, key: "stack" }), dispatch: vi.fn() };
  return {
    useNavigation: () => stack,
    useFocusEffect: (callback: () => void | (() => void)) => {
      const active = focus.active;
      useEffect(() => (active ? callback() : undefined), [callback, active]);
    },
  };
});
const open = vi.hoisted(() => vi.fn());
vi.mock("@/screens/forge/parts", () => ({ openForge: open }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("lucide-react-native", () => ({ PanelRight: () => null }));
vi.mock("@/components/ui/button", () => ({
  Button: (props: {
    onPress: () => void;
    disabled: boolean;
    accessibilityLabel: string;
    accessibilityRole: string;
    testID: string;
  }) => (
    <button
      type="button"
      data-testid={props.testID}
      onClick={props.onPress}
      disabled={props.disabled}
      aria-label={props.accessibilityLabel}
      role={props.accessibilityRole}
    />
  ),
}));
function MainError({ row }: { row: SessionRow }) {
  const { error } = useSideNavigationError("switch-host", row);
  return <div data-testid="error">{error}</div>;
}
function SideRoute({ row, channel }: { row: SessionRow; channel: RemoteChannel }) {
  useSideNavigation("switch-host", row, channel, "accepted", "A", "1");
  return null;
}
let counter = 0;
describe("side header switch", () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLElement;
  let row: SessionRow;
  let channel: RemoteChannel;
  const send = vi.fn();
  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    container = document.createElement("div");
    root = createRoot(container);
    row = { pid: 42, sessionId: `switch-${++counter}` } as SessionRow;
    channel = {
      available: true,
      loaded: true,
      state: {
        v: 1,
        pid: 42,
        sessionId: row.sessionId,
        rev: 1,
        updatedAt: 1,
        view: "main",
        draft: false,
        side: { id: "A", gen: 2, open: false, working: false, sessionFile: "/side" },
      },
      send,
      read: vi.fn(async () => channel.state),
      boost: vi.fn(),
    };
    send.mockReset().mockResolvedValue({ data: { id: "A", gen: 3 } });
    open.mockReset();
    focus.active = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  });
  async function render() {
    await act(async () =>
      root.render(
        <>
          <SideSwitch hostId="switch-host" row={row} channel={channel} />
          <MainError row={row} />
        </>,
      ),
    );
  }
  function button() {
    return container.querySelector(
      '[data-testid="session-side-switch"]',
    ) as HTMLButtonElement | null;
  }
  it.each(["none", "legacy", "unloaded", "unavailable"])("hidden with %s", async (kind) => {
    if (kind === "none") channel.state!.side = null;
    if (kind === "legacy") delete channel.state!.side!.id;
    if (kind === "unloaded") channel.state = undefined;
    if (kind === "unavailable") channel.available = false;
    await render();
    expect(button()).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
  it("shows one accessible icon; rendering/polling sends nothing", async () => {
    await render();
    await render();
    expect(button()!.getAttribute("aria-label")).toBe("pi.session.openSide");
    expect(button()!.getAttribute("role")).toBe("button");
    expect(button()!.textContent).toBe("");
    expect(send).not.toHaveBeenCalled();
  });
  it("tap shows the pinned side and navigates once, including rapid taps", async () => {
    await render();
    await act(async () => {
      button()!.click();
      button()!.click();
    });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "side.view",
      { open: true, id: "A", gen: 2 },
      { sessionId: row.sessionId },
    );
    expect(open).toHaveBeenCalledExactlyOnceWith("switch-host", row.sessionId, "side", {
      sideId: "A",
      sideGen: "3",
    });
  });
  it("stale tap refreshes quietly without navigating or recreating", async () => {
    send.mockRejectedValue(new RemoteError("stale"));
    await render();
    await act(async () => button()!.click());
    expect(channel.boost).toHaveBeenCalled();
    expect(channel.read).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="error"]')!.textContent).toBe("");
    expect(open).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });
  it.each(["own", "desktop", "stale-hide", "missing-identity"])(
    "Back then immediate icon tap chains only the app's ack (%s)",
    async (transition) => {
      Object.assign(channel.state!.side!, { gen: 1, open: true });
      await act(async () => root.render(<SideRoute row={row} channel={channel} />));
      let acknowledge!: () => void;
      let forgeGen = 1;
      send.mockImplementation(async (_name, args) => {
        if (!args.open) {
          await new Promise<void>((done) => {
            acknowledge = done;
          });
          forgeGen = transition === "desktop" ? 3 : 2;
          // The hide acknowledged gen2; desktop may subsequently move to gen3.
          channel.state!.side!.gen = forgeGen;
          if (transition === "stale-hide") throw new RemoteError("stale");
          if (transition === "missing-identity") return { data: null };
          return { data: { id: "A", gen: 2 } };
        }
        if (args.gen !== forgeGen) throw new RemoteError("stale");
        return { data: { id: "A", gen: ++forgeGen } };
      });
      focus.active = false;
      await act(async () =>
        root.render(
          <>
            <SideRoute row={row} channel={channel} />
            <SideSwitch hostId="switch-host" row={row} channel={channel} />
            <MainError row={row} />
          </>,
        ),
      );
      await act(async () => {
        button()!.click();
        button()!.click();
      });
      expect(send).toHaveBeenCalledTimes(1);
      await act(async () => acknowledge());
      expect(send.mock.calls.map((call) => call[1])).toEqual([
        { open: false, id: "A", gen: 1 },
        { open: true, id: "A", gen: ["own", "desktop"].includes(transition) ? 2 : 1 },
      ]);
      if (transition !== "own") expect(open).not.toHaveBeenCalled();
      else
        expect(open).toHaveBeenCalledExactlyOnceWith("switch-host", row.sessionId, "side", {
          sideId: "A",
          sideGen: "3",
        });
      expect(container.querySelector('[data-testid="error"]')!.textContent).toBe("");
      expect(send).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["unmount", "session-change"])(
    "in-flight switch never navigates after %s",
    async (leave) => {
      let acknowledge!: (value: unknown) => void;
      send.mockImplementationOnce(
        () =>
          new Promise((done) => {
            acknowledge = done;
          }),
      );
      await render();
      await act(async () => button()!.click());
      expect(send).toHaveBeenCalledOnce();
      if (leave === "unmount") {
        await act(async () => root.unmount());
        root = createRoot(container);
      } else {
        row = { ...row, sessionId: `${row.sessionId}-next` };
        channel = { ...channel, state: { ...channel.state!, sessionId: row.sessionId } };
        await render();
        expect(button()!.disabled).toBe(false);
      }
      await act(async () => acknowledge({ data: { id: "A", gen: 3 } }));
      expect(open).not.toHaveBeenCalled();
    },
  );
  it("missing switch ack pins navigate unpinned, never using the tapped identity", async () => {
    send.mockResolvedValue({ data: null });
    await render();
    await act(async () => button()!.click());
    expect(open).toHaveBeenCalledExactlyOnceWith("switch-host", row.sessionId, "side", {});
  });
  it.each(["unmount", "session-change"])(
    "queued switch is invalidated on %s before its send or navigation",
    async (leave) => {
      Object.assign(channel.state!.side!, { gen: 1, open: true });
      await act(async () => root.render(<SideRoute row={row} channel={channel} />));
      let acknowledge!: (value: unknown) => void;
      send.mockImplementationOnce(
        () =>
          new Promise((done) => {
            acknowledge = done;
          }),
      );
      focus.active = false;
      await act(async () =>
        root.render(
          <>
            <SideRoute row={row} channel={channel} />
            <SideSwitch hostId="switch-host" row={row} channel={channel} />
          </>,
        ),
      );
      await act(async () => button()!.click());
      expect(send).toHaveBeenCalledTimes(1); // hide is still in flight
      if (leave === "unmount") {
        await act(async () => root.unmount());
        root = createRoot(container);
      } else {
        row = { ...row, sessionId: `${row.sessionId}-next` };
        channel = { ...channel, state: { ...channel.state!, sessionId: row.sessionId } };
        await render();
      }
      await act(async () => acknowledge({ data: { id: "A", gen: 2 } }));
      expect(send).toHaveBeenCalledTimes(1);
      expect(open).not.toHaveBeenCalled();
    },
  );
  it("other failure uses main's existing error line", async () => {
    send.mockRejectedValue(new RemoteError("refused", "busy"));
    await render();
    await act(async () => button()!.click());
    expect(container.querySelector('[data-testid="error"]')!.textContent).not.toBe("");
    expect(open).not.toHaveBeenCalled();
  });
});
