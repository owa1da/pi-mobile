import type { TextInputProps } from "react-native";

/** A file pasted into a native text input (image paste support). */
export interface NativePastedFile {
  fileName: string;
  fileSize: number;
  type: string;
  uri: string;
}

export interface EditingTextInputHandle {
  focus(): void;
  blur(): void;
  isFocused(): boolean;
  getText(): string;
  replaceText(text: string, selection?: { start: number; end: number }): void;
  /** Clear the editor and reset its intrinsic layout, preserving focus intent. */
  reset(): void;
  getNativeRef(): unknown;
}

export interface EditingTextInputProps extends Omit<
  TextInputProps,
  "defaultValue" | "onChangeText" | "value"
> {
  initialValue?: string;
  onChangeText?: (text: string) => void;
  onPasteImages?: (files: readonly NativePastedFile[]) => void;
  onPasteError?: (message: string) => void;
  variant?: "default" | "bottom-sheet";
}
