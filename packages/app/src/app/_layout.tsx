// Unistyles must be configured before any component module creates a StyleSheet.
import "@/styles/unistyles";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { PortalProvider } from "@gorhom/portal";
import { Stack } from "expo-router";
import { useEffect, type ReactNode } from "react";
import { Dimensions, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { AppearanceProvider } from "@/appearance/provider";
import { AppLifecycle, HostKeyPromptHost } from "@/components/pi/app-lifecycle";
import { useAnySheetOpen } from "@/components/pi/sheet-a11y";
import { ThemedStatusBar } from "@/components/pi/themed-status-bar";
import { ToastProvider } from "@/contexts/toast-context";
import { KeyboardShiftProvider } from "@/keyboard/shift";
import { PlaceRestorer, savePlaceForReload } from "@/navigation/place-restorer";
import { ThemedStack } from "@/navigation/themed-stack";
import { NotificationNavigation } from "@/notifications/components";
import { fontScaleChanged } from "@/utils/font-scale";
import { reloadForFontScale } from "../../modules/pi-font-scale";

/**
 * Android: when the system font size changes while Pi runs, RN keeps the old text measurements
 * (clipped labels, overlapping rows). Reload once at the new scale; a cold start is already right.
 * The user's place is saved first and rebuilt after the reload (PlaceRestorer).
 */
function useReloadOnFontScaleChange() {
  useEffect(() => {
    const initial = Dimensions.get("window").fontScale;
    let reloading = false;
    const sub = Dimensions.addEventListener("change", ({ window }) => {
      if (reloading || !fontScaleChanged(initial, window.fontScale)) return;
      reloading = true;
      void savePlaceForReload().then(() => reloadForFontScale());
    });
    return () => sub.remove();
  }, []);
}

// QueryClientProvider, I18nProvider, SafeAreaProvider and the error boundary live in
// root-app.tsx, above the router, so they survive an error-recovery remount.

const SCREEN_OPTIONS = { headerShown: false } as const;

// PortalProvider must stay inside the app-wide context providers: portaled sheets render at the
// host's location and consume theme/query/toast context from above it.
function RootProviders({ children }: { children: ReactNode }) {
  return (
    <KeyboardProvider>
      <KeyboardShiftProvider>
        <AppearanceProvider>
          <ToastProvider>
            <PortalProvider>
              <BottomSheetModalProvider>{children}</BottomSheetModalProvider>
            </PortalProvider>
          </ToastProvider>
        </AppearanceProvider>
      </KeyboardShiftProvider>
    </KeyboardProvider>
  );
}

/** Left/right safe areas (landscape cutout, side navigation bar); top/bottom are per screen. */
function SideInsets({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  // A sheet is a dialog: the screens under it leave the accessibility tree while it is open.
  const sheetOpen = useAnySheetOpen();
  return (
    <View
      style={[styles.fill, { paddingLeft: insets.left, paddingRight: insets.right }]}
      importantForAccessibility={sheetOpen ? "no-hide-descendants" : "auto"}
      accessibilityElementsHidden={sheetOpen}
    >
      {children}
    </View>
  );
}

export default function RootLayout() {
  useReloadOnFontScaleChange();
  return (
    <GestureHandlerRootView style={styles.fill}>
      <View style={styles.surface}>
        <RootProviders>
          <ThemedStatusBar />
          <SideInsets>
            <ThemedStack screenOptions={SCREEN_OPTIONS}>
              <Stack.Screen name="index" />
              <Stack.Screen name="h/[hostId]/index" />
              <Stack.Screen name="h/[hostId]/s/[sessionId]" />
              <Stack.Screen name="h/[hostId]/f/[sessionId]/[tool]" />
            </ThemedStack>
          </SideInsets>
          <AppLifecycle />
          <NotificationNavigation />
          <PlaceRestorer />
          <HostKeyPromptHost />
        </RootProviders>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: {
    flex: 1,
  },
  surface: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
}));
