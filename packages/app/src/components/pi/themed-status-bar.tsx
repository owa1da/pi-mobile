// App-wide status bar whose icon style follows the active theme (dark icons on light, light on
// dark). React Native's StatusBar stacks: a screen may mount its own <StatusBar hidden /> on top.

import { StatusBar } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { statusBarStyleFor } from "@/utils/status-bar-style";

export const ThemedStatusBar = withUnistyles(StatusBar, (theme) => ({
  barStyle: statusBarStyleFor(theme.colorScheme),
  translucent: true,
  backgroundColor: "transparent",
}));
