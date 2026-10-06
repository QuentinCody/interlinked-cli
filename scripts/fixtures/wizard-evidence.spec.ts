// Qualification spec v2: only a visible active list can violate the marker property.
// Safety: at the "Apply? [Y/n]" prompt the only enabled actions are "n" and
// Enter, so a run never applies the plan (no hooks, no daemon).
import { always, eventually } from "@antithesishq/bombadil";
import { CharSet } from "@antithesishq/bombadil/actions";
import { actions, extract, weighted } from "@antithesishq/bombadil/terminal";

const lit = (k: string) => ({ TypeText: { CharSet: CharSet.fromLiterals(k) } });

export {
  exitSuccess,
  noReplacementChars,
} from "@antithesishq/bombadil/terminal/defaults/properties";

// ---- extractors ----

const screenRows = extract((state) => {
  const rows: string[] = [];
  for (let i = 0; i < state.grid.size.rows; i++) rows.push(state.grid.rowText(i));
  return rows;
});

const atApplyPrompt = extract((state) => {
  for (let i = state.grid.size.rows - 1; i >= 0; i--) {
    const t = state.grid.rowText(i).trim();
    if (t.length === 0) continue;
    // null = not at the prompt; otherwise the text typed after the colon.
    return t.startsWith("Apply? [Y/n]:") ? t.slice("Apply? [Y/n]:".length).trim() : null;
  }
  return null;
});

const exited = extract((state) => state.exitStatus !== null);

// ---- helpers (run in the spec engine, over extracted rows) ----

function screenText(): string {
  return (screenRows.current ?? []).join("\n");
}

/** Rows of the active arrow-select list: between the last "N) " header and the last hint row. */
function activeListMarkerCount(): number | null {
  const rows = screenRows.current ?? [];
  let hint = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if ((rows[i] ?? "").includes("↑/↓ choose")) {
      hint = i;
      break;
    }
  }
  if (hint < 0 || exited.current) return null;
  if (rows.slice(hint + 1).some(row => /^\s*(Plan\s*$|Apply\?|Aborted)/.test(row))) return null;
  let markers = 0;
  for (let i = hint - 1; i >= 0; i--) {
    const row = rows[i] ?? "";
    if (/^\d\) /.test(row)) return markers;
    if (/^\s+(›|▸) /.test(row)) markers++;
  }
  return null; // No visible header: active-list status is unknown.
}

// ---- properties ----

/** The wizard banner appears within 15 s of start. */
export const bannerAppears = eventually(() =>
  screenText().includes("Interlinked setup"),
).within(15, "seconds");

/** No stack trace or uncaught error text is ever on screen. */
export const noStackTrace = always(() => {
  const t = screenText();
  return !/\n\s+at .+[(:]\d+/.test(t) && !/\b(TypeError|ReferenceError|RangeError|Unhandled)\b/.test(t);
});

/** While an arrow-select list is active, exactly one row carries the marker. */
export const oneSelectionMarker = always(() => {
  const n = activeListMarkerCount();
  return n === null || n === 1;
});

/** Safety oracle: the plan is never applied during the trial. */
export const neverApplied = always(() => !screenText().includes("Setup complete."));

// ---- actions ----

const navigation = new Map<string, number>();
const keys = actions(() => {
  if (exited.current) return [];
  const typed = atApplyPrompt.current;
  // Enter alone means "Y" here, so Enter is enabled only once exactly "n" is typed.
  if (typed !== null) return typed === "n" ? [lit("\r")] : typed === "" ? [lit("n")] : [lit("\u007f")];
  const header = (screenRows.current ?? []).findLast(row => /^\d\) /.test(row));
  if (header && screenText().includes("↑/↓ choose")) {
    const count = navigation.get(header) ?? 0;
    navigation.set(header, count + 1);
    return [lit(count < 8 ? "\u001b[B" : "\r")];
  }
  return [lit("\r")];
});

export const wizardActions = keys;
