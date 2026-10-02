// Wiring for restore-place.ts: screens report where the user is, the font-scale reload saves it,
// and the next start rebuilds the stack once (dashboard, then the session on its tab).

import AsyncStorage from "@react-native-async-storage/async-storage";
import { router, useRootNavigationState } from "expo-router";
import { useEffect } from "react";
import { hostsStore, useHostsLoaded } from "@/stores/app";
import {
  currentPlace,
  reportPlace,
  restoreSteps,
  savePlace,
  takeSavedPlace,
  type Place,
} from "./restore-place";

/** While `focused`, this screen is where the user is. */
export function useReportPlace(place: Place, focused: boolean): void {
  const key = JSON.stringify(place);
  useEffect(() => {
    if (focused) reportPlace(JSON.parse(key) as Place);
  }, [focused, key]);
}

/** Persist the current place; resolves (never rejects) so a reload always follows. */
export async function savePlaceForReload(): Promise<void> {
  try {
    await savePlace(AsyncStorage, currentPlace(), Date.now());
  } catch {
    // Losing the place is better than skipping the reload that fixes the text layout.
  }
}

// Module scope: one restore per JS start, even if the root layout remounts.
let restoreStarted = false;

/** Once hosts are loaded and the navigator is mounted, rebuild the saved stack above Hosts. */
export function PlaceRestorer() {
  const hostsLoaded = useHostsLoaded();
  const navigationReady = Boolean(useRootNavigationState()?.key);
  useEffect(() => {
    if (!hostsLoaded || !navigationReady || restoreStarted) return;
    restoreStarted = true;
    void (async () => {
      const place = await takeSavedPlace(AsyncStorage, Date.now()).catch(() => null);
      const steps = restoreSteps(place, (id) => hostsStore.getState().getHost(id));
      for (const step of steps) router.push(step);
    })();
  }, [hostsLoaded, navigationReady]);
  return null;
}
