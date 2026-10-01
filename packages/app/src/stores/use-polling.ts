// React bindings for polling: only while the screen is focused and the app is in the foreground.

import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { createPoller, type Poller } from "./poller";

export function useScreenFocused(): boolean {
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  return focused;
}

export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next: AppStateStatus) => {
      setActive(next === "active");
    });
    return () => subscription.remove();
  }, []);
  return active;
}

/** Runs `run` every `intervalMs` (or the delay it returns) while `active`. Returns `kick`. */
export function usePoller(
  run: () => Promise<number | void> | number | void,
  intervalMs: number,
  active: boolean,
): () => void {
  const runRef = useRef(run);
  runRef.current = run;
  const pollerRef = useRef<Poller | null>(null);
  if (!pollerRef.current) {
    pollerRef.current = createPoller({ intervalMs, run: () => runRef.current() });
  }
  const poller = pollerRef.current;
  useEffect(() => {
    if (active) poller.start();
    else poller.stop();
    return () => poller.stop();
  }, [active, poller]);
  return useCallback(() => poller.kick(), [poller]);
}
