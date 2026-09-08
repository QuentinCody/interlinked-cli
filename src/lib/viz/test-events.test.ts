import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendTestEvent,
	createTestTailer,
	mapTestLine,
	type TestEvent,
	testEventsPath,
	trimError,
} from "./test-events.js";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "viz-test-events-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const ev = (over: Partial<TestEvent> = {}): TestEvent => ({
	ts: "2026-08-04T00:00:00.000Z",
	kind: "test",
	run_id: "r1",
	...over,
});

describe("testEventsPath", () => {
	it("resolves under the project's .interlinked dir", () => {
		expect(testEventsPath("/proj")).toBe(join("/proj", ".interlinked", "test-events.jsonl"));
	});
});

describe("trimError", () => {
	it("keeps a short single line verbatim", () => {
		expect(trimError("expected 1 to be 2")).toBe("expected 1 to be 2");
	});

	it("drops everything after the first newline", () => {
		expect(trimError("boom\n  at foo.ts:1\n  at bar.ts:2")).toBe("boom");
	});

	it("truncates an over-long line with an ellipsis", () => {
		const out = trimError("x".repeat(500));
		expect(out).toHaveLength(200);
		expect(out.endsWith("…")).toBe(true);
	});
});

describe("appendTestEvent", () => {
	it("creates the parent directory and appends one JSON line per event", () => {
		const path = testEventsPath(dir);
		expect(appendTestEvent(path, ev({ name: "a" }))).toBe(true);
		expect(appendTestEvent(path, ev({ name: "b" }))).toBe(true);
		const lines = readFileSync(path, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1] ?? "").name).toBe("b");
	});

	it("returns false instead of throwing when the path is unwritable", () => {
		// a path under an existing FILE cannot be mkdir'd — the write must not throw
		const file = join(dir, "blocker");
		appendTestEvent(file, ev());
		expect(appendTestEvent(join(file, "nested", "feed.jsonl"), ev())).toBe(false);
	});
});

describe("mapTestLine", () => {
	it("parses a full test event", () => {
		const line = JSON.stringify(ev({ file: "a.test.ts", name: "works", status: "pass", ms: 12 }));
		expect(mapTestLine(line)).toEqual({
			ts: "2026-08-04T00:00:00.000Z",
			kind: "test",
			run_id: "r1",
			file: "a.test.ts",
			name: "works",
			status: "pass",
			ms: 12,
		});
	});

	it("parses a run_end tally", () => {
		const line = JSON.stringify(ev({ kind: "run_end", passed: 3, failed: 1, skipped: 2, ms: 900 }));
		expect(mapTestLine(line)).toMatchObject({ kind: "run_end", passed: 3, failed: 1, skipped: 2 });
	});

	it("returns null on malformed JSON", () => {
		expect(mapTestLine("{not json")).toBeNull();
	});

	it("returns null on a non-object line", () => {
		expect(mapTestLine("42")).toBeNull();
	});

	it("returns null on a JSON array line", () => {
		expect(mapTestLine(JSON.stringify(["ts", "kind", "run_id"]))).toBeNull();
	});

	it("returns null when a required field is missing", () => {
		expect(mapTestLine(JSON.stringify({ ts: "t", kind: "test" }))).toBeNull();
		expect(mapTestLine(JSON.stringify({ kind: "test", run_id: "r" }))).toBeNull();
	});

	it("returns null on an unknown kind", () => {
		expect(mapTestLine(JSON.stringify({ ...ev(), kind: "explode" }))).toBeNull();
	});

	it("drops an out-of-domain status rather than passing it through", () => {
		const line = JSON.stringify({ ...ev(), status: "flaky" });
		expect(mapTestLine(line)?.status).toBeUndefined();
	});

	it("drops non-finite and wrong-typed optional fields", () => {
		const line = JSON.stringify({ ...ev(), ms: "12", name: 7 });
		const out = mapTestLine(line);
		expect(out?.ms).toBeUndefined();
		expect(out?.name).toBeUndefined();
	});
});

describe("createTestTailer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("delivers only events appended after it started", () => {
		const path = testEventsPath(dir);
		appendTestEvent(path, ev({ name: "before" }));
		const seen: TestEvent[] = [];
		const tailer = createTestTailer(path, (e) => seen.push(e), 100);

		appendTestEvent(path, ev({ name: "after" }));
		vi.advanceTimersByTime(150);
		tailer.stop();

		expect(seen.map((e) => e.name)).toEqual(["after"]);
	});

	it("stops polling once stopped", () => {
		const path = testEventsPath(dir);
		const seen: TestEvent[] = [];
		const tailer = createTestTailer(path, (e) => seen.push(e), 100);
		tailer.stop();
		appendTestEvent(path, ev({ name: "ignored" }));
		vi.advanceTimersByTime(500);
		expect(seen).toEqual([]);
	});
});
