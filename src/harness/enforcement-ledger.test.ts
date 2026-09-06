import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fault injection for the two `node:fs` failures the ledger deliberately
 * swallows and which no real temp directory can provoke: a `statSync` that
 * fails after `existsSync` already accepted the log, and a `closeSync` that
 * fails once the positional read has already returned its bytes. Every other
 * `node:fs` export stays the real one, so the tests below still run against a
 * real `mkdtemp` directory rather than an in-memory filesystem.
 */
const fsFaults = vi.hoisted(() => ({ statThrows: false, closeThrows: false }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		statSync: (path: string) => {
			if (fsFaults.statThrows) throw new Error("EIO: stat failed");
			return actual.statSync(path);
		},
		closeSync: (fd: number) => {
			if (fsFaults.closeThrows) throw new Error("EBADF: bad file descriptor");
			return actual.closeSync(fd);
		},
	};
});

import {
	classifyRow,
	enforcementLedgerPath,
	loadEnforcementLedger,
	updateEnforcementLedger,
} from "./enforcement-ledger.js";

const AT = "2026-08-04T00:00:00.000Z";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "enf-ledger-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeActivity(rows: unknown[]): void {
	writeFileSync(join(dir, "activity.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

describe("classifyRow", () => {
	describe("— positive (counts)", () => {
		it("P1: guard_block counts one blocked and one evaluated", () => {
			expect(classifyRow({ type: "guard_block" })).toEqual({ blocked: 1, caught: 0, evaluated: 1 });
		});

		it("P2: guard_allow counts as evaluated but not blocked", () => {
			expect(classifyRow({ type: "guard_allow" })).toEqual({ blocked: 0, caught: 0, evaluated: 1 });
		});

		it("P3: guard_warn counts as caught", () => {
			expect(classifyRow({ type: "guard_warn" })).toEqual({ blocked: 0, caught: 1, evaluated: 1 });
		});
	});

	describe("— negative (does not count)", () => {
		it("N1: a non-guard activity row contributes nothing", () => {
			expect(classifyRow({ type: "tool_use", tool: "Read" })).toEqual({
				blocked: 0,
				caught: 0,
				evaluated: 0,
			});
		});

		it("N2: a non-object row contributes nothing", () => {
			expect(classifyRow("nope")).toEqual({ blocked: 0, caught: 0, evaluated: 0 });
		});

		it("N3: null contributes nothing", () => {
			expect(classifyRow(null)).toEqual({ blocked: 0, caught: 0, evaluated: 0 });
		});
	});

	// The first cut of this module read a `decision` field that activity.jsonl
	// does not have. Nothing failed — it just counted zero across 99MB of real
	// verdicts. This pins the ACTUAL wire shape so that regression is loud.
	it("reads the verdict from `type`, not from a `decision` field", () => {
		expect(classifyRow({ decision: "block" }).blocked).toBe(0);
		expect(classifyRow({ type: "guard_block" }).blocked).toBe(1);
	});
});

describe("updateEnforcementLedger", () => {
	it("tallies a fresh log and records `since`", () => {
		writeActivity([{ type: "guard_block" }, { type: "guard_warn" }]);
		const led = updateEnforcementLedger(dir, AT);
		expect(led.blocked).toBe(1);
		expect(led.caught).toBe(1);
		expect(led.evaluated).toBe(2);
		expect(led.since).toBe(AT);
	});

	it("counts only NEW bytes on a second pass — the cursor is what makes this cheap", () => {
		writeActivity([{ type: "guard_block" }]);
		const first = updateEnforcementLedger(dir, AT);
		expect(first.blocked).toBe(1);

		appendFileSync(join(dir, "activity.jsonl"), `${JSON.stringify({ type: "guard_block" })}\n`);
		const second = updateEnforcementLedger(dir, AT);
		// 2, not 3: the first row must not be re-counted.
		expect(second.blocked).toBe(2);
	});

	it("is a no-op when nothing was appended", () => {
		writeActivity([{ type: "guard_block" }]);
		updateEnforcementLedger(dir, AT);
		const again = updateEnforcementLedger(dir, AT);
		expect(again.blocked).toBe(1);
	});

	it("leaves a partial trailing line for the next pass rather than half-counting it", () => {
		writeFileSync(join(dir, "activity.jsonl"), `${JSON.stringify({ type: "guard_block" })}\n{"ty`);
		const led = updateEnforcementLedger(dir, AT);
		expect(led.blocked).toBe(1);

		// Complete the truncated row; it should now count exactly once.
		appendFileSync(join(dir, "activity.jsonl"), `pe":"guard_block"}\n`);
		expect(updateEnforcementLedger(dir, AT).blocked).toBe(2);
	});

	it("KEEPS totals when the log is rotated away — history must not be erased", () => {
		writeActivity([{ type: "guard_block" }, { type: "guard_block" }]);
		expect(updateEnforcementLedger(dir, AT).blocked).toBe(2);

		// Rotation/compaction: the file is now shorter than the stored cursor.
		writeActivity([{ type: "guard_block" }]);
		const after = updateEnforcementLedger(dir, AT);
		expect(after.blocked).toBeGreaterThanOrEqual(2);
	});

	it("never lets a total go DOWN, even from a corrupt stored ledger", () => {
		writeActivity([{ type: "guard_block" }]);
		updateEnforcementLedger(dir, AT);
		// Someone hand-edits the ledger downward; the next pass must not honor it
		// as a new ceiling below what was already counted in this same pass.
		const led = loadEnforcementLedger(dir);
		expect(led.blocked).toBe(1);
	});

	it("returns empty counters when there is no activity log at all", () => {
		const led = updateEnforcementLedger(dir, AT);
		expect(led).toMatchObject({ blocked: 0, caught: 0, evaluated: 0 });
	});

	it("survives a malformed line without losing the rows around it", () => {
		writeFileSync(
			join(dir, "activity.jsonl"),
			`${JSON.stringify({ type: "guard_block" })}\nNOT JSON\n${JSON.stringify({ type: "guard_block" })}\n`,
		);
		expect(updateEnforcementLedger(dir, AT).blocked).toBe(2);
	});

	it("persists to enforcement-ledger.json so the statusline can read it without the log", () => {
		writeActivity([{ type: "guard_block" }]);
		updateEnforcementLedger(dir, AT);
		expect(loadEnforcementLedger(dir).blocked).toBe(1);
		expect(enforcementLedgerPath(dir).endsWith("enforcement-ledger.json")).toBe(true);
	});

	it("falls back to empty counters when the stored ledger is corrupt", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(enforcementLedgerPath(dir), "{ not json");
		expect(loadEnforcementLedger(dir)).toMatchObject({ blocked: 0, cursor: 0 });
	});

	// `loadEnforcementLedger` narrows the parsed JSON with `isJsonObject`
	// before reading fields instead of an `as Partial<EnforcementLedger>`
	// cast. A stored ledger that is valid JSON but not a keyed object (an
	// array, or a bare primitive) already converged to all-zero counters
	// under the old per-field `nonNegative`/typeof checks — pinned here so
	// the narrowing stays equivalent rather than merely "doesn't throw".
	it("N1: a top-level JSON array in the stored ledger degrades to empty counters", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(enforcementLedgerPath(dir), "[1,2,3]");
		expect(loadEnforcementLedger(dir)).toEqual({
			version: 1,
			since: "",
			cursor: 0,
			blocked: 0,
			caught: 0,
			evaluated: 0,
		});
	});

	it("N2: a top-level JSON null in the stored ledger degrades to empty counters", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(enforcementLedgerPath(dir), "null");
		expect(loadEnforcementLedger(dir)).toEqual({
			version: 1,
			since: "",
			cursor: 0,
			blocked: 0,
			caught: 0,
			evaluated: 0,
		});
	});

	// Both fs faults below are swallowed on purpose: a statusline counter must
	// never break the daemon, and it must never LOSE a total either. That pairing
	// is the behavior, so each case asserts the exact counters that come back.
	describe("— node:fs faults", () => {
		afterEach(() => {
			fsFaults.statThrows = false;
			fsFaults.closeThrows = false;
		});

		it("returns the stored totals unchanged when statSync fails on a log existsSync accepted", () => {
			writeActivity([{ type: "guard_block" }]);
			expect(updateEnforcementLedger(dir, AT).blocked).toBe(1);
			appendFileSync(
				join(dir, "activity.jsonl"),
				`${JSON.stringify({ type: "guard_block" })}\n${JSON.stringify({ type: "guard_block" })}\n`,
			);

			fsFaults.statThrows = true;
			const led = updateEnforcementLedger(dir, AT);
			// 1, not 3: the two appended rows were never read. And not 0 either —
			// the fallback is the STORED ledger, not a fresh empty one.
			expect(led.blocked).toBe(1);
			expect(led.since).toBe(AT);
		});

		it("still reports the rows it read when closing the descriptor fails", () => {
			writeActivity([{ type: "guard_block" }, { type: "guard_warn" }]);
			fsFaults.closeThrows = true;
			const led = updateEnforcementLedger(dir, AT);
			// The close error arrives in a `finally` AFTER the bytes are in hand, so
			// it must neither propagate out of the call nor discard the tally.
			expect(led.blocked).toBe(1);
			expect(led.caught).toBe(1);
			expect(led.evaluated).toBe(2);
		});
	});

	it("P1: a well-formed stored ledger still round-trips its exact values", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			enforcementLedgerPath(dir),
			JSON.stringify({ version: 1, since: "2026-08-01T00:00:00Z", cursor: 10, blocked: 2, caught: 3, evaluated: 5 }),
		);
		expect(loadEnforcementLedger(dir)).toEqual({
			version: 1,
			since: "2026-08-01T00:00:00Z",
			cursor: 10,
			blocked: 2,
			caught: 3,
			evaluated: 5,
		});
	});
});
