import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: spies on statSync/appendFileSync only (call-through to the real
// implementation by default) while every other fs export stays untouched.
// Plain `vi.spyOn(fs, ...)` throws "Module namespace is not configurable in
// ESM" for node:fs — see src/lib/file-mutation-lock.test.ts for the prior art.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		statSync: vi.fn(actual.statSync),
		appendFileSync: vi.fn(actual.appendFileSync),
	};
});

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import {
	backgroundTaskLogPath,
	type BackgroundTaskRecord,
	lastStatuses,
	parseBackgroundTasks,
	recordBackgroundTasks,
} from "./background-task-log.js";

const TS = "2026-08-08T02:00:00.000Z";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "bg-task-log-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function rows(): BackgroundTaskRecord[] {
	return readFileSync(backgroundTaskLogPath(dir), "utf-8")
		.split("\n")
		.filter(Boolean)
		// SAFETY: written by recordBackgroundTasks in this test; shape is ours.
		.map((line) => JSON.parse(line) as BackgroundTaskRecord);
}

function record(tasks: unknown, ts = TS): number {
	return recordBackgroundTasks({
		tasks: parseBackgroundTasks(tasks),
		sessionId: "s1",
		hookEvent: "SubagentStop",
		ts,
		cwd: dir,
	});
}

describe("parseBackgroundTasks — positive (must parse)", () => {
	it("P1: parses the roster shape the runner sends", () => {
		expect(
			parseBackgroundTasks([
				{ id: "b1", type: "agent", status: "running", description: "audit", agent_type: "general-purpose" },
			]),
		).toEqual([
			{ id: "b1", type: "agent", status: "running", description: "audit", agent_type: "general-purpose" },
		]);
	});

	it("P2: fills absent optional fields with null rather than dropping the task", () => {
		expect(parseBackgroundTasks([{ id: "b2" }])).toEqual([
			{ id: "b2", type: null, status: null, description: null, agent_type: null },
		]);
	});
});

describe("parseBackgroundTasks — negative (must not fabricate)", () => {
	it("N1: a non-array payload parses to nothing", () => {
		expect(parseBackgroundTasks(undefined)).toEqual([]);
		expect(parseBackgroundTasks({ id: "b1" })).toEqual([]);
		expect(parseBackgroundTasks("running")).toEqual([]);
	});

	it("N2: entries without an id are skipped — they cannot be state-tracked", () => {
		expect(parseBackgroundTasks([{ status: "running" }, null, 7])).toEqual([]);
	});
});

describe("recordBackgroundTasks", () => {
	it("P3: writes a row on first sight of a task", () => {
		expect(record([{ id: "b1", status: "running", type: "agent" }])).toBe(1);
		expect(rows()[0]).toMatchObject({
			schema: "background-task.v1",
			id: "b1",
			status: "running",
			session_id: "s1",
			hook_event: "SubagentStop",
		});
	});

	it("P4: writes a second row when the status changes", () => {
		record([{ id: "b1", status: "running" }]);
		expect(record([{ id: "b1", status: "completed" }])).toBe(1);
		expect(rows().map((r) => r.status)).toEqual(["running", "completed"]);
	});

	it("N3: re-observing the same status appends nothing", () => {
		record([{ id: "b1", status: "running" }]);
		expect(record([{ id: "b1", status: "running" }])).toBe(0);
		expect(rows()).toHaveLength(1);
	});

	it("N4: an empty roster writes no file", () => {
		expect(record([])).toBe(0);
		expect(() => readFileSync(backgroundTaskLogPath(dir), "utf-8")).toThrow();
	});

	it("N5: a dry-run event never mutates the log", () => {
		const written = recordBackgroundTasks({
			tasks: parseBackgroundTasks([{ id: "b1", status: "running" }]),
			sessionId: "s1",
			hookEvent: "SubagentStop",
			ts: TS,
			cwd: dir,
			dryRun: true,
		});
		expect(written).toBe(0);
		expect(() => readFileSync(backgroundTaskLogPath(dir), "utf-8")).toThrow();
	});

	it("N6: a missing log reads as no known statuses", () => {
		expect(lastStatuses(dir).size).toBe(0);
	});
});

describe("lastStatuses — malformed rows (parseStatusRow)", () => {
	function seedRawLines(lines: string[]): void {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		appendFileSync(backgroundTaskLogPath(dir), `${lines.join("\n")}\n`);
	}

	it("P5: reads back a valid row's id and status", () => {
		record([{ id: "b1", status: "running" }]);
		expect(lastStatuses(dir).get("b1")).toBe("running");
	});

	it("N7: a row with a non-string id is skipped entirely", () => {
		seedRawLines([JSON.stringify({ id: 42, status: "running" })]);
		expect(lastStatuses(dir).size).toBe(0);
	});

	it("N8: a row with a non-string status normalizes to null rather than leaking the raw value", () => {
		seedRawLines([JSON.stringify({ id: "b9", status: 7 })]);
		expect(lastStatuses(dir).get("b9")).toBeNull();
	});

	it("N9: a non-object line (array/number/null) is skipped without throwing", () => {
		seedRawLines(["[1,2,3]", "42", "null"]);
		expect(lastStatuses(dir).size).toBe(0);
	});

	it("N10: a line that fails JSON.parse entirely is skipped, letting a later valid row through", () => {
		// Genuinely malformed JSON syntax (not just the wrong shape) — this is
		// the only fixture that reaches parseStatusRow's JSON.parse catch.
		seedRawLines(["{not valid json", JSON.stringify({ id: "b1", status: "running" })]);
		expect(() => lastStatuses(dir)).not.toThrow();
		expect(lastStatuses(dir).get("b1")).toBe("running");
	});
});

describe("lastStatuses — unreadable log (outer catch)", () => {
	afterEach(() => {
		vi.mocked(statSync).mockRestore();
	});

	it("N11: a stat failure after existsSync passes returns no known statuses instead of throwing", () => {
		record([{ id: "b1", status: "running" }]);
		vi.mocked(statSync).mockImplementationOnce(() => {
			throw new Error("EACCES: permission denied, stat");
		});
		expect(lastStatuses(dir).size).toBe(0);
	});
});

describe("recordBackgroundTasks — write failure (best-effort catch)", () => {
	afterEach(() => {
		vi.mocked(appendFileSync).mockRestore();
	});

	it("N12: an append failure is swallowed and reports 0 rows written", () => {
		vi.mocked(appendFileSync).mockImplementationOnce(() => {
			throw new Error("ENOSPC: no space left on device");
		});
		expect(record([{ id: "b1", status: "running" }])).toBe(0);
		// The write never completed, so the log file itself was never created.
		expect(() => readFileSync(backgroundTaskLogPath(dir), "utf-8")).toThrow();
	});
});
