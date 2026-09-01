// ===========================================
// Enforcement ledger — lifetime, monotonic counters of work actually done
// ===========================================
// The statusline used to report an INVENTORY ("119 rules · 7 tools / 262
// inline") — what the harness could do, not what it did. Inventory is the
// cheapest number to inflate and the least informative: 6 of the 252 registered
// checks were measured on 2026-08-04 to be incapable of firing at all, and the
// inventory counted every one of them.
//
// This module counts OUTCOMES instead, and counts them for the lifetime of the
// attachment rather than a sliding window. `rules-stats.json` already tallies
// verdicts, but only over "the last 50 MB of activity.jsonl", so its numbers go
// DOWN as the window slides past old events — useless as a progress signal.
//
// Monotonic by construction, two ways:
//   - Totals only ever accumulate; a recomputed value that came out lower than
//     the stored one is ignored rather than written (a truncated or rotated log
//     must not erase history).
//   - New events are read from a byte CURSOR, the same incremental pattern the
//     sync/timeline cursors use, so the hot path never re-reads a log that can
//     reach hundreds of megabytes.

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";

/** Close a descriptor without letting a close failure mask the read result. */
function closeQuietly(fd: number): void {
	try {
		closeSync(fd);
	} catch (err) {
		void err; // the read already returned; a close error changes nothing
	}
}

/** Counters that only ever grow. */
export interface EnforcementLedger {
	version: 1;
	/** ISO timestamp of the first event ever folded in. */
	since: string;
	/** Byte offset into activity.jsonl already accounted for. */
	cursor: number;
	/** Tool calls refused before they ran. */
	blocked: number;
	/** Findings surfaced to the agent (warnings that reached it). */
	caught: number;
	/** Tool calls evaluated, whatever the verdict. */
	evaluated: number;
}

/**
 * How much of the log a COLD start reads. Sized so the first pass is a small,
 * reliable read rather than a ~100MB one inside the daemon; everything after it
 * is incremental, so this bounds only the initial catch-up.
 */
const COLD_START_MAX_BYTES = 4 * 1024 * 1024;

const EMPTY_LEDGER: EnforcementLedger = {
	version: 1,
	since: "",
	cursor: 0,
	blocked: 0,
	caught: 0,
	evaluated: 0,
};

export function enforcementLedgerPath(interlinkedDir: string): string {
	return join(interlinkedDir, "enforcement-ledger.json");
}

/** Read the stored ledger, failing closed to empty (never throws). */
export function loadEnforcementLedger(interlinkedDir: string): EnforcementLedger {
	const path = enforcementLedgerPath(interlinkedDir);
	if (!existsSync(path)) return { ...EMPTY_LEDGER };
	try {
		// Every field is re-validated below by `nonNegative` / a typeof check
		// (never trusted from a type annotation), so a hand-edited or truncated
		// file degrades to zeroes rather than propagating junk.
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isJsonObject(parsed)) return { ...EMPTY_LEDGER };
		return {
			version: 1,
			since: typeof parsed.since === "string" ? parsed.since : "",
			cursor: nonNegative(parsed.cursor),
			blocked: nonNegative(parsed.blocked),
			caught: nonNegative(parsed.caught),
			evaluated: nonNegative(parsed.evaluated),
		};
	} catch {
		return { ...EMPTY_LEDGER };
	}
}

function nonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** One activity row's contribution. Exported for the unit tests, which pin the
 *  classification independently of any file I/O. */
interface RowContribution {
	blocked: number;
	caught: number;
	evaluated: number;
}

export function classifyRow(row: unknown): RowContribution {
	const none = { blocked: 0, caught: 0, evaluated: 0 };
	if (typeof row !== "object" || row === null) return none;
	// SAFETY: used only for the keyed read below, which re-checks the value's
	// type; no field is trusted to exist or to have a particular shape.
	const r = row as Record<string, unknown>;
	// The verdict lives in `type`, as `guard_block` / `guard_warn` /
	// `guard_allow` — NOT in a `decision` field. Reading the wrong key fails
	// SILENTLY here: it yields zero over a log full of real verdicts, which is
	// exactly what the first cut of this module did across 99MB of activity.
	const type = typeof r.type === "string" ? r.type : "";
	if (!type.startsWith("guard_")) return none;
	return {
		blocked: type === "guard_block" ? 1 : 0,
		caught: type === "guard_warn" ? 1 : 0,
		evaluated: 1,
	};
}

/**
 * Fold everything appended to `activity.jsonl` since the stored cursor into the
 * ledger, and persist it. Returns the updated ledger.
 *
 * Bounded: reads only the bytes after the cursor. A file SHORTER than the
 * cursor means it rotated or was compacted, so the cursor resets to 0 while the
 * totals are kept — the alternative (recounting from the top) would double-count
 * every event that survived the rotation.
 */
export function updateEnforcementLedger(interlinkedDir: string, at: string): EnforcementLedger {
	const prior = loadEnforcementLedger(interlinkedDir);
	const activity = join(interlinkedDir, "activity.jsonl");
	if (!existsSync(activity)) return prior;

	let size: number;
	try {
		size = statSync(activity).size;
	} catch {
		return prior;
	}

	// COLD START is bounded. `activity.jsonl` reaches ~100MB here, and reading it
	// whole in one syscall inside the daemon is both a memory spike on the
	// process the RSS recycler watches and an unreliable read (a single
	// `readSync` is not obliged to return everything asked for). A fresh
	// attachment therefore starts from the recent tail and stamps `since` at
	// that moment, rather than claiming a history it did not count.
	const cold = prior.cursor === 0;
	const floor = cold ? Math.max(0, size - COLD_START_MAX_BYTES) : prior.cursor;
	const start = size < prior.cursor ? Math.max(0, size - COLD_START_MAX_BYTES) : floor;
	if (size <= start) return prior;

	let text: string;
	let fd: number | null = null;
	try {
		// POSITIONAL read of just the new bytes. `readFileSync` + subarray would
		// pull the entire file into memory first — on a hundreds-of-megabyte
		// activity log that is precisely the full-read CLAUDE.md forbids, and it
		// would land in the daemon, whose RSS ceiling then recycles it.
		const length = size - start;
		const buf = Buffer.allocUnsafe(length);
		fd = openSync(activity, "r");
		const read = readSync(fd, buf, 0, length, start);
		text = buf.subarray(0, read).toString("utf8");
	} catch {
		return prior;
	} finally {
		if (fd !== null) closeQuietly(fd);
	}

	const next: EnforcementLedger = { ...prior, cursor: size };
	// A partial trailing line is left for the next pass by rewinding the cursor
	// to the last newline, so no row is ever half-parsed or counted twice.
	const lastNewline = text.lastIndexOf("\n");
	if (lastNewline === -1) return prior;
	next.cursor = start + lastNewline + 1;

	for (const line of text.slice(0, lastNewline).split("\n")) {
		if (!line.trim()) continue;
		let row: unknown;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		const d = classifyRow(row);
		next.blocked += d.blocked;
		next.caught += d.caught;
		next.evaluated += d.evaluated;
	}

	if (!next.since) next.since = at;
	// Monotonic guard: never persist a total below what is already recorded.
	next.blocked = Math.max(next.blocked, prior.blocked);
	next.caught = Math.max(next.caught, prior.caught);
	next.evaluated = Math.max(next.evaluated, prior.evaluated);

	try {
		mkdirSync(dirname(enforcementLedgerPath(interlinkedDir)), { recursive: true });
		writeFileSync(enforcementLedgerPath(interlinkedDir), `${JSON.stringify(next, null, "\t")}\n`, "utf8");
	} catch {
		// Best-effort: a statusline counter must never break the daemon.
	}
	return next;
}
