// Snap points of the forge sheets over the session. A sheet rises to its last snap point when the
// keyboard opens (keyboardBehavior "extend"), and what is left above the keyboard is all its body
// gets. With one 55% point, a sheet with a text field had no room left once the keyboard rose: the
// fields collapsed out of view, the focused field lost focus, and Android moved focus to the
// header's Back button, so the next space typed went Back (session → dashboard → Hosts).

/** The forge sheets that hold a text field. */
export const FIELD_SHEETS: ReadonlySet<string> = new Set(["pause", "export", "rename", "branch"]);

const RESTING = "55%";
/** Where a field sheet rises with the keyboard up: as the add-host sheet, near full height. */
const WITH_KEYBOARD = "90%";

const FIELD_SNAP = [RESTING, WITH_KEYBOARD];
const PLAIN_SNAP = [RESTING];

export function sheetSnapPoints(kind: string | undefined): string[] {
  return kind && FIELD_SHEETS.has(kind) ? FIELD_SNAP : PLAIN_SNAP;
}

/** The highest snap point, as a fraction of the screen. */
export function topSnapFraction(points: readonly string[]): number {
  return Math.max(...points.map((p) => Number.parseFloat(p) / 100));
}
