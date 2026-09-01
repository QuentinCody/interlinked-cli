// ===========================================
// Viz Test Events — the ordered live test feed
// ===========================================
// A runner-agnostic, append-only record of "which test ran, in what order, and
// how did it end". Producers write it (the bundled vitest reporter, the TAP
// wrapper, any future adapter); the viz server tails it and streams it to the
// dashboard's TESTS lens.
//
// Deliberately NOT coupled to vitest: the schema is the intersection every test
// runner can express (run → file → test → verdict), so the dashboard renders the
// same way in a Python or Rust repo.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonObject } from "../json-types.js";
import { readRecentLines } from "../local-activity-collection.js";
import { createJsonlTailer } from "./event-stream.js";

/** Terminal verdict of a single test case. Closed domain — renderers switch on it. */
export type TestStatus = "pass" | "fail" | "skip" | "todo";

/** One line of the test feed. `kind` discriminates; all other fields are optional by kind. */
export interface TestEvent {
	ts: string;
	kind: "run_start" | "file_start" | "test" | "run_end";
	run_id: string;
	/** Human label for the run (the command, or the runner name). */
	label?: string;
	/** Test file, repo-relative when the producer can resolve it. */
	file?: string;
	/** Full test name (suite path joined with the case name). */
	name?: string;
	status?: TestStatus;
	/** Wall-clock duration in ms for a test, or for the whole run on `run_end`. */
	ms?: number;
	/** First line of the failure message, already truncated by the producer. */
	error?: string;
	passed?: number;
	failed?: number;
	skipped?: number;
}

/** Default feed location under a project root. Public so producers agree on it. */
export function testEventsPath(root: string): string {
	return join(root, ".interlinked", "test-events.jsonl");
}

/** Cap on a persisted error message — the dashboard shows one line, not a stack. */
const ERROR_MAX = 200;

/** Truncate a failure message to a single rendered line. */
export function trimError(message: string): string {
	const firstLine = message.split("\n")[0] ?? "";
	return firstLine.length > ERROR_MAX ? `${firstLine.slice(0, ERROR_MAX - 1)}…` : firstLine;
}

/**
 * Append one event to the feed. Best-effort: a producer runs inside someone
 * else's test process, so a failed write must never fail their suite.
 */
export function appendTestEvent(path: string, ev: TestEvent): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(ev)}\n`);
		return true;
	} catch (err) {
		void err; /* feed is observability-only — never break the host suite */
		return false;
	}
}

/** Narrow an arbitrary JSON value to an indexable object, or null. */
function asRecord(v: unknown): JsonObject | null {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
	// SAFETY: a non-null, non-array typeof-"object" value is an indexable
	// record at runtime; JsonObject's index signature makes this the one
	// narrowing point every field read below routes through.
	return v as JsonObject;
}

function str(o: JsonObject, key: string): string | undefined {
	const v = o[key];
	return typeof v === "string" ? v : undefined;
}

function num(o: JsonObject, key: string): number | undefined {
	const v = o[key];
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const KINDS = new Set(["run_start", "file_start", "test", "run_end"]);
const STATUSES = new Set(["pass", "fail", "skip", "todo"]);

/** Narrow an arbitrary string to the closed status domain, or undefined. */
function asStatus(v: string | undefined): TestStatus | undefined {
	// SAFETY: membership in STATUSES is exactly the TestStatus domain.
	return v !== undefined && STATUSES.has(v) ? (v as TestStatus) : undefined;
}

/** Copy the optional string fields a producer may set onto the event. */
function copyStrings(ev: TestEvent, r: JsonObject): void {
	for (const key of ["label", "file", "name", "error"] as const) {
		const v = str(r, key);
		if (v !== undefined) ev[key] = v;
	}
}

/** Copy the optional numeric fields a producer may set onto the event. */
function copyNumbers(ev: TestEvent, r: JsonObject): void {
	for (const key of ["ms", "passed", "failed", "skipped"] as const) {
		const v = num(r, key);
		if (v !== undefined) ev[key] = v;
	}
}

/** Parse one feed line into a typed event, or null if it is unusable. */
export function mapTestLine(line: string): TestEvent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (err) {
		void err; /* a partial/corrupt line is skipped, not fatal */
		return null;
	}
	const r = asRecord(parsed);
	if (!r) return null;
	const ts = str(r, "ts");
	const kind = str(r, "kind");
	const runId = str(r, "run_id");
	if (!ts || !kind || !runId || !KINDS.has(kind)) return null;

	// SAFETY: guarded by the KINDS membership check above.
	const ev: TestEvent = { ts, kind: kind as TestEvent["kind"], run_id: runId };
	copyStrings(ev, r);
	copyNumbers(ev, r);
	const status = asStatus(str(r, "status"));
	if (status) ev.status = status;
	return ev;
}

/** Read the most recent `max` test events (chronological order) to seed a new client. */
export function seedRecentTestEvents(path: string, max: number): TestEvent[] {
	if (!existsSync(path)) return [];
	const lines = readRecentLines(path, max); // newest-first
	const events: TestEvent[] = [];
	for (let i = lines.length - 1; i >= 0; i--) {
		const ev = mapTestLine(lines[i] ?? "");
		if (ev) events.push(ev);
	}
	return events;
}

interface TestTailer {
	stop: () => void;
}

/**
 * Feed poll interval. Faster than the activity/check tails (1s) because test
 * events arrive in bursts and the lens is about ORDER — a 1s window would
 * collapse a whole file's cases into one indistinguishable clump on screen.
 */
const TEST_POLL_MS = 400;

/**
 * Poll the feed for appended events and deliver each via `onEvent`. Mirrors the
 * activity/checks tailers: starts at the current EOF and unref's its interval so
 * it never keeps the server alive on its own.
 */
export function createTestTailer(
	path: string,
	onEvent: (ev: TestEvent) => void,
	intervalMs = TEST_POLL_MS,
): TestTailer {
	return createJsonlTailer(path, mapTestLine, onEvent, intervalMs);
}
