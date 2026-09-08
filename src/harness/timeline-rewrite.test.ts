import { parseWire, wireObject, wireString } from "../lib/value-validation.js";
// Companion tests for timeline-rewrite.ts — the bounded, concurrent-safe
// whole-file timeline reconstruction used by the backfill/repair path
// (timeline-writer.ts wraps writeTimeline for the append-only live path;
// this file drives timeline-rewrite.ts's own exports directly).
//
// node:fs's statSync is wrapped with vi.fn(actual.statSync) — call-through
// by default for every test — so the handful of tests that simulate a
// concurrent writer (mid-rewrite growth/shrink) or a permission error can
// override just that one call without mocking timeline-rewrite.ts itself.
// The growth simulation appends REAL bytes to the REAL fixture file from
// inside the mocked statSync call, then defers to the real statSync, so the
// reported size and the on-disk content never disagree — no fabricated
// stat fields anywhere.

import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: vi.fn(actual.statSync) };
});

import { MAX_CAPTURED_JSONL_LINE_BYTES } from "../lib/bounded-file-io.js";
import { serializeRecord, timelinePath } from "./timeline-record-utils.js";
import {
	assertTimelineMaterializationBounds,
	captureTimelineBasis,
	MAX_TIMELINE_REWRITE_BYTES,
	MAX_TIMELINE_REWRITE_CATCHUPS,
	MAX_TIMELINE_REWRITE_RECORDS,
	TimelineRewriteConflictError,
	writeTimeline,
} from "./timeline-rewrite.js";
import type { TimelineRecord } from "./transcript-record.js";

function rec(
	over: Partial<TimelineRecord> & Pick<TimelineRecord, "ts" | "uuid" | "seq">,
): TimelineRecord {
	return { schema: "timeline.v1", session: "s1", category: "agent_message", role: "assistant", ...over };
}

/** Runs `fn`, returning whatever it throws (or undefined if it doesn't). */
function captureThrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

// Growth-simulation state for the "concurrent writer appends mid-rewrite"
// tests. Armed per-test via writeTimeline's afterBasisCaptured hook so the
// very first (outer) basis capture never sees the injected growth — only
// statSync calls made while validateAndReplaceOrCaptureTail re-checks the
// file see it.
let actualStatSync: typeof statSync;
let growTarget = "";
let growEnabled = false;
let growRemaining = 0;
let growSeq = 0;

beforeEach(async () => {
	const fsActual = await vi.importActual<typeof import("node:fs")>("node:fs");
	actualStatSync = fsActual.statSync;
	growTarget = "";
	growEnabled = false;
	growRemaining = 0;
	growSeq = 0;
	vi.mocked(statSync).mockImplementation((...args: Parameters<typeof statSync>) => {
		const [path] = args;
		if (growEnabled && growRemaining > 0 && path === growTarget) {
			growRemaining--;
			growSeq++;
			appendFileSync(
				growTarget,
				`${serializeRecord(
					rec({ ts: "2026-01-01T00:00:00.000Z", uuid: `grow-${growSeq}`, seq: growSeq }),
				)}\n`,
			);
		}
		return actualStatSync(...args);
	});
});

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "tlrw-"));
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("captureTimelineBasis", () => {
	it("rethrows a stat error that is not ENOENT", () => {
		const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
		vi.mocked(statSync).mockImplementationOnce(() => {
			throw permissionError;
		});
		const caught = captureThrown(() => captureTimelineBasis(join(cwd, "unreadable.jsonl")));
		expect(caught).toBe(permissionError);
	});
});

describe("assertTimelineMaterializationBounds", () => {
	it("throws when the record count exceeds the rewrite cap", () => {
		const one = rec({ ts: "t", uuid: "u", seq: 0 });
		const tooMany = new Array(MAX_TIMELINE_REWRITE_RECORDS + 1).fill(one);
		expect(() => assertTimelineMaterializationBounds(tooMany, "backfill input")).toThrow(
			`refusing ${MAX_TIMELINE_REWRITE_RECORDS + 1} backfill input records (limit ${MAX_TIMELINE_REWRITE_RECORDS})`,
		);
	});

	it("throws when total serialized bytes exceed the rewrite cap with no single row oversized", () => {
		const text = "x".repeat(200_000);
		const count = Math.ceil(MAX_TIMELINE_REWRITE_BYTES / 200_050) + 5;
		const records = Array.from({ length: count }, (_, index) =>
			rec({ ts: "t", uuid: `u${index}`, seq: index, text }),
		);
		const thrown = captureThrown(() =>
			assertTimelineMaterializationBounds(records, "caught-up timeline"),
		);
		// Pin the reported byte count, not just its shape: a regex that only
		// checks "some digits" still matches a mutant that inverts the `>`
		// comparison and reports a count BELOW the limit. Assert the count is
		// actually over MAX_TIMELINE_REWRITE_BYTES, which is the observable
		// the branch at line 165 exists to produce.
		assert(thrown instanceof Error);
		const match = new RegExp(
			`^refusing (\\d+) serialized caught-up timeline bytes \\(limit ${MAX_TIMELINE_REWRITE_BYTES}\\)$`,
		).exec(thrown.message);
		expect(Number(match?.[1])).toBeGreaterThan(MAX_TIMELINE_REWRITE_BYTES);
	});
});

describe("writeTimeline — validating a pre-existing timeline before rewriting", () => {
	it("throws when an existing row is not valid JSON", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(timelinePath(cwd), "{not valid json\n");
		expect(() => writeTimeline([rec({ ts: "t", uuid: "new", seq: 0 })], cwd)).toThrow(
			"timeline changed with a malformed JSONL row",
		);
	});

	it("throws when an existing row is valid JSON but not a timeline record", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(timelinePath(cwd), `${JSON.stringify({ hello: "world" })}\n`);
		expect(() => writeTimeline([rec({ ts: "t", uuid: "new", seq: 0 })], cwd)).toThrow(
			"timeline changed with an invalid timeline record",
		);
	});

	it("throws when an existing row is a single line larger than the captured-line cap", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(timelinePath(cwd), `${"x".repeat(MAX_CAPTURED_JSONL_LINE_BYTES + 10_000)}\n`);
		expect(() => writeTimeline([rec({ ts: "t", uuid: "new", seq: 0 })], cwd)).toThrow(
			`timeline contains a row larger than ${MAX_CAPTURED_JSONL_LINE_BYTES} bytes`,
		);
	});

	it("throws when an existing file's row count exceeds the rewrite cap while scanning", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const line = `${JSON.stringify({
			schema: "timeline.v1",
			ts: "t",
			session: "s",
			uuid: "u",
			seq: 0,
			category: "agent_message",
			role: "assistant",
		})}\n`;
		writeFileSync(timelinePath(cwd), line.repeat(MAX_TIMELINE_REWRITE_RECORDS + 1));
		expect(() => writeTimeline([rec({ ts: "t2", uuid: "new", seq: 0 })], cwd)).toThrow(
			`timeline contains more than ${MAX_TIMELINE_REWRITE_RECORDS} records`,
		);
	});
});

describe("writeTimeline — concurrent mutation between basis capture and replace", () => {
	it("throws when the timeline shrinks while the replacement is being prepared", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const path = timelinePath(cwd);
		writeFileSync(
			path,
			`${JSON.stringify(rec({ ts: "t", uuid: "orig", seq: 0 }))}\n${JSON.stringify(
				rec({ ts: "t2", uuid: "orig2", seq: 0 }),
			)}\n`,
		);
		expect(() =>
			writeTimeline([rec({ ts: "t3", uuid: "new", seq: 0 })], cwd, {
				afterBasisCaptured: () => {
					truncateSync(path, 0);
				},
			}),
		).toThrow("timeline shrank while preparing the replacement");
	});

	it("reconciles one concurrent append captured mid-rewrite into the final file", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const path = timelinePath(cwd);
		writeFileSync(path, "");
		growTarget = path;
		growRemaining = 1;
		const count = writeTimeline(
			[rec({ ts: "2026-01-01T00:00:02.000Z", uuid: "mine", seq: 0 })],
			cwd,
			{ afterBasisCaptured: () => { growEnabled = true; } },
		);
		expect(count).toBe(2);
		const rows = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => parseWire(JSON.parse(line), wireObject({ "uuid": wireString }), "test JSON value"));
		expect(rows.map((row) => row.uuid)).toEqual(["grow-1", "mine"]);
	});

	it("throws when the timeline keeps growing across every allowed catch-up round", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const path = timelinePath(cwd);
		writeFileSync(path, "");
		growTarget = path;
		growRemaining = 20;
		const caught = captureThrown(() =>
			writeTimeline([rec({ ts: "2026-01-01T00:00:02.000Z", uuid: "mine", seq: 0 })], cwd, {
				afterBasisCaptured: () => { growEnabled = true; },
			}),
		);
		expect(caught).toBeInstanceOf(TimelineRewriteConflictError);
		// SAFETY: just asserted caught is a TimelineRewriteConflictError, which
		// extends Error, so .message is a real string on the instance above.
		expect(caught).toHaveProperty(["message"], `timeline stayed busy across ${MAX_TIMELINE_REWRITE_CATCHUPS} catch-ups`);
	});
});
