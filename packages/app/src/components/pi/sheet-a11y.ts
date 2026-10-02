// While a bottom sheet is open, the screen under it is hidden from TalkBack (Android has no
// accessibilityViewIsModal), so swiping through the sheet never walks into the page behind it.
// Sheets register while visible; the root layout reads the count.

import { useEffect, useSyncExternalStore } from "react";
import { isWeb } from "@/constants/platform";

let openSheets = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getOpen = () => openSheets > 0;

export function useAnySheetOpen(): boolean {
  return useSyncExternalStore(subscribe, getOpen, getOpen);
}

/** Counts this sheet as open while `open` is true (native only); always releases on unmount. */
export function useRegisterOpenSheet(open: boolean) {
  useEffect(() => {
    if (!open || isWeb) return undefined;
    openSheets += 1;
    emit();
    return () => {
      openSheets = Math.max(0, openSheets - 1);
      emit();
    };
  }, [open]);
}
