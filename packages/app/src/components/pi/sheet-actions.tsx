// The one sheet footer: full width, every button `flex: 1` at the md control height (44dp), so a
// loading spinner never changes the footer's height. Secondary (ghost) first, primary last.

import { Children, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function SheetActions({ children }: { children: ReactNode }) {
  return (
    <View style={styles.row}>
      {Children.map(children, (child) =>
        child == null || child === false ? null : <View style={styles.cell}>{child}</View>,
      )}
    </View>
  );
}

/** Style for a Button inside SheetActions: fills its cell. */
export const sheetActionStyles = StyleSheet.create(() => ({
  button: { flex: 1 },
}));

const styles = StyleSheet.create((theme) => ({
  row: { flex: 1, flexDirection: "row", gap: theme.spacing[3] },
  cell: { flex: 1, flexDirection: "row" },
}));
