// Unistyles must be configured before any component module creates a StyleSheet.
import "@/styles/unistyles";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { PortalProvider } from "@gorhom/portal";
import { Stack } from "expo-router";
import type { ReactNode } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { AppearanceProvider } from "@/appearance/provider";
import { AppLifecycle, HostKeyPromptHost } from "@/components/pi/app-lifecycle";
import { ToastProvider } from "@/contexts/toast-context";
import { KeyboardShiftProvider } from "@/keyboard/shift";
import { ThemedStack } from "@/navigation/themed-stack";

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
  return (
    <View style={[styles.fill, { paddingLeft: insets.left, paddingRight: insets.right }]}>
      {children}
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.fill}>
      <View style={styles.surface}>
        <RootProviders>
          <SideInsets>
            <ThemedStack screenOptions={SCREEN_OPTIONS}>
              <Stack.Screen name="index" />
              <Stack.Screen name="h/[hostId]/index" />
              <Stack.Screen name="h/[hostId]/s/[sessionId]" />
            </ThemedStack>
          </SideInsets>
          <AppLifecycle />
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
