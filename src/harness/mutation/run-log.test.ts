import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendMutationRun, MUTATION_RUNS_REL, readRecentMutationRuns } from "./run-log.js";

const row = {
	ts: "2026-08-23T20:00:00.000Z",
	file: "src/f.ts",
	source: "per-edit" as const,
	mutants: 65,
	killed: 60,
	survived: 5,
	duration_ms: 4200,
};

describe("mutation run log — the live per-run stream", () => {
	it("P1: appends one JSON line per run and reads it back newest-last", () => {
		const root = mkdtempSync(join(tmpdir(), "run-log-"));
		try {
			appendMutationRun(root, row);
			appendMutationRun(root, { ...row, file: "src/g.ts", source: "script" });
			const rows = readRecentMutationRuns(root, 10);
			expect(rows.map((r) => r.file)).toEqual(["src/f.ts", "src/g.ts"]);
			expect(readFileSync(join(root, MUTATION_RUNS_REL), "utf8").trim().split("\n")).toHaveLength(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("P2: read is bounded — only the newest N rows return", () => {
		const root = mkdtempSync(join(tmpdir(), "run-log-"));
		try {
			for (let i = 0; i < 7; i++) appendMutationRun(root, { ...row, mutants: i });
			const rows = readRecentMutationRuns(root, 3);
			expect(rows.map((r) => r.mutants)).toEqual([4, 5, 6]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("N1: a dry-run row is refused (a simulated event must not move the ledger)", () => {
		const root = mkdtempSync(join(tmpdir(), "run-log-"));
		try {
			appendMutationRun(root, { ...row, dry_run: true });
			expect(readRecentMutationRuns(root, 10)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("N2: a torn/corrupt line degrades to skipped, never a throw", () => {
		const root = mkdtempSync(join(tmpdir(), "run-log-"));
		try {
			appendMutationRun(root, row);
			const { appendFileSync } = require("node:fs") as typeof import("node:fs");
			appendFileSync(join(root, MUTATION_RUNS_REL), "{torn\n");
			appendMutationRun(root, { ...row, file: "src/h.ts" });
			expect(readRecentMutationRuns(root, 10).map((r) => r.file)).toEqual(["src/f.ts", "src/h.ts"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("N3: a missing log file reads as empty", () => {
		const root = mkdtempSync(join(tmpdir(), "run-log-"));
		try {
			expect(readRecentMutationRuns(root, 5)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("N4: a read failure (log path is a directory, not a file) degrades to empty rather than throwing", () => {
		const root = mkdtempSync(join(tmpdir(), "run-log-"));
		try {
			// Create the log path itself as a directory so existsSync() sees it
			// (the missing-file branch above does NOT fire) but readFileSync()
			// throws EISDIR — the distinct failure mode the catch block exists for.
			mkdirSync(join(root, MUTATION_RUNS_REL), { recursive: true });
			expect(readRecentMutationRuns(root, 5)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
