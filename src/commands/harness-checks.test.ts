import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCheckInventory } from "../harness/check-inventory.js";
import { harnessChecksCommand } from "./harness-checks.js";

/** Run `fn` and return everything it wrote to console.log, joined by newlines. */
function capture(fn: () => void): string {
	const spy = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		fn();
		return spy.mock.calls.map((c) => c.join(" ")).join("\n");
	} finally {
		spy.mockRestore();
	}
}

// These tests verify the command faithfully RENDERS the inventory. The actual
// COUNTS are pinned once, in check-inventory.test.ts — so adding a check never
// forces an edit here.
describe("harnessChecksCommand", () => {
	it("normal mode prints the total and every family label", () => {
		const out = capture(() => harnessChecksCommand({}));
		const inv = getCheckInventory();
		expect(out).toContain("Total checks");
		expect(out).toContain(String(inv.total));
		for (const f of inv.families) {
			expect(out, `family ${f.key} label`).toContain(f.label);
		}
	});

	it("--json round-trips the full inventory object", () => {
		const out = capture(() => harnessChecksCommand({ json: true }));
		// SAFETY: --json mode serialized getCheckInventory() with JSON.stringify;
		// parsing it back yields the identical CheckInventory shape, which the
		// assertions below verify field-by-field.
		const parsed = JSON.parse(out) as ReturnType<typeof getCheckInventory>;
		const inv = getCheckInventory();
		expect(parsed.total).toBe(inv.total);
		expect(parsed.families).toEqual(inv.families);
	});

	it("--short is a single summary line carrying the total", () => {
		const out = capture(() => harnessChecksCommand({ short: true }));
		expect(out.trim()).not.toContain("\n");
		expect(out).toContain(`${getCheckInventory().total} checks`);
	});

	it("--full surfaces the authoritative source of each count", () => {
		const out = capture(() => harnessChecksCommand({ full: true }));
		expect(out).toContain("CHECK_REGISTRY");
	});
});

// The probation summary line is a lazily-computed trailer on the human
// renders: it folds `.interlinked/recurrences.jsonl` through the same
// check-health aggregation `interlinked harness health` streams, and points
// at that command when N > 0. It must stay SILENT when the log is absent,
// empty of probation candidates, or oversized (the fast-path guard).
describe("harnessChecksCommand — probation summary line", () => {
	const PROBATION_LINE = "on probation — run 'interlinked harness health'";
	const tmpDirs: string[] = [];

	afterEach(() => {
		for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** Fresh repo-shaped tmp dir; `process.cwd()` is mocked to it for `fn`. */
	function makeRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "harness-checks-probation-"));
		tmpDirs.push(dir);
		return dir;
	}

	function runInCwd(dir: string, opts: Record<string, boolean> = {}): string {
		const spy = vi.spyOn(process, "cwd").mockReturnValue(dir);
		try {
			return capture(() => harnessChecksCommand(opts));
		} finally {
			spy.mockRestore();
		}
	}

	/** One probation-candidate check id: ≥10 events, ≥5 unique findings,
	 *  repeat-rate ≥5, and a HEURISTIC registry determinism.
	 *  `magic_literal_in_conditional` is a stable heuristic-tagged id. */
	function probationRows(): string {
		const rows: string[] = [];
		for (let unique = 0; unique < 5; unique++) {
			for (let fire = 0; fire < 5; fire++) {
				rows.push(
					JSON.stringify({
						kind: "harness_caught",
						check_id: "magic_literal_in_conditional",
						ts: "2026-07-01T00:00:00Z",
						file: `src/f${unique}.ts`,
						message: `finding ${unique}`,
						session_id: `s${fire}`,
					}),
				);
			}
		}
		return `${rows.join("\n")}\n`;
	}

	function writeLog(dir: string, content: string): void {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "recurrences.jsonl"), content, "utf-8");
	}

	it("stays silent when the recurrence log is absent", () => {
		const out = runInCwd(makeRepo());
		expect(out).toContain("Total checks");
		expect(out).not.toContain(PROBATION_LINE);
	});

	it("appends one pointer line when a check is on probation", () => {
		const dir = makeRepo();
		writeLog(dir, probationRows());
		const out = runInCwd(dir);
		expect(out).toContain(`1 check(s) ${PROBATION_LINE}`);
	});

	it("stays silent when the log holds no probation candidates (low-data rows)", () => {
		const dir = makeRepo();
		// 2 events for one check — under the 10-event low-data floor.
		writeLog(
			dir,
			`${JSON.stringify({ kind: "harness_caught", check_id: "magic_literal_in_conditional", ts: "2026-07-01T00:00:00Z", file: "a.ts", message: "m" })}\n`.repeat(
				2,
			),
		);
		const out = runInCwd(dir);
		expect(out).toContain("Total checks");
		expect(out).not.toContain(PROBATION_LINE);
	});

	it("skips (stays silent) when the log exceeds the 5MB fast-path budget", () => {
		const dir = makeRepo();
		writeLog(dir, "x".repeat(5 * 1024 * 1024 + 1));
		const out = runInCwd(dir);
		expect(out).toContain("Total checks");
		expect(out).not.toContain(PROBATION_LINE);
	});

	it("never decorates the --short single-line render", () => {
		const dir = makeRepo();
		writeLog(dir, probationRows());
		const out = runInCwd(dir, { short: true });
		expect(out.trim()).not.toContain("\n");
		expect(out).not.toContain(PROBATION_LINE);
	});

	it("stays silent (never throws) when the log path is unreadable as text", () => {
		const dir = makeRepo();
		// A directory in place of the log file passes existsSync AND the size
		// guard (a bare dir reports a small stat size) but makes
		// readFileSync(..., "utf-8") throw EISDIR — the catch-all fallback,
		// distinct from the size-guard branch covered above. If the catch were
		// removed the EISDIR would propagate and this call would throw instead
		// of returning a rendered string.
		mkdirSync(join(dir, ".interlinked", "recurrences.jsonl"), { recursive: true });
		let out = "";
		expect(() => {
			out = runInCwd(dir);
		}).not.toThrow();
		expect(out).toContain("Total checks");
		expect(out).not.toContain(PROBATION_LINE);
	});
});
