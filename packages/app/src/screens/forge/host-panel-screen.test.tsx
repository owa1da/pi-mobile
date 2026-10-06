import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "@/host/types";
import { RemoteError } from "@/remote/errors";
import { HostPanelScreen } from "./host-panel-screen";

const probe = vi.hoisted(() => ({
  name: "usage",
  status: "connected",
  rows: [] as SessionRow[],
  snapshot: undefined as unknown,
  readSnapshot: vi.fn(),
  start: vi.fn(),
  send: vi.fn(),
  useChannel: vi.fn(),
  translate: (key: string, args?: { time?: string }) => (args?.time ? `as of ${args.time}` : key),
}));
vi.mock("expo-router", () => ({ useLocalSearchParams: () => ({ hostId: "h", name: probe.name }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: probe.translate,
  }),
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement("div", { "data-testid": testID }, children);
  return {
    View,
    Text: View,
    ScrollView: View,
    Platform: { select: (values: Record<string, unknown>) => values.default },
  };
});
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    testID,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    testID: string;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" data-testid={testID} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/markdown/renderer", () => ({
  MarkdownRenderer: ({ text }: { text: string }) => <div>{text}</div>,
}));
vi.mock("@/components/pi/sheet-actions", () => ({
  ActionBar: ({ children }: { children: ReactNode }) => children,
  sheetActionStyles: {},
}));
vi.mock("@/components/pi/empty-state", () => ({
  EmptyState: ({ title, testID }: { title: string; testID: string }) => (
    <div data-testid={testID}>{title}</div>
  ),
}));
vi.mock("@/stores/app", () => ({
  connectionStore: {
    getState: () => ({
      ensureConnected: vi.fn(),
      getService: () => ({ readPanelSnapshot: probe.readSnapshot, startSession: probe.start }),
    }),
  },
  refreshSessions: vi.fn().mockResolvedValue(undefined),
  useHostsLoaded: () => true,
  useHostConnection: () => ({ status: probe.status }),
  useSessionsEntry: () => ({ snapshot: { rows: probe.rows } }),
}));
vi.mock("@/navigation/place-restorer", () => ({ useReportPlace: vi.fn() }));
vi.mock("@/stores/use-polling", () => ({
  useScreenFocused: () => true,
  useAppActive: () => true,
  usePoller: () => {},
}));
vi.mock("@/screens/session/use-remote-channel", () => ({
  useRemoteChannel: (...args: unknown[]) => {
    probe.useChannel(...args);
    return { available: true, loaded: true, send: probe.send };
  },
}));
vi.mock("@/components/headers/back-header", () => ({ BackHeader: () => null }));
vi.mock("@/components/pi/icons", () => ({ MutedSpinner: () => null }));
vi.mock("@/components/tool-call-sheet", () => ({ ToolCallSheetProvider: () => null }));
vi.mock("@/assistant-file-links", () => ({ AssistantFileLinkResolverProvider: () => null }));
vi.mock("@/contexts/toast-context", () => ({ useToast: vi.fn() }));
vi.mock("@/keyboard/shift", () => ({ useKeyboardShiftStyle: () => ({ style: {} }) }));
vi.mock("react-native-reanimated", () => ({ default: {} }));
vi.mock("./parts", async (importOriginal) => {
  const { useForgeAction } = await importOriginal<typeof import("./parts")>();
  return {
    ForgeFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    TranscriptProviders: ({ children }: { children: ReactNode }) => children,
    Loading: () => <div>loading</div>,
    UpdateForge: () => <div>unsupported</div>,
    ErrorLine: ({ message }: { message: string | null }) =>
      message ? <div data-testid="forge-error">{message}</div> : null,
    forgeStyles: {},
    useForgeAction,
  };
});

describe.each(["usage", "changelog"])("host /%s panel", (name) => {
  let root: Root;
  let container: HTMLElement;
  let dom: JSDOM;
  const data =
    name === "usage"
      ? { accounts: [{ name: "Account", meters: [] }] }
      : { markdown: "## Release notes" };
  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    container = document.createElement("div");
    root = createRoot(container);
    probe.name = name;
    probe.status = "connected";
    probe.rows = [];
    probe.snapshot = undefined;
    probe.readSnapshot.mockReset().mockImplementation(async () => probe.snapshot);
    probe.start.mockReset();
    probe.useChannel.mockReset();
    probe.send.mockReset().mockResolvedValue({ data });
  });
  afterEach(() => {
    act(() => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  });
  async function render() {
    await act(async () => root.render(<HostPanelScreen />));
  }
  it("uses an existing live remote channel, no snapshot or session start", async () => {
    const completed = { sessionId: "done", live: false, pid: 1, remote: 1 } as SessionRow;
    const live = { sessionId: "live", live: true, pid: 2, remote: 1 } as SessionRow;
    probe.rows = [completed, { ...live, remote: undefined }, live];
    await render();
    expect(probe.useChannel).toHaveBeenCalledWith("h", live, expect.anything(), true);
    expect(probe.send).toHaveBeenCalledExactlyOnceWith(
      name === "usage" ? "usage.refresh" : "changelog.read",
      {},
    );
    expect(probe.readSnapshot).not.toHaveBeenCalled();
    expect(probe.start).not.toHaveBeenCalled();
    if (name === "usage") {
      await act(async () =>
        (container.querySelector('[data-testid="usage-refresh"]') as HTMLButtonElement).click(),
      );
      expect(probe.send).toHaveBeenLastCalledWith("usage.refresh", { force: true });
    }
  });
  it("shows a timestamped read-only snapshot without a channel or start", async () => {
    probe.rows = [{ sessionId: "done", live: false, pid: 1, remote: 1 } as SessionRow];
    probe.snapshot = { v: 1, at: 1234, data };
    await render();
    expect(probe.readSnapshot).toHaveBeenCalledExactlyOnceWith(name);
    expect(container.textContent).toContain(name === "usage" ? "Account" : "Release notes");
    expect(container.textContent).toContain(`as of ${new Date(1234).toLocaleString()}`);
    expect(container.textContent).toContain("pi.forge.panel.readOnly");
    expect(probe.useChannel).not.toHaveBeenCalled();
    expect(probe.send).not.toHaveBeenCalled();
    expect(probe.start).not.toHaveBeenCalled();
    if (name === "usage")
      expect(
        (container.querySelector('[data-testid="usage-refresh"]') as HTMLButtonElement).disabled,
      ).toBe(true);
  });
  it.each(["no-channel", "unknown-action", "refused", "error"] as const)(
    "falls back to a read-only snapshot after live %s",
    async (code) => {
      probe.rows = [{ sessionId: "live", live: true, pid: 2, remote: 1 } as SessionRow];
      probe.send.mockRejectedValue(new RemoteError(code));
      probe.snapshot = { v: 1, at: 1234, data };
      await render();
      expect(probe.readSnapshot).toHaveBeenCalledExactlyOnceWith(name);
      expect(container.textContent).toContain(name === "usage" ? "Account" : "Release notes");
      expect(container.textContent).toContain("pi.forge.panel.readOnly");
      expect(probe.start).not.toHaveBeenCalled();
    },
  );
  it("tries the next live channel before reading a snapshot", async () => {
    probe.rows = [2, 3].map(
      (pid) => ({ sessionId: `live-${pid}`, live: true, pid, remote: 1 }) as SessionRow,
    );
    probe.send.mockRejectedValueOnce(new RemoteError("no-channel"));
    await render();
    expect(probe.useChannel).toHaveBeenCalledWith("h", probe.rows[1], expect.anything(), true);
    expect(container.textContent).toContain(name === "usage" ? "Account" : "Release notes");
    expect(probe.readSnapshot).not.toHaveBeenCalled();
    expect(probe.start).not.toHaveBeenCalled();
  });
  it("bounds live attempts to three before the empty state", async () => {
    probe.rows = [2, 3, 4, 5].map(
      (pid) => ({ sessionId: `live-${pid}`, live: true, pid, remote: 1 }) as SessionRow,
    );
    probe.send.mockRejectedValue(new RemoteError("error"));
    await render();
    expect(probe.send).toHaveBeenCalledTimes(3);
    expect(probe.readSnapshot).toHaveBeenCalledExactlyOnceWith(name);
    expect(container.querySelector('[data-testid="host-panel-empty"]')).not.toBeNull();
    expect(probe.start).not.toHaveBeenCalled();
  });
  it("clears snapshot loading on disconnect and ignores the cancelled read", async () => {
    let resolve!: (value: unknown) => void;
    probe.readSnapshot.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    expect(container.textContent).toContain("loading");
    probe.status = "reconnecting";
    await render();
    expect(container.textContent).not.toContain("loading");
    expect(container.querySelector('[data-testid="host-panel-empty"]')).not.toBeNull();
    probe.status = "connected";
    probe.snapshot = { v: 1, at: 2000, data };
    probe.readSnapshot.mockImplementation(async () => probe.snapshot);
    await render();
    await act(async () => resolve({ v: 1, at: 1000, data }));
    expect(container.textContent).toContain(`as of ${new Date(2000).toLocaleString()}`);
    expect(container.textContent).not.toContain(`as of ${new Date(1000).toLocaleString()}`);
  });
  if (name === "usage")
    it.each(["no-channel", "unknown-action", "refused", "error"] as const)(
      "keeps live data and the error line after a user refresh fails with %s",
      async (code) => {
        probe.rows = [{ sessionId: "live", live: true, pid: 2, remote: 1 } as SessionRow];
        await render();
        probe.send.mockRejectedValueOnce(new RemoteError(code));
        await act(async () =>
          (container.querySelector('[data-testid="usage-refresh"]') as HTMLButtonElement).click(),
        );
        expect(container.textContent).toContain("Account");
        expect(container.querySelector('[data-testid="forge-error"]')).not.toBeNull();
        expect(probe.readSnapshot).not.toHaveBeenCalled();
        expect(probe.start).not.toHaveBeenCalled();
      },
    );
  it("shows a calm empty state when neither source exists", async () => {
    await render();
    expect(container.querySelector('[data-testid="host-panel-empty"]')).not.toBeNull();
    expect(probe.send).not.toHaveBeenCalled();
    expect(probe.start).not.toHaveBeenCalled();
  });
});
