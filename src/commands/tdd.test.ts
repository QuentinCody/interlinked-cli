import { parseWire, wireArray, wireNumber, wireObject, wireString, wireUnknown } from "../lib/value-validation.js";
// Tests for `interlinked tdd` — the inspection and reset path for TDD cycle
// state. This exists because the commit gate blocks on remembered state that
// nothing re-measures, and when that memory went wrong there was no way to see
// what the gate believed or to correct it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	blockingCycles,
	clearCycles,
	collectCycles,
	sessionSnapshotPaths,
	tddClearCommand,
	tddStatusCommand,
} from "./tdd.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tdd-cmd-"));
	mkdirSync(join(root, ".interlinked", "sessions"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Write a session snapshot with the given cycles. */
function snapshot(id: string, step: number, cycles: Record<string, unknown>[]): void {
	writeFileSync(
		join(root, ".interlinked", "sessions", `${id}.json`),
		JSON.stringify({
			tool_call_count: step,
			tdd_cycles: Object.fromEntries(cycles.map((c) => [parseWire(c.source_file, wireString, "test JSON value"), c])),
		}),
	);
}

const redCycle = {
	source_file: "/r/a.ts",
	test_file: "/r/a.test.ts",
	state: "red",
	red_at: 40,
	red_command: "npx vitest run /r/a.test.ts",
	impl_edits_before_test: 0,
};

describe("sessionSnapshotPaths", () => {
	it("finds snapshots and ignores anchor sidecars", () => {
		snapshot("s1", 50, [redCycle]);
		writeFileSync(join(root, ".interlinked", "sessions", "s1.anchor.json"), "{}");
		const paths = sessionSnapshotPaths(root);
		expect(paths).toHaveLength(1);
		expect(paths[0]).toMatch(/s1\.json$/);
	});

	it("returns empty when the sessions dir is absent", () => {
		expect(sessionSnapshotPaths(mkdtempSync(join(tmpdir(), "empty-")))).toEqual([]);
	});
});

describe("collectCycles", () => {
	it("reports state, the run that set the red, and its age", () => {
		snapshot("s1", 146, [redCycle]);
		const [row] = collectCycles(root);
		expect(row?.state).toBe("red");
		expect(row?.red_command).toBe("npx vitest run /r/a.test.ts");
		expect(row?.age).toBe(106);
	});

	it("leaves age undefined for a cycle that was never red", () => {
		snapshot("s1", 10, [{ ...redCycle, state: "green", red_at: undefined }]);
		expect(collectCycles(root)[0]?.age).toBeUndefined();
	});

	// tdd_cycles serializes as an object or as Map entry-pairs depending on the
	// codec path; both must read.
	it("accepts the entry-pair serialization", () => {
		writeFileSync(
			join(root, ".interlinked", "sessions", "s2.json"),
			JSON.stringify({ tool_call_count: 50, tdd_cycles: [["/r/a.ts", redCycle]] }),
		);
		expect(collectCycles(root)).toHaveLength(1);
	});

	it("skips a corrupt snapshot rather than throwing", () => {
		writeFileSync(join(root, ".interlinked", "sessions", "bad.json"), "{ not json");
		snapshot("s1", 50, [redCycle]);
		expect(collectCycles(root)).toHaveLength(1);
	});

	it.each([
		{ tdd_cycles: 42 },
		{ tdd_cycles: [["/r/a.ts", null]] },
		{ tdd_cycles: { "/r/a.ts": { ...redCycle, state: 42 } } },
		{ tool_call_count: "50", tdd_cycles: { "/r/a.ts": redCycle } },
	])("ignores malformed cycle data without rewriting it: %j", (malformed) => {
		const path = join(root, ".interlinked", "sessions", "bad.json");
		const original = JSON.stringify(malformed);
		writeFileSync(path, original);
		expect(collectCycles(root)).toEqual([]);
		expect(clearCycles(root)).toBe(0);
		expect(readFileSync(path, "utf8")).toBe(original);
	});
});

describe("blockingCycles", () => {
	it("selects only red and regression", () => {
		snapshot("s1", 50, [
			redCycle,
			{ ...redCycle, source_file: "/r/b.ts", state: "green" },
			{ ...redCycle, source_file: "/r/c.ts", state: "regression" },
			{ ...redCycle, source_file: "/r/d.ts", state: "no_test" },
		]);
		expect(blockingCycles(collectCycles(root)).map((r) => r.source_file).sort()).toEqual([
			"/r/a.ts",
			"/r/c.ts",
		]);
	});
});

describe("clearCycles", () => {
	it("drops one cycle by absolute path and leaves the rest", () => {
		snapshot("s1", 50, [redCycle, { ...redCycle, source_file: "/r/b.ts" }]);
		expect(clearCycles(root, "/r/a.ts")).toBe(1);
		expect(collectCycles(root).map((r) => r.source_file)).toEqual(["/r/b.ts"]);
	});

	it("matches on basename too, so the reported name works", () => {
		snapshot("s1", 50, [redCycle]);
		expect(clearCycles(root, "a.ts")).toBe(1);
		expect(collectCycles(root)).toHaveLength(0);
	});

	it("clears every cycle when no file is given", () => {
		snapshot("s1", 50, [redCycle, { ...redCycle, source_file: "/r/b.ts" }]);
		expect(clearCycles(root)).toBe(2);
		expect(collectCycles(root)).toHaveLength(0);
	});

	it("reports 0 and rewrites nothing when nothing matches", () => {
		snapshot("s1", 50, [redCycle]);
		const before = readFileSync(join(root, ".interlinked", "sessions", "s1.json"), "utf-8");
		expect(clearCycles(root, "/r/nope.ts")).toBe(0);
		expect(readFileSync(join(root, ".interlinked", "sessions", "s1.json"), "utf-8")).toBe(before);
	});

	it("preserves other snapshot fields when rewriting", () => {
		snapshot("s1", 77, [redCycle]);
		clearCycles(root, "/r/a.ts");
		const snap = JSON.parse(readFileSync(join(root, ".interlinked", "sessions", "s1.json"), "utf-8"));
		expect(snap.tool_call_count).toBe(77);
	});

	it("skips a snapshot with no tdd_cycles field at all", () => {
		writeFileSync(
			join(root, ".interlinked", "sessions", "s1.json"),
			JSON.stringify({ tool_call_count: 5 }),
		);
		snapshot("s2", 50, [redCycle]);
		expect(clearCycles(root, "/r/a.ts")).toBe(1);
	});
});

// ===========================================
// tddStatusCommand / tddClearCommand — live commands, console/stderr captured
// ===========================================

async function runCmd(fn: () => Promise<void>): Promise<{ out: string; err: string; exitCode: number | undefined }> {
	const priorExit = process.exitCode;
	process.exitCode = undefined;
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		await fn();
		return {
			out: logSpy.mock.calls.map((c) => String(c[0])).join("\n"),
			err: errSpy.mock.calls.map((c) => String(c[0])).join("\n"),
			exitCode: process.exitCode,
		};
	} finally {
		logSpy.mockRestore();
		errSpy.mockRestore();
		process.exitCode = priorExit;
	}
}

describe("tddStatusCommand", () => {
	it("reports 'No TDD cycles tracked.' when nothing is tracked", async () => {
		const { out } = await runCmd(() => tddStatusCommand({ cwd: root }));
		expect(out).toBe("No TDD cycles tracked.");
	});

	it("normal mode lists only the blocking cycles, with age and set-by command", async () => {
		snapshot("s1", 146, [
			redCycle,
			{ ...redCycle, source_file: "/r/b.ts", state: "green" },
		]);
		const { out } = await runCmd(() => tddStatusCommand({ cwd: root }));
		expect(out).toContain("2 tracked cycle(s), 1 would block a commit:");
		expect(out).toContain("RED        /r/a.ts — red 106 tool call(s) ago");
		expect(out).toContain("set by: npx vitest run /r/a.test.ts");
		expect(out).not.toContain("/r/b.ts");
	});

	it("normal mode reports '(none blocking)' when nothing would block a commit", async () => {
		snapshot("s1", 50, [{ ...redCycle, state: "green" }]);
		const { out } = await runCmd(() => tddStatusCommand({ cwd: root }));
		expect(out).toContain("1 tracked cycle(s), 0 would block a commit:");
		expect(out).toContain("(none blocking)");
	});

	it("flags a cycle with no companion test", async () => {
		snapshot("s1", 50, [{ ...redCycle, test_file: null }]);
		const { out } = await runCmd(() => tddStatusCommand({ cwd: root }));
		expect(out).toContain("[no companion test — cannot be greened by a targeted run]");
	});

	it("short mode prints a one-line count", async () => {
		snapshot("s1", 50, [redCycle, { ...redCycle, source_file: "/r/b.ts", state: "green" }]);
		const { out } = await runCmd(() => tddStatusCommand({ cwd: root, short: true }));
		expect(out).toBe("2 cycle(s), 1 blocking");
	});

	it("json mode prints total, blocking, and full cycle rows", async () => {
		// ONE parse. `output()` stringifies the json renderer's return value, so
		// the renderer must hand back an object; when it returned a pre-stringified
		// string the CLI emitted a JSON *string containing JSON* and every
		// consumer's `JSON.parse(out).total` was undefined. Parsing once is the
		// assertion that the double-encoding is gone.
		snapshot("s1", 146, [redCycle]);
		const { out } = await runCmd(() => tddStatusCommand({ cwd: root, json: true }));
		const parsed = parseWire(JSON.parse(out), wireObject({ "total": wireNumber, "blocking": wireNumber, "cycles": wireArray(wireUnknown) }), "test JSON value");
		expect(parsed).toMatchObject({ total: 1, blocking: 1 });
		expect(parsed.cycles).toHaveLength(1);
	});

	it("full mode lists every cycle, not just the blocking ones", async () => {
		snapshot("s1", 50, [redCycle, { ...redCycle, source_file: "/r/b.ts", state: "green" }]);
		const { out } = await runCmd(() => tddStatusCommand({ cwd: root, full: true }));
		expect(out).toContain("/r/a.ts");
		expect(out).toContain("/r/b.ts");
	});

	it("full mode reports 'No TDD cycles tracked.' too when empty", async () => {
		const { out } = await runCmd(() => tddStatusCommand({ cwd: root, full: true }));
		expect(out).toBe("No TDD cycles tracked.");
	});
});

describe("tddClearCommand", () => {
	it("reports an error and exits 1 when no cycle matches a given file", async () => {
		snapshot("s1", 50, [redCycle]);
		const { out, err, exitCode } = await runCmd(() => tddClearCommand("/r/nope.ts", { cwd: root }));
		expect(out).toBe("");
		expect(err).toBe("Error: No TDD cycle matched /r/nope.ts.");
		expect(exitCode).toBe(1);
	});

	it("reports an error without a filename when clearing all matches nothing", async () => {
		const { err, exitCode } = await runCmd(() => tddClearCommand(undefined, { cwd: root }));
		expect(err).toBe("Error: No TDD cycle matched.");
		expect(exitCode).toBe(1);
	});

	it("normal mode reports the count and the restart/re-measure notes", async () => {
		snapshot("s1", 50, [redCycle]);
		const { out, exitCode } = await runCmd(() => tddClearCommand("/r/a.ts", { cwd: root }));
		expect(exitCode).toBeUndefined();
		expect(out).toContain("Cleared 1 TDD cycle(s).");
		expect(out).toContain("interlinked harness restart");
		expect(out).toContain("commit gate re-measures on the next test run");
		expect(collectCycles(root)).toHaveLength(0);
	});

	it("short mode prints 'cleared N'", async () => {
		snapshot("s1", 50, [redCycle, { ...redCycle, source_file: "/r/b.ts" }]);
		const { out } = await runCmd(() => tddClearCommand(undefined, { cwd: root, short: true }));
		expect(out).toBe("cleared 2");
	});

	it("json mode prints the removed count", async () => {
		// One parse — see the sibling assertion in tddStatusCommand's json test.
		snapshot("s1", 50, [redCycle]);
		const { out } = await runCmd(() => tddClearCommand("/r/a.ts", { cwd: root, json: true }));
		expect(JSON.parse(out)).toEqual({ removed: 1 });
	});

	it("full mode reports the snapshot count scanned", async () => {
		snapshot("s1", 50, [redCycle]);
		const { out } = await runCmd(() => tddClearCommand("/r/a.ts", { cwd: root, full: true }));
		expect(out).toBe("Cleared 1 TDD cycle(s) from 1 snapshot(s).");
	});
});
