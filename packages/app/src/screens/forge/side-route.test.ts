import { afterEach, describe, expect, it, vi } from "vitest";
import { retainSideNavigation, returnToSideRoute, sideRouteIntent } from "./side-route";

const params = { hostId: "h", sessionId: "s", tool: "side", sideEntry: "2", arg: "words" };
const route = (key: string, tool: string, sessionId = "s") => ({
  key,
  name: "h/[hostId]/f/[sessionId]/[tool]",
  params: { hostId: "h", sessionId, tool },
});
let release: (() => void) | undefined;
afterEach(() => release?.());
function stack(routes: ReturnType<typeof route>[]) {
  const navigation = {
    getState: () => ({
      key: "stack",
      index: routes.length - 1,
      routes,
      routeNames: [],
      type: "stack",
      stale: false as const,
    }),
    dispatch: vi.fn(),
  };
  release = retainSideNavigation(navigation);
  return navigation;
}
describe("exact retained side route", () => {
  it("clears a retained seed on bare /side and identifies repeated explicit seed intents", () => {
    const seeded = sideRouteIntent({ arg: "words" });
    const again = sideRouteIntent({ arg: "words" });
    const bare = sideRouteIntent({});
    expect(seeded.arg).toBe("words");
    expect(again.sideEntry).not.toBe(seeded.sideEntry);
    expect(bare.arg).toBe("");
  });
  it("reuses side below other Forge tools without popping to the wrong dynamic route", () => {
    const navigation = stack([
      route("side", "side"),
      route("model", "model"),
      route("tasks", "tasks"),
    ]);
    expect(returnToSideRoute(params)).toBe(true);
    expect(navigation.dispatch.mock.calls).toEqual([
      [{ type: "SET_PARAMS", payload: { params }, source: "side", target: "stack" }],
      [{ type: "POP", payload: { count: 2 }, target: "stack" }],
    ]);
  });
  it("updates an already-top side's seed without pushing a duplicate", () => {
    const navigation = stack([route("side", "side")]);
    expect(returnToSideRoute(params)).toBe(true);
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
    expect(navigation.dispatch.mock.calls[0][0]).toMatchObject({
      source: "side",
      payload: { params },
    });
  });
  it("never reuses a side for another session or a different Forge tool", () => {
    const navigation = stack([route("other", "side", "other"), route("model", "model")]);
    expect(returnToSideRoute(params)).toBe(false);
    expect(navigation.dispatch).not.toHaveBeenCalled();
  });
});
