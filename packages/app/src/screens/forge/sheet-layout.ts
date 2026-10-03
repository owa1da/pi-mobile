// The forge sheets over the session rest at their content's height (fitSnapPoints). A sheet rises
// to its last snap point when the keyboard opens (keyboardBehavior "extend"), and what is left above
// the keyboard is all its body gets. With one 55% point, a sheet with a text field had no room left
// once the keyboard rose: the fields collapsed out of view, the focused field lost focus, and
// Android moved focus to the header's Back button, so the next space typed went Back. A sheet with
// a field therefore always has a 90% point for the keyboard.

/** The forge sheets that hold a text field. */
export const FIELD_SHEETS: ReadonlySet<string> = new Set(["pause", "export", "rename", "branch"]);
