// ===========================================
// interlinked tdd — inspect and clear TDD cycle state
// ===========================================
//
// Subcommands:
//   status         Every tracked cycle: state, age of its red, what set it
//   clear [file]   Drop a wedged cycle (or all of them) from the session
//
// Why this exists: the commit gate blocks on REMEMBERED cycle state, and
// nothing re-measures the tree at decision time. When that memory went wrong
// (2026-07-26) the gate refused every commit for hours against a suite that
// was green, and there was no way to see what it believed or to correct it —
// a harness restart did not help, because cycles rehydrate from the session
// snapshot. A gate that can wedge needs an inspection and a reset path.
//
// Reads (and rewrites) `.interlinked/sessions/<id>.json` directly, like the
// debt ledger commands: no daemon round-trip. A RUNNING daemon holds the same
// state in memory, so `clear` prints the restart needed for it to take effect.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { TddCycle } from "../harness/types/tdd-cycle.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { wireAbsentOptional, wireArray, wireLiteral, wireNullable, wireNumber, wireObject, wireOptional, wireRecord, wireString } from "../lib/value-validation.js";

export interface TddCommandOpts {
	cwd?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

/** A cycle plus the session it belongs to. */
export interface CycleRow {
	session: string;
	source_file: string;
	state: string;
	red_at?: number | undefined;
	red_command?: string | undefined;
	test_file: string | null;
	/** Tool calls since the red was observed; undefined when never red. */
	age?: number | undefined;
}

type SnapshotCycle = Pick<TddCycle, "source_file" | "test_file" | "state" | "red_at" | "red_command">;

interface SessionSnapshot {
	tool_call_count?: number;
	tdd_cycles?: Record<string, SnapshotCycle> | [string, SnapshotCycle][];
}

const isSnapshotCycle = wireObject<SnapshotCycle>({
	source_file: wireString,
	test_file: wireNullable(wireString),
	state: wireLiteral("no_test", "red", "green", "regression"),
	red_at: wireAbsentOptional(wireOptional(wireNumber)),
	red_command: wireAbsentOptional(wireOptional(wireString)),
});
const isCycleEntry = (value: unknown): value is [string, SnapshotCycle] => Array.isArray(value)
	&& value.length === 2 && wireString(value[0]) && isSnapshotCycle(value[1]);
const isCycleRecord = wireRecord(isSnapshotCycle);
const isCycleEntries = wireArray(isCycleEntry);
const isCycles = (value: unknown): value is NonNullable<SessionSnapshot["tdd_cycles"]> =>
	isCycleRecord(value) || isCycleEntries(value);
const isSnapshot = wireObject<SessionSnapshot>({
	tool_call_count: wireAbsentOptional(wireNumber),
	tdd_cycles: wireAbsentOptional(isCycles),
});

function sessionsDir(cwd: string): string {
	return join(cwd, ".interlinked", "sessions");
}

/** Snapshot files, newest first; `*.anchor.json` sidecars excluded. */
export function sessionSnapshotPaths(cwd: string): string[] {
	const dir = sessionsDir(cwd);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json") && !f.endsWith(".anchor.json"))
		.map((f) => join(dir, f))
		.sort();
}

/** tdd_cycles serializes as either a plain object or Map entry-pairs
 *  depending on the codec path, so accept both rather than assume one. */
function cyclesOf(snap: SessionSnapshot): SnapshotCycle[] {
	const raw = snap.tdd_cycles;
	if (!raw) return [];
	if (Array.isArray(raw)) return raw.map(([, c]) => c).filter(Boolean);
	return Object.values(raw).filter(Boolean);
}

function readSnapshot(path: string): SessionSnapshot | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return isSnapshot(parsed) ? parsed : null;
	} catch {
		return null; // a half-written or corrupt snapshot must not break `status`
	}
}

/** Every tracked cycle across every session snapshot. */
export function collectCycles(cwd: string): CycleRow[] {
	const rows: CycleRow[] = [];
	for (const path of sessionSnapshotPaths(cwd)) {
		const snap = readSnapshot(path);
		if (!snap) continue;
		const step = snap.tool_call_count ?? 0;
		for (const cycle of cyclesOf(snap)) {
			rows.push({
				session: basename(path).replace(/\.json$/, ""),
				source_file: cycle.source_file,
				state: cycle.state,
				red_at: cycle.red_at,
				red_command: cycle.red_command,
				test_file: cycle.test_file,
				age: cycle.red_at === undefined ? undefined : step - cycle.red_at,
			});
		}
	}
	return rows;
}

/** Cycles that would BLOCK a commit — the ones worth showing first. */
export function blockingCycles(rows: CycleRow[]): CycleRow[] {
	return rows.filter((r) => r.state === "red" || r.state === "regression");
}

function describe(row: CycleRow): string {
	const age = row.age === undefined ? "" : ` — red ${row.age} tool call(s) ago`;
	const cmd = row.red_command ? `\n      set by: ${row.red_command}` : "";
	const test = row.test_file ? "" : "  [no companion test — cannot be greened by a targeted run]";
	return `  ${row.state.toUpperCase().padEnd(10)} ${row.source_file}${age}${test}${cmd}`;
}

export async function tddStatusCommand(opts: TddCommandOpts = {}): Promise<void> {
	const cwd = opts.cwd || process.cwd();
	const rows = collectCycles(cwd);
	const blocking = blockingCycles(rows);
	const mode = getOutputMode(opts);

	output(mode, { total: rows.length, blocking: blocking.length, cycles: rows }, {
		// Return the OBJECT: `output()` stringifies the json renderer's result
		// itself. Returning a pre-stringified string made `--json` emit a JSON
		// *string containing JSON*, so `JSON.parse(out).total` was undefined for
		// every consumer (found 2026-08-05 while covering this file).
		json: () => ({ total: rows.length, blocking: blocking.length, cycles: rows }),
		short: () => `${rows.length} cycle(s), ${blocking.length} blocking`,
		normal: () =>
			rows.length === 0
				? "No TDD cycles tracked."
				: [
						`${rows.length} tracked cycle(s), ${blocking.length} would block a commit:`,
						...blocking.map(describe),
						blocking.length === 0 ? "  (none blocking)" : "",
					]
						.filter(Boolean)
						.join("\n"),
		full: () =>
			rows.length === 0 ? "No TDD cycles tracked." : rows.map(describe).join("\n"),
	});
}

/** Remove matching cycles from every snapshot. Returns how many were dropped. */
export function clearCycles(cwd: string, file?: string): number {
	let removed = 0;
	for (const path of sessionSnapshotPaths(cwd)) {
		const snap = readSnapshot(path);
		if (!snap?.tdd_cycles) continue;
		const kept: [string, SnapshotCycle][] = [];
		for (const cycle of cyclesOf(snap)) {
			const match = !file || cycle.source_file === file || basename(cycle.source_file) === file;
			if (match) removed += 1;
			else kept.push([cycle.source_file, cycle]);
		}
		if (removed === 0) continue;
		snap.tdd_cycles = kept;
		writeFileSync(path, `${JSON.stringify(snap, null, 2)}\n`);
	}
	return removed;
}

export async function tddClearCommand(file: string | undefined, opts: TddCommandOpts = {}): Promise<void> {
	const cwd = opts.cwd || process.cwd();
	const removed = clearCycles(cwd, file);
	if (removed === 0) {
		outputError(getOutputMode(opts), `No TDD cycle matched${file ? ` ${file}` : ""}.`);
		return;
	}
	const mode = getOutputMode(opts);
	output(mode, { removed }, {
		// Object, not a string — see the sibling renderer above.
		json: () => ({ removed }),
		short: () => `cleared ${removed}`,
		normal: () =>
			`Cleared ${removed} TDD cycle(s).\n\nA running daemon holds this state in memory — run \`interlinked harness restart\` for it to take effect.\nThe commit gate re-measures on the next test run, so a genuinely failing file will red again.`,
		full: () => `Cleared ${removed} TDD cycle(s) from ${sessionSnapshotPaths(cwd).length} snapshot(s).`,
	});
}
