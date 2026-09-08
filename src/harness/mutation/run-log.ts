// ===========================================
// Mutation run log — one JSONL row per measurement, as it happens
// ===========================================
// The manifest is a keyed STATE document (what is known about each mutant);
// this log is the EVENT stream (a measurement happened, through which path,
// with what counts). It exists so the viz dashboard can show mutation activity
// live per tool call, and so per-edit gate runs, PostToolUse harvests, and
// scripted background sweeps land in ONE comparable ledger. Append-only,
// gitignored (it can carry timings that hint at runner topology), fail-soft.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";

export const MUTATION_RUNS_REL = join(".interlinked", "mutation-runs.jsonl");

export interface MutationRunRow {
	/** ISO timestamp of completion. */
	ts: string;
	/** Repo-relative file measured. */
	file: string;
	/** Which path produced the measurement. */
	source: "per-edit" | "harvest" | "script";
	mutants: number;
	killed: number;
	survived: number;
	uncovered?: number;
	/** What the run attested (review 2026-08-28 item 2): a first-sighting
	 *  adoption row must never render as clean — `survived === 0` on an adoption
	 *  says only that the floor STARTED empty, not that an edit measured clean.
	 *  `finding` mirrors the receipt vocabulary (a measured block) and is
	 *  reserved for EVALUATOR-minted decisions; `harvest_partial` marks the
	 *  late window's survivor-only evidence, which never went through the
	 *  evaluator and is neither clean nor a committed finding. The per-edit
	 *  persist path writes only the first two. Absent on rows written before
	 *  the field existed. */
	outcome?: "baseline_adopted" | "measured_clean" | "finding" | "harvest_partial";
	duration_ms?: number;
	/** Shard count when the run fanned out. */
	shards?: number;
	/** True when the row knows only part of the outcome (e.g. a harvest window
	 *  sees survivors + shard count, never the mutant total — its `mutants` is
	 *  the count of KNOWN outcomes, not the run's total). */
	partial?: boolean;
	/** Simulated events must not move the ledger (`interlinked harness test`). */
	dry_run?: boolean;
}

/** Append one run. A dry-run row is refused; any fs failure is swallowed —
 *  this is telemetry for a dashboard, never a gate. */
export function appendMutationRun(root: string, row: MutationRunRow): void {
	if (row.dry_run) return;
	try {
		const file = join(root, MUTATION_RUNS_REL);
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify(row)}\n`);
	} catch (err) {
		void err; // fail-soft: see module header
	}
}

function parseRow(line: string): MutationRunRow | null {
	try {
		const raw: unknown = JSON.parse(line);
		if (!isJsonObject(raw)) return null;
		const r = raw;
		if (typeof r.file !== "string" || typeof r.ts !== "string") return null;
		if (typeof r.mutants !== "number" || typeof r.killed !== "number") return null;
		if (typeof r.survived !== "number") return null;
		const source = (["per-edit", "harvest", "script"] as const).find((value) => value === r.source);
		if (source === undefined) return null;
		const row: MutationRunRow = { file: r.file, ts: r.ts, mutants: r.mutants, killed: r.killed, survived: r.survived, source };
		copyOptionalFields(r, row);
		return row;
	} catch (err) {
		void err; // a torn tail line from a live writer is expected
		return null;
	}
}

function copyOptionalFields(raw: Record<string, unknown>, row: MutationRunRow): void {
	for (const key of ["uncovered", "duration_ms", "shards"] as const) {
		if (typeof raw[key] === "number") row[key] = raw[key];
	}
	for (const key of ["partial", "dry_run"] as const) {
		if (typeof raw[key] === "boolean") row[key] = raw[key];
	}
	const outcome = (["baseline_adopted", "measured_clean", "finding", "harvest_partial"] as const).find((value) => value === raw.outcome);
	if (outcome !== undefined) row.outcome = outcome;
}

/** Newest `limit` rows, oldest first. Missing/corrupt file reads as empty. */
export function readRecentMutationRuns(root: string, limit: number): MutationRunRow[] {
	try {
		const file = join(root, MUTATION_RUNS_REL);
		if (!existsSync(file)) return [];
		const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
		const rows: MutationRunRow[] = [];
		for (const line of lines) {
			const row = parseRow(line);
			if (row !== null) rows.push(row);
		}
		return rows.slice(-Math.max(0, limit));
	} catch (err) {
		void err;
		return [];
	}
}
