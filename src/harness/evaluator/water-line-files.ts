// ===========================================
// Water-line file list — ONE source of truth
// ===========================================
//
// A "water-line" is a committed ratchet baseline under `.interlinked/`:
// lowering one defeats every ratchet at once, which is why the baseline
// guards (intent / bash / effect) and the replay state archive all key off
// the SAME list. Before this module the list was retyped in five places and
// three copies disagreed — the replay archive omitted three files, so a
// Tier-2 restore replayed a partial water-line state.
//
// OPEN QUESTION (policy, do not decide in a refactor): `workspace-effects.ts`
// tracks a WIDER set of 19 control paths (guard rules, check policy, config,
// package allowlist, verify suppressions, suite baseline …). Should the three
// baseline guards widen from this 9-file water-line set to that control-path
// superset? Widening means blocking hand-edits to guard-rules.json and
// friends, which is a real policy change with its own FP profile — decide it
// deliberately, with data, not as a side effect of de-duplicating a list.
// Today: this 10-file set is the guard set; workspace-effects derives its
// baseline subset from here so the two cannot silently drift apart.

/** Canonical water-line stems (basename without the `.json` extension). */
export const WATER_LINE_FILES = [
	"coverage-baseline",
	"coverage-edit-baseline",
	"mutation-baseline",
	"mutation-manifest",
	"large-files-baseline",
	"untested-files-baseline",
	"metric-caps",
	"skipped-tests-baseline",
	"check-evidence-baseline",
	// Per-function complexity grandfather ledger (`interlinked caps ratchet`).
	// Promoted from the sibling-detector seam 2026-09-02 so the bash arm, the
	// effect arm, and the replay archive cover it like every other water-line.
	"function-complexity-baseline",
] as const;

/** One canonical water-line stem. */
export type WaterLineStem = (typeof WATER_LINE_FILES)[number];

/** Derived view: file basenames, e.g. `metric-caps.json`. */
export const WATER_LINE_BASENAMES: readonly string[] = WATER_LINE_FILES.map(
	(stem) => `${stem}.json`,
);

/** Derived view: repo-relative paths, e.g. `.interlinked/metric-caps.json`. */
export const WATER_LINE_PATHS: readonly string[] = WATER_LINE_BASENAMES.map(
	(base) => `.interlinked/${base}`,
);

/** Derived view: exact-match regex; capture group 1 is the stem. */
export const WATER_LINE_RE = new RegExp(
	`(?:^|/)\\.interlinked/(${WATER_LINE_FILES.join("|")})\\.json$`,
);

/** The water-line stem a path names, or null when it names no water-line. */
export function waterLineStem(filePath: string): WaterLineStem | null {
	const match = WATER_LINE_RE.exec(filePath.replace(/\\/g, "/"));
	// SAFETY: group 1 of WATER_LINE_RE is an alternation built from
	// WATER_LINE_FILES, so any capture is by construction a WaterLineStem.
	return (match?.[1] as WaterLineStem | undefined) ?? null;
}

/** True when `filePath` names a `.interlinked/` water-line file. */
export function isWaterLinePath(filePath: string): boolean {
	return waterLineStem(filePath) !== null;
}
