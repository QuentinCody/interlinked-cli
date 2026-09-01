// ===========================================
// Engine-finding delta + honest formatting
// ===========================================
//
// Two defects observed 2026-08-21 in the typescript PostToolUse check, both
// visible in one hook response:
//
//   1. WRONG BLOCKING BASELINE. The engine runs project-scoped, but nothing
//      remembered the previous run's diagnostics, so errors introduced by an
//      earlier tool call kept BLOCKING every later edit — including the edits
//      that repaired them, and even read-only commands. A mid-refactor tree
//      could not be fixed through the front door.
//   2. DISHONEST ATTRIBUTION. The result header said "found issues in
//      <edited file>" while every diagnostic lived in another file, and 14
//      identical TS2740 lines rendered as 14 full rows.
//
// This module fixes both. `splitIntroducedFindings` keeps a per-(projectRoot,
// tool) multiset of the previous run's diagnostics — keyed by (file,
// normalized message), deliberately NOT by line, so line drift does not
// resurrect old findings — and classifies each new run's rows as introduced
// (block-worthy) or pre-existing (warn-only). Cold start (no previous run)
// cannot attribute: rows in the edited file stay introduced, rows elsewhere
// downgrade to pre-existing. KNOWN COST of that cold-start rule: the FIRST
// edit after a daemon restart can genuinely break a dependent file and see
// the breakage warn instead of block (external review 2026-08-23, finding 7).
// One under-strict turn per restart is the accepted trade against re-blocking
// every repair edit in an already-broken tree; the warning still surfaces. `formatEngineFindings` names the files that
// actually carry the findings and collapses identical diagnostics.
//
// The store is in-memory daemon state, latest-run-only, bounded by the
// project count the daemon serves. A daemon restart forgets it — see the
// cold-start note above: the restart window trades one possibly-under-strict
// turn (a real cross-file introduction warns instead of blocking) against
// re-blocking every repair edit in an already-broken tree.

export interface EngineFindingRow {
	file: string;
	line: number;
	message: string;
}

interface FindingDelta {
	introduced: EngineFindingRow[];
	preExisting: EngineFindingRow[];
}

/** Previous run's finding multiset per `${projectRoot}\0${tool}`. */
const previousRunByKey = new Map<string, Map<string, number>>();

function storeKey(projectRoot: string, tool: string): string {
	return `${projectRoot}\0${tool}`;
}

/** (file, normalized message) — no line number, so drift keeps identity. */
function findingKey(row: EngineFindingRow): string {
	return `${row.file}\0${row.message.trim().replace(/\s+/g, " ")}`;
}

function toMultiset(rows: readonly EngineFindingRow[]): Map<string, number> {
	const set = new Map<string, number>();
	for (const r of rows) set.set(findingKey(r), (set.get(findingKey(r)) ?? 0) + 1);
	return set;
}

/**
 * Classify this run's findings against the previous run for the same
 * (projectRoot, tool), then record this run as the new baseline. See the
 * module header for the cold-start rule.
 */
export function splitIntroducedFindings(
	projectRoot: string,
	tool: string,
	editedFile: string,
	rows: readonly EngineFindingRow[],
): FindingDelta {
	const key = storeKey(projectRoot, tool);
	const previous = previousRunByKey.get(key);
	const budget = previous ? new Map(previous) : null;
	const introduced: EngineFindingRow[] = [];
	const preExisting: EngineFindingRow[] = [];
	for (const row of rows) {
		if (budget === null) {
			// Cold start: attribution is impossible for other files.
			if (row.file === editedFile) introduced.push(row);
			else preExisting.push(row);
			continue;
		}
		const k = findingKey(row);
		const remaining = budget.get(k) ?? 0;
		if (remaining > 0) {
			budget.set(k, remaining - 1);
			preExisting.push(row);
		} else {
			introduced.push(row);
		}
	}
	previousRunByKey.set(key, toMultiset(rows));
	return { introduced, preExisting };
}

const MAX_DETAIL_GROUPS = 15;
const MAX_LINES_LISTED = 8;

/**
 * Header naming the files that actually carry findings, and a detail block
 * with identical diagnostics collapsed to one row (`×N`, line list).
 */
export function formatEngineFindings(
	editedFile: string,
	rows: readonly EngineFindingRow[],
): { header: string; detail: string } {
	const files = [...new Set(rows.map((r) => r.file))];
	const header =
		files.length === 1
			? files[0] === editedFile
				? editedFile
				: `${files[0]} (while checking ${editedFile})`
			: `${files.length} files (while checking ${editedFile})`;
	// Group by (file, message); keep first-seen order.
	const groups = new Map<string, { row: EngineFindingRow; lines: number[] }>();
	for (const row of rows) {
		const k = findingKey(row);
		const g = groups.get(k);
		if (g) g.lines.push(row.line);
		else groups.set(k, { row, lines: [row.line] });
	}
	const shown = [...groups.values()].slice(0, MAX_DETAIL_GROUPS);
	const detail = shown
		.map(({ row, lines }) => {
			if (lines.length === 1) return `${row.file}(${lines[0]}): ${row.message}`;
			const listed = lines.slice(0, MAX_LINES_LISTED).join(",");
			const more = lines.length > MAX_LINES_LISTED ? ",…" : "";
			return `${row.file}(${listed}${more}): ×${lines.length} ${row.message}`;
		})
		.join("\n");
	const overflow =
		groups.size > MAX_DETAIL_GROUPS ? `\n... (${groups.size - MAX_DETAIL_GROUPS} more groups)` : "";
	return { header, detail: detail + overflow };
}

/** Test seam: forget all previous runs. */
export function resetFindingDeltaStore(): void {
	previousRunByKey.clear();
}
