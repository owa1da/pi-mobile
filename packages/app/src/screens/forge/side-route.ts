import type { NavigationProp, ParamListBase } from "@react-navigation/native";

type StackNavigation = Pick<NavigationProp<ParamListBase>, "dispatch"> & {
  getState(): ReturnType<NavigationProp<ParamListBase>["getState"]> | undefined;
};
const retained = new Set<{ navigation: StackNavigation }>();
let sideEntry = 0;

export function visibilityIdentity(data: unknown): { id: string; gen: number } | undefined {
  if (!data || typeof data !== "object" || !("id" in data) || !("gen" in data)) return;
  if (
    typeof data.id !== "string" ||
    !data.id ||
    typeof data.gen !== "number" ||
    !Number.isSafeInteger(data.gen) ||
    data.gen < 0
  )
    return;
  return { id: data.id, gen: data.gen };
}

/** Bind navigation to the accepted action, not whatever side polling sees next. */
export function sideRouteParams(data: unknown): Record<string, string> {
  const identity = visibilityIdentity(data);
  return identity ? { sideId: identity.id, sideGen: String(identity.gen) } : {};
}

/** SET_PARAMS merges a retained route: clear the previous entry's text and ownership. */
export function sideRouteIntent(extra: Record<string, string>) {
  return {
    ...extra,
    arg: extra.arg ?? "",
    sideId: extra.sideId ?? "",
    sideGen: extra.sideGen ?? "",
    sideEntry: String(++sideEntry),
  };
}

/** A retained SideView can find its exact stack entry without native-stack getId/reordering. */
export function retainSideNavigation(navigation: StackNavigation): () => void {
  const entry = { navigation };
  retained.add(entry);
  return () => {
    retained.delete(entry);
  };
}

export function returnToSideRoute(params: Record<string, string>): boolean {
  for (const { navigation } of retained) {
    const state = navigation.getState();
    if (!state) continue;
    const index = state.routes.findLastIndex((route) => {
      const routeParams = route.params as Record<string, unknown> | undefined;
      return (
        route.name === "h/[hostId]/f/[sessionId]/[tool]" &&
        routeParams?.hostId === params.hostId &&
        routeParams?.sessionId === params.sessionId &&
        routeParams?.tool === "side"
      );
    });
    if (index < 0) continue;
    navigation.dispatch({
      type: "SET_PARAMS",
      payload: { params },
      source: state.routes[index].key,
      target: state.key,
    });
    if (state.index > index)
      navigation.dispatch({
        type: "POP",
        payload: { count: state.index - index },
        target: state.key,
      });
    return true;
  }
  return false;
}
