import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlatListProps, LayoutChangeEvent } from "react-native";
import { setChatHistory, type ChatRow } from "@/screens/session/chat-rows";
import { ChatView } from "./chat-view";

const probe = vi.hoisted(() => ({
  list: null as FlatListProps<ChatRow> | null,
  scrollToOffset: vi.fn(),
  layouts: [] as ((event: LayoutChangeEvent) => void)[],
}));

vi.mock("react-native", async () => {
  const { createElement, useImperativeHandle } = await import("react");
  interface Props {
    children?: ReactNode;
    style?: Record<string, unknown>;
    testID?: string;
    pointerEvents?: string;
    onPress?: () => void;
    onLayout?: (event: LayoutChangeEvent) => void;
  }
  const View = (props: Props) => {
    if (props.onLayout) probe.layouts.push(props.onLayout);
    return createElement(
      "div",
      {
        "data-testid": props.testID,
        "data-style": JSON.stringify(props.style),
        "data-pointer-events": props.pointerEvents,
      },
      props.children,
    );
  };
  return {
    Platform: { select: (values: Record<string, unknown>) => values.default },
    View,
    Text: ({ children }: Props) => createElement("span", null, children),
    Pressable: ({ children, onPress, style, testID }: Props) =>
      createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          "data-testid": testID,
          "data-style": JSON.stringify(style),
        },
        children,
      ),
    FlatList: (props: FlatListProps<ChatRow> & { ref: React.Ref<unknown> }) => {
      probe.list = props;
      if (props.onLayout) probe.layouts.push(props.onLayout);
      useImperativeHandle(props.ref, () => ({ scrollToOffset: probe.scrollToOffset }));
      return createElement(
        "div",
        { "data-testid": props.testID },
        props.ListHeaderComponent as ReactNode,
        Array.from(props.data ?? []).map((item, index) =>
          createElement(
            "div",
            { key: item.key },
            props.renderItem?.({
              item,
              index,
              separators: { highlight: vi.fn(), unhighlight: vi.fn(), updateProps: vi.fn() },
            }),
          ),
        ),
      );
    },
  };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/message", () => ({
  UserMessage: ({ message }: { message: string }) => <span>{message}</span>,
  AssistantMessage: ({ message }: { message: string }) => <span>{message}</span>,
  ToolCall: () => null,
}));
vi.mock("./icons", () => ({
  MutedSpinner: () => null,
  ThemedChevronDown: () => null,
  ThemedChevronRight: () => null,
  mutedColor: () => ({}),
}));
vi.mock("./note-row", () => ({ NoteRow: () => null }));

const rows: ChatRow[] = [
  { kind: "user", key: "old", text: "Earlier question", timestamp: 0, pending: false },
  { kind: "assistant", key: "new", text: "Newest output", timestamp: 1, phase: "complete" },
];

describe("ChatView transcript ownership", () => {
  let root: Root;
  let container: HTMLElement;
  let dom: JSDOM;
  let localSendScroll: React.RefObject<number>;
  beforeEach(() => {
    localSendScroll = { current: 0 };
    vi.useFakeTimers();
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    probe.list = null;
    probe.layouts = [];
    probe.scrollToOffset.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    dom.window.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const render = (
    activity: React.ReactElement | null = null,
    loading = false,
    data = rows,
    localSendCount = 0,
  ) =>
    act(() =>
      root.render(
        <ChatView
          rows={data}
          loading={loading}
          activity={activity}
          localSendCount={localSendCount}
          localSendScroll={localSendScroll}
        />,
      ),
    );
  const commitContent = () => act(() => probe.list!.onContentSizeChange?.(320, 1200));

  it("scrolls to newest once per local send from beyond 400pt, never incoming output or history", () => {
    render();
    layout(600);
    scroll(800);
    const echo: ChatRow = { kind: "user", key: "echo", text: "sent", timestamp: 2, pending: true };
    render(null, false, [...rows, echo], 1);
    commitContent();
    commitContent();
    expect(probe.scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 0, animated: true });
    render(
      null,
      false,
      [
        ...rows,
        echo,
        { kind: "assistant", key: "reply", text: "incoming", timestamp: 3, phase: "complete" },
      ],
      1,
    );
    commitContent();
    render(null, false, [{ ...echo, key: "history", pending: false }, ...rows, echo], 1);
    commitContent();
    expect(probe.scrollToOffset).toHaveBeenCalledTimes(1);
    render(null, false, [...rows, echo, { ...echo, key: "echo2" }], 2);
    commitContent();
    expect(probe.scrollToOffset).toHaveBeenCalledTimes(2);
  });

  it("retries an unlaid-out list once on the next content commit", () => {
    render();
    layout(600);
    probe.scrollToOffset.mockImplementationOnce(() => {
      throw new Error("not laid out");
    });
    render(
      null,
      false,
      [...rows, { kind: "user", key: "echo", text: "sent", timestamp: 2, pending: true }],
      1,
    );
    commitContent();
    commitContent();
    commitContent();
    expect(probe.scrollToOffset).toHaveBeenCalledTimes(2);
  });

  it("scrolls once when content commits before the first layout", () => {
    render(
      null,
      false,
      [...rows, { kind: "user", key: "echo", text: "sent", timestamp: 2, pending: true }],
      1,
    );
    commitContent();
    layout(600);
    commitContent();
    expect(probe.scrollToOffset).toHaveBeenCalledTimes(1);
  });

  it("does not replay a handled send with a pending echo across remount", () => {
    const data: ChatRow[] = [
      ...rows,
      { kind: "user", key: "echo", text: "sent", timestamp: 2, pending: true },
    ];
    const mount = () =>
      act(() =>
        root.render(
          <ChatView
            rows={data}
            loading={false}
            localSendCount={1}
            localSendScroll={localSendScroll}
          />,
        ),
      );
    mount();
    layout(600);
    commitContent();
    expect(probe.scrollToOffset).toHaveBeenCalledTimes(1);
    act(() => root.render(null));
    mount();
    layout(600);
    commitContent();
    expect(probe.scrollToOffset).toHaveBeenCalledTimes(1);
  });
  it("does not replay an old send counter when remounted", () => {
    localSendScroll.current = 3;
    render(null, false, rows, 3);
    commitContent();
    expect(probe.scrollToOffset).not.toHaveBeenCalled();
  });
  const scroll = (offset: number) =>
    act(() => {
      probe.list!.onScroll!({ nativeEvent: { contentOffset: { y: offset } } } as Parameters<
        NonNullable<FlatListProps<ChatRow>["onScroll"]>
      >[0]);
      vi.advanceTimersByTime(180);
    });
  const latest = () => container.querySelector('[data-testid="chat-jump-latest"]');
  const style = (element: Element) => JSON.parse(element.getAttribute("data-style")!);
  const layout = (height: number) =>
    act(() => {
      for (const callback of new Set(probe.layouts))
        callback({ nativeEvent: { layout: { height } } } as LayoutChangeEvent);
    });

  it("floats with pass-through outside a >=44pt control and no reserved band", () => {
    render();
    scroll(401);
    const overlay = latest()!.parentElement!;
    expect(style(overlay)).toMatchObject({ position: "absolute", left: 0, right: 0, bottom: 8 });
    expect(style(overlay).height).toBeUndefined();
    expect(overlay.getAttribute("data-pointer-events")).toBe("box-none");
    expect(style(latest()!).minHeight).toBeGreaterThanOrEqual(44);
    expect(style(latest()!).minWidth).toBeGreaterThanOrEqual(44);
    expect(style(latest()!).height).toBeUndefined();
  });

  it("visibility never changes list geometry, anchoring, or offsets, including former band-sized resizes", () => {
    render();
    const content = probe.list!.contentContainerStyle;
    const anchor = probe.list!.maintainVisibleContentPosition;
    layout(600);
    scroll(480);
    expect(latest()).not.toBeNull();
    layout(540); // old JUMP_BAND: this used to force offset 540
    expect(probe.scrollToOffset).not.toHaveBeenCalled();
    expect(probe.list!.contentContainerStyle).toEqual(content);
    expect(probe.list!.maintainVisibleContentPosition).toBe(anchor);
    expect(anchor).toEqual({ minIndexForVisible: 0, autoscrollToTopThreshold: 96 });
    scroll(100);
    layout(600);
    expect(latest()).toBeNull();
    expect(probe.scrollToOffset).not.toHaveBeenCalled();
  });

  it("activation issues only offset 0, not a compensating history scroll", () => {
    render();
    layout(600);
    scroll(800);
    layout(540);
    act(() => latest()!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    scroll(0);
    layout(600);
    expect(probe.scrollToOffset.mock.calls).toEqual([[{ offset: 0, animated: true }]]);
    expect(latest()).toBeNull();
  });

  it("preserves newest-first pinning and never pulls history when output arrives", () => {
    render();
    expect(probe.list!.inverted).toBe(true);
    expect(Array.from(probe.list!.data ?? []).map((row) => row.key)).toEqual(["new", "old"]);
    scroll(800);
    render(null, false, [
      ...rows,
      { kind: "user", key: "next", text: "Follow-up", timestamp: 2, pending: false },
    ]);
    expect(Array.from(probe.list!.data ?? []).map((row) => row.key)).toEqual([
      "next",
      "new",
      "old",
    ]);
    expect(latest()).not.toBeNull();
    expect(probe.scrollToOffset).not.toHaveBeenCalled();
  });

  it("places activity in the inverted list header (newest edge), never in stationary chrome", () => {
    render(<span data-testid="chat-working">Working (4s)</span>);
    expect(probe.list!.ListHeaderComponent).not.toBeNull();
    expect(probe.list!.ListFooterComponent).toBeUndefined();
    const list = container.querySelector('[data-testid="chat-list"]')!;
    expect(list.querySelector('[data-testid="chat-working"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="chat-working"]')).toHaveLength(1);
    scroll(800);
    expect(probe.scrollToOffset).not.toHaveBeenCalled();
    render(null);
    expect(probe.list!.ListHeaderComponent).toBeNull();
    expect(container.querySelector('[data-testid="chat-working"]')).toBeNull();
  });

  it("shows activity before the first transcript message, even while loading", () => {
    render(<span data-testid="chat-working">Working (0s)</span>, true, []);
    expect(
      container.querySelector('[data-testid="chat-list"] [data-testid="chat-working"]'),
    ).not.toBeNull();
  });

  it("requests one older window only after scrolling to the oldest inverted edge", () => {
    const loadOlder = vi.fn();
    const data = setChatHistory([...rows], { loadOlder, loading: false });
    render(null, false, data);
    expect(loadOlder).not.toHaveBeenCalled();
    act(() => probe.list!.onEndReached?.({ distanceFromEnd: 0 }));
    expect(loadOlder).not.toHaveBeenCalled();
    scroll(800);
    act(() => {
      probe.list!.onEndReached?.({ distanceFromEnd: 0 });
      probe.list!.onEndReached?.({ distanceFromEnd: 0 });
    });
    expect(loadOlder).toHaveBeenCalledTimes(1);
    render(null, false, setChatHistory([...rows], { loadOlder, loading: true }));
    expect(probe.list!.ListFooterComponent).toBeDefined();
    scroll(900);
    act(() => probe.list!.onEndReached?.({ distanceFromEnd: 0 }));
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("loads a short transcript on drag after the mount end callback was consumed", () => {
    const loadOlder = vi.fn();
    render(null, false, setChatHistory([...rows], { loadOlder, loading: false }));
    act(() => probe.list!.onEndReached?.({ distanceFromEnd: 0 }));
    expect(loadOlder).not.toHaveBeenCalled();
    const event = {
      nativeEvent: {
        contentOffset: { y: 0 },
        contentSize: { height: 60 },
        layoutMeasurement: { height: 600 },
      },
    } as Parameters<NonNullable<FlatListProps<ChatRow>["onScrollEndDrag"]>>[0];
    act(() => {
      probe.list!.onScrollEndDrag?.(event);
      probe.list!.onMomentumScrollEnd?.(event);
      probe.list!.onEndReached?.({ distanceFromEnd: 0 });
    });
    expect(loadOlder).toHaveBeenCalledTimes(1);
    render(null, false, setChatHistory([...rows], { loadOlder, loading: true }));
    act(() => probe.list!.onScrollEndDrag?.(event));
    expect(loadOlder).toHaveBeenCalledTimes(1);
    render(null, false, setChatHistory([...rows], { loadOlder, loading: false }));
    act(() => probe.list!.onScrollEndDrag?.(event));
    expect(loadOlder).toHaveBeenCalledTimes(2);
    render(null, false, [...rows]); // No older history left.
    act(() => {
      probe.list!.onScrollEndDrag?.(event);
      probe.list!.onMomentumScrollEnd?.(event);
    });
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });

  it("loads on a settled oldest-edge gesture even without another end callback", () => {
    const loadOlder = vi.fn();
    render(null, false, setChatHistory([...rows], { loadOlder, loading: false }));
    const event = (y: number) =>
      ({
        nativeEvent: {
          contentOffset: { y },
          contentSize: { height: 2000 },
          layoutMeasurement: { height: 600 },
        },
      }) as Parameters<NonNullable<FlatListProps<ChatRow>["onScrollEndDrag"]>>[0];
    act(() => probe.list!.onScrollEndDrag?.(event(500)));
    expect(loadOlder).not.toHaveBeenCalled();
    act(() => {
      probe.list!.onScrollEndDrag?.(event(1400));
      probe.list!.onMomentumScrollEnd?.(event(1400));
    });
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("cancels pending visibility updates on unmount", () => {
    render();
    act(() =>
      probe.list!.onScroll!({ nativeEvent: { contentOffset: { y: 800 } } } as Parameters<
        NonNullable<FlatListProps<ChatRow>["onScroll"]>
      >[0]),
    );
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });
});
