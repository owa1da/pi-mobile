// A themed confirmation sheet (replaces the Material Alert): title, one sentence, Cancel (ghost) and
// a destructive verb. Same header, footer and spacing as every other sheet.

import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { SheetActions, sheetActionStyles } from "./sheet-actions";

interface ConfirmSheetProps {
  visible: boolean;
  title: string;
  body: string;
  cancelLabel: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  onDismiss?: () => void;
  testID?: string;
}

export function ConfirmSheet({
  visible,
  title,
  body,
  cancelLabel,
  confirmLabel,
  onConfirm,
  onCancel,
  onDismiss,
  testID,
}: ConfirmSheetProps) {
  const header = useMemo(() => ({ title }), [title]);
  const footer = useMemo(
    () => (
      <SheetActions>
        <Button
          variant="ghost"
          onPress={onCancel}
          style={sheetActionStyles.button}
          testID={testID ? `${testID}-cancel` : undefined}
        >
          {cancelLabel}
        </Button>
        <Button
          variant="destructive"
          onPress={onConfirm}
          style={sheetActionStyles.button}
          testID={testID ? `${testID}-confirm` : undefined}
        >
          {confirmLabel}
        </Button>
      </SheetActions>
    ),
    [cancelLabel, confirmLabel, onCancel, onConfirm, testID],
  );
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onCancel}
      onDismiss={onDismiss}
      footer={footer}
      fitContent
      testID={testID}
    >
      <View style={styles.body}>
        <Text style={styles.text}>{body}</Text>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { paddingBottom: theme.spacing[4] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base, lineHeight: 21 },
}));
