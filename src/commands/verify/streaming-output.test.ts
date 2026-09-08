// ===========================================
// streaming-output unit tests
// ===========================================
// Two halves:
//   1. Pure formatter helpers (streamCqSection / streamAllCqSections / the
//      skip-set module global) — capture stderr and assert exact emitted
//      strings + every branch.
//   2. Subprocess runners (runToolWithSpinner / runToolSilent) — node:child_process
//      `spawn` is mocked with an EventEmitter-backed fake ChildProcess so no
//      real process is launched, and timers are faked so the spinner interval
//      and the SIGTERM timeout fire deterministically.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- node:child_process mock -------------------------------------------------
// Hoisted: vitest moves vi.mock to the top, so the fake spawn must be reachable
// through a module-scope handle that the factory closes over.
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

import {
	getActiveSkipChecks,
	runToolSilent,
	runToolWithSpinner,
	SPINNER_FRAMES,
	setActiveSkipChecks,
	streamAllCqSections,
	streamCqSection,
} from "./streaming-output.js";
import { emptyResults } from "./tool-results-types.js";

// --- shared stderr capture ---------------------------------------------------
let stderrChunks: string[];
let origErr: typeof process.stderr.write;

beforeEach(() => {
	stderrChunks = [];
	origErr = process.stderr.write;
	process.stderr.write = ((chunk: string) => {
		stderrChunks.push(chunk);
		return true;
	});
});

afterEach(() => {
	process.stderr.write = origErr;
	setActiveSkipChecks(new Set());
});

const stderr = (): string => stderrChunks.join("");

// =============================================================================
// Formatter helpers
// =============================================================================

describe("SPINNER_FRAMES", () => {
	it("is the exact 10-frame braille cycle", () => {
		expect(SPINNER_FRAMES).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
	});
});

describe("activeSkipChecks", () => {
	it("setActiveSkipChecks round-trips via getActiveSkipChecks", () => {
		const next = new Set(["strong_typing"]);
		setActiveSkipChecks(next);
		expect(getActiveSkipChecks()).toBe(next);
		expect(getActiveSkipChecks().has("strong_typing")).toBe(true);
	});

	it("defaults to an empty set once cleared", () => {
		setActiveSkipChecks(new Set());
		expect(getActiveSkipChecks().size).toBe(0);
	});
});

describe("streamCqSection", () => {
	it("writes the bold label + green check + pass-label when there are no issues", () => {
		const allFlagged = new Set<string>();
		streamCqSection({
			label: "test section",
			issues: [],
			noun: "issues",
			passLabel: "all clear",
			details: false,
			color: "33",
			allFlaggedFiles: allFlagged,
		});
		// Exact wire format: bold label line, then indented green check + pass label.
		expect(stderr()).toBe("\n  \x1b[1mtest section\x1b[0m\n    \x1b[32m✓\x1b[0m all clear\n");
		expect(allFlagged.size).toBe(0);
	});

	it("emits the count/noun/file summary and adds flagged files to the set", () => {
		const allFlagged = new Set<string>(["preexisting.ts"]);
		streamCqSection({
			label: "bad thing",
			issues: [
				{ check: "x", file: "a.ts", line: 1, message: "m" },
				{ check: "x", file: "b.ts", line: 2, message: "n" },
			],
			noun: "bad things",
			passLabel: "no bad things",
			details: false,
			color: "31",
			allFlaggedFiles: allFlagged,
		});
		const out = stderr();
		// "! 2 bad things in 2 files" with the section color (31) on the markers.
		expect(out).toContain(
			"    \x1b[31m!\x1b[0m \x1b[31m2\x1b[0m bad things in \x1b[31m2\x1b[0m files\n",
		);
		// Files listed dim + sorted; no detail lines because details:false.
		expect(out).toContain("\x1b[2m         a.ts\x1b[0m\n");
		expect(out).toContain("\x1b[2m         b.ts\x1b[0m\n");
		expect(out).not.toContain("L1:");
		// Pre-existing entry preserved; both new files added.
		expect([...allFlagged].sort()).toEqual(["a.ts", "b.ts", "preexisting.ts"]);
	});

	it("dedupes files in the count when one file has several issues", () => {
		const allFlagged = new Set<string>();
		streamCqSection({
			label: "dupes",
			issues: [
				{ check: "x", file: "same.ts", line: 1, message: "m1" },
				{ check: "x", file: "same.ts", line: 2, message: "m2" },
			],
			noun: "issues",
			passLabel: "pass",
			details: false,
			color: "31",
			allFlaggedFiles: allFlagged,
		});
		// 2 issues, but only 1 file.
		expect(stderr()).toContain(
			"\x1b[31m!\x1b[0m \x1b[31m2\x1b[0m issues in \x1b[31m1\x1b[0m files\n",
		);
	});

	it("with details:true prints the L-prefix for line>0 and bare message for line<=0", () => {
		const allFlagged = new Set<string>();
		streamCqSection({
			label: "detailed",
			issues: [
				{ check: "x", file: "a.ts", line: 42, message: "has a line" },
				{ check: "x", file: "a.ts", line: 0, message: "no line" },
			],
			noun: "issues",
			passLabel: "pass",
			details: true,
			color: "31",
			allFlaggedFiles: allFlagged,
		});
		const out = stderr();
		// line > 0 -> "L42: " prefix; line === 0 -> empty prefix.
		expect(out).toContain("\x1b[2m           L42: has a line\x1b[0m\n");
		expect(out).toContain("\x1b[2m           no line\x1b[0m\n");
	});

	it("truncates per-file detail lines past MAX_FILE_DETAIL_LINES (5) with a remainder note", () => {
		const allFlagged = new Set<string>();
		const issues = Array.from({ length: 7 }, (_, i) => ({
			check: "x",
			file: "big.ts",
			line: i + 1,
			message: `msg${i + 1}`,
		}));
		streamCqSection({
			label: "many lines",
			issues,
			noun: "issues",
			passLabel: "pass",
			details: true,
			color: "31",
			allFlaggedFiles: allFlagged,
		});
		const out = stderr();
		// First 5 detail lines shown.
		expect(out).toContain("L1: msg1");
		expect(out).toContain("L5: msg5");
		// 6th/7th suppressed; remainder note for the 2 extras.
		expect(out).not.toContain("L6: msg6");
		expect(out).toContain("\x1b[2m           ... and 2 more\x1b[0m\n");
	});

	it("does NOT print a per-file remainder note when exactly MAX_FILE_DETAIL_LINES (5)", () => {
		const allFlagged = new Set<string>();
		const issues = Array.from({ length: 5 }, (_, i) => ({
			check: "x",
			file: "edge.ts",
			line: i + 1,
			message: `m${i + 1}`,
		}));
		streamCqSection({
			label: "exactly five",
			issues,
			noun: "issues",
			passLabel: "pass",
			details: true,
			color: "31",
			allFlaggedFiles: allFlagged,
		});
		expect(stderr()).not.toContain("more");
	});

	it("skips detail rendering for additional files when details:false (continue branch)", () => {
		const allFlagged = new Set<string>();
		streamCqSection({
			label: "no details",
			issues: [
				{ check: "x", file: "a.ts", line: 5, message: "should not show" },
				{ check: "x", file: "b.ts", line: 6, message: "also hidden" },
			],
			noun: "issues",
			passLabel: "pass",
			details: false,
			color: "31",
			allFlaggedFiles: allFlagged,
		});
		const out = stderr();
		// Filenames shown, but no message/line detail at all.
		expect(out).toContain("a.ts");
		expect(out).toContain("b.ts");
		expect(out).not.toContain("should not show");
		expect(out).not.toContain("also hidden");
	});

	it("truncates the file list past MAX_LISTED_FILES (15) with a files-remainder note", () => {
		const allFlagged = new Set<string>();
		// 20 distinct files, zero-padded so lexicographic sort == numeric order.
		const issues = Array.from({ length: 20 }, (_, i) => ({
			check: "x",
			file: `f${String(i).padStart(2, "0")}.ts`,
			line: 1,
			message: "m",
		}));
		streamCqSection({
			label: "many files",
			issues,
			noun: "issues",
			passLabel: "pass",
			details: false,
			color: "31",
			allFlaggedFiles: allFlagged,
		});
		const out = stderr();
		// First 15 listed (f00..f14), f15+ omitted.
		expect(out).toContain("f00.ts");
		expect(out).toContain("f14.ts");
		expect(out).not.toContain("f15.ts");
		// 20 - 15 = 5 more files.
		expect(out).toContain("\x1b[2m         ... and 5 more files\x1b[0m\n");
	});

	it("truncates over-long detail messages at MESSAGE_MAX_LENGTH (100)", () => {
		const allFlagged = new Set<string>();
		const longMsg = "z".repeat(150);
		streamCqSection({
			label: "long msg",
			issues: [{ check: "x", file: "a.ts", line: 1, message: longMsg }],
			noun: "issues",
			passLabel: "pass",
			details: true,
			color: "31",
			allFlaggedFiles: allFlagged,
		});
		const out = stderr();
		expect(out).toContain(`L1: ${"z".repeat(100)}\x1b[0m`);
		expect(out).not.toContain("z".repeat(101));
	});

	it("respects the skip set keyed on the normalized label when no skipId", () => {
		setActiveSkipChecks(new Set(["skip_me"]));
		const allFlagged = new Set<string>();
		streamCqSection({
			label: "skip me", // normalizes to "skip_me"
			issues: [{ check: "x", file: "a.ts", line: 1, message: "m" }],
			noun: "x",
			passLabel: "pass",
			details: false,
			color: "33",
			allFlaggedFiles: allFlagged,
		});
		expect(stderr()).toBe("");
		expect(allFlagged.size).toBe(0);
	});

	it("normalizes both spaces and hyphens to underscores for the skip key", () => {
		setActiveSkipChecks(new Set(["mock_only_tests"]));
		const allFlagged = new Set<string>();
		streamCqSection({
			label: "mock-only tests", // hyphen + space -> "mock_only_tests"
			issues: [{ check: "x", file: "a.ts", line: 1, message: "m" }],
			noun: "x",
			passLabel: "pass",
			details: false,
			color: "33",
			allFlaggedFiles: allFlagged,
		});
		expect(stderr()).toBe("");
	});

	it("respects an explicit skip id when the human label differs", () => {
		setActiveSkipChecks(new Set(["mock_only_test"]));
		const allFlagged = new Set<string>();
		streamCqSection({
			label: "mock-only tests",
			skipId: "mock_only_test",
			issues: [{ check: "mock_only_test", file: "a.test.ts", line: 1, message: "m" }],
			noun: "x",
			passLabel: "pass",
			details: false,
			color: "33",
			allFlaggedFiles: allFlagged,
		});
		expect(stderr()).toBe("");
		expect(allFlagged.size).toBe(0);
	});

	it("does NOT skip when the skip set is non-empty but lacks this key", () => {
		setActiveSkipChecks(new Set(["some_other_check"]));
		const allFlagged = new Set<string>();
		streamCqSection({
			label: "render me",
			issues: [],
			noun: "x",
			passLabel: "still rendered",
			details: false,
			color: "33",
			allFlaggedFiles: allFlagged,
		});
		expect(stderr()).toContain("still rendered");
	});

	it("does NOT consult the skip set at all when it is empty (size guard short-circuit)", () => {
		// Empty skip set: even a label whose normalized form would 'match' nothing
		// must render, exercising the `activeSkipChecks.size > 0` left operand=false.
		setActiveSkipChecks(new Set());
		const allFlagged = new Set<string>();
		streamCqSection({
			label: "anything",
			issues: [],
			noun: "x",
			passLabel: "rendered",
			details: false,
			color: "33",
			allFlaggedFiles: allFlagged,
		});
		expect(stderr()).toContain("rendered");
	});
});

describe("streamAllCqSections", () => {
	it("renders a pass line for every section when results are empty", () => {
		streamAllCqSections(emptyResults(), false, new Set<string>());
		const out = stderr();
		// A couple of representative sections from the core table.
		expect(out).toContain("json validity");
		expect(out).toContain("all JSON files valid");
		expect(out).toContain("strong typing");
		expect(out).toContain("\x1b[32m✓\x1b[0m"); // green check present
	});

	it("forwards the details flag and the shared allFlaggedFiles set through to sections", () => {
		const cq = emptyResults();
		cq.jsonValidity = [{ check: "json_validity", file: "broken.json", line: 7, message: "boom" }];
		const allFlagged = new Set<string>();
		streamAllCqSections(cq, true, allFlagged);
		const out = stderr();
		// details:true => the L7 message detail line is rendered.
		expect(out).toContain("L7: boom");
		// the file propagated into the shared set.
		expect(allFlagged.has("broken.json")).toBe(true);
	});

	it("uses section skip ids instead of normalized labels", () => {
		setActiveSkipChecks(new Set(["mock_only_test", "happy_path_only_test"]));
		const cq = emptyResults();
		cq.mockOnlyTest = [
			{ check: "mock_only_test", file: "a.test.ts", line: 1, message: "mock only" },
		];
		cq.happyPathOnlyTest = [
			{ check: "happy_path_only_test", file: "b.test.ts", line: 1, message: "happy path only" },
		];

		streamAllCqSections(cq, false, new Set<string>());

		const out = stderr();
		expect(out).not.toContain("mock-only tests");
		expect(out).not.toContain("happy-path-only test files");
	});
});

// =============================================================================
// Subprocess runners
// =============================================================================

interface FakeStream {
	on(event: "data", cb: (d: Buffer) => void): void;
	emitData(s: string): void;
}

interface FakeChild extends EventEmitter {
	stdout: FakeStream;
	stderr: FakeStream;
	kill: ReturnType<typeof vi.fn>;
}

function makeStream(): FakeStream {
	let handler: ((d: Buffer) => void) | undefined;
	return {
		on(_event, cb) {
			handler = cb;
		},
		emitData(s) {
			handler?.(Buffer.from(s));
		},
	};
}

/** Build an EventEmitter-backed stand-in for a ChildProcess. */
function makeChild(): FakeChild {
	return Object.assign(new EventEmitter(), {
		stdout: makeStream(), stderr: makeStream(), kill: vi.fn(),
	});
}

describe("runToolWithSpinner", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("spawns bin + args with cwd and stdio, animates the spinner, then resolves on close", async () => {
		const child = makeChild();
		spawnMock.mockReturnValue(child);

		const parseOutput = vi.fn((output: string, code: number | null) => [
			{ output, code },
		]);
		const promise = runToolWithSpinner({
			label: "tsc",
			cmd: ["tsc", "--noEmit", "-p", "."],
			cwd: "/work",
			timeoutMs: 5000,
			parseOutput,
		});

		// spawn called with the right shape.
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(spawnMock).toHaveBeenCalledWith("tsc", ["--noEmit", "-p", "."], {
			cwd: "/work",
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Drive the spinner: advance ~1.1s so the interval (80ms) fires and the
		// elapsed-seconds counter reads "1".
		vi.advanceTimersByTime(1120);
		const spinnerOut = stderr();
		expect(spinnerOut).toContain(SPINNER_FRAMES[0]); // first frame
		expect(spinnerOut).toContain(SPINNER_FRAMES[1]); // animation advanced
		expect(spinnerOut).toContain("\x1b[1mtsc\x1b[0m"); // bold label
		expect(spinnerOut).toContain("1s"); // elapsed seconds

		// Feed output then close cleanly.
		child.stdout.emitData("out-chunk ");
		child.stderr.emitData("err-chunk");
		child.emit("close", 0);

		const result = await promise;
		// stdout+stderr concatenated and handed to parseOutput with the exit code.
		expect(parseOutput).toHaveBeenCalledWith("out-chunk err-chunk", 0);
		expect(result.items).toEqual([{ output: "out-chunk err-chunk", code: 0 }]);
		// Line cleared on close.
		expect(stderr().endsWith("\r\x1b[K")).toBe(true);
	});

	it("formats elapsedMs to one decimal from Date.now() delta", async () => {
		const child = makeChild();
		spawnMock.mockReturnValue(child);
		const promise = runToolWithSpinner({
			label: "x",
			cmd: ["x"],
			cwd: ".",
			timeoutMs: 1000,
			parseOutput: () => [],
		});
		// 2500ms elapsed -> "2.5s". Advance under the 1000ms timeout would kill;
		// instead jump the clock without firing the timer by setting system time,
		// then closing.
		vi.setSystemTime(2500);
		child.emit("close", 0);
		const result = await promise;
		expect(result.elapsedMs).toBe("2.5s");
	});

	it("cycles spinner frames with modulo past the frame count", async () => {
		const child = makeChild();
		spawnMock.mockReturnValue(child);
		const promise = runToolWithSpinner({
			label: "loop",
			cmd: ["loop"],
			cwd: ".",
			timeoutMs: 1_000_000,
			parseOutput: () => [],
		});
		// 11 ticks (> 10 frames) so frame index wraps back to SPINNER_FRAMES[0].
		vi.advanceTimersByTime(80 * 11 + 5);
		const out = stderr();
		// Every frame should have appeared at least once after a full wrap.
		for (const f of SPINNER_FRAMES) expect(out).toContain(f);
		child.emit("close", 0);
		await promise;
	});

	it("returns empty + stops the spinner when cmd[0] is undefined (no spawn)", async () => {
		const promise = runToolWithSpinner({
			label: "empty",
			cmd: [],
			cwd: ".",
			timeoutMs: 1000,
			parseOutput: () => [{ should: "not" }],
		});
		const result = await promise;
		expect(spawnMock).not.toHaveBeenCalled();
		expect(result.items).toEqual([]);
		expect(result.elapsedMs).toBe("0.0s");
		// No spinner interval should be left running; advancing time writes nothing.
		stderrChunks = [];
		vi.advanceTimersByTime(1000);
		expect(stderr()).toBe("");
	});

	it("kills the process with SIGTERM when the timeout elapses", async () => {
		const child = makeChild();
		spawnMock.mockReturnValue(child);
		const promise = runToolWithSpinner({
			label: "slow",
			cmd: ["slow"],
			cwd: ".",
			timeoutMs: 1000,
			parseOutput: () => [],
		});
		// Cross the timeout boundary -> kill fired.
		vi.advanceTimersByTime(1000);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		// The kill leads to a close in reality; emit it so the promise settles.
		child.emit("close", null);
		await promise;
	});

	it("resolves empty and clears the line on spawn 'error'", async () => {
		const child = makeChild();
		spawnMock.mockReturnValue(child);
		const parseOutput = vi.fn(() => [{ x: 1 }]);
		const promise = runToolWithSpinner({
			label: "enoent",
			cmd: ["nope"],
			cwd: ".",
			timeoutMs: 1000,
			parseOutput,
		});
		child.emit("error", new Error("ENOENT"));
		const result = await promise;
		// error path returns [] and never calls parseOutput.
		expect(parseOutput).not.toHaveBeenCalled();
		expect(result.items).toEqual([]);
		expect(stderr()).toContain("\r\x1b[K");
		// kill timer must be cleared: advancing time must not fire kill.
		vi.advanceTimersByTime(2000);
		expect(child.kill).not.toHaveBeenCalled();
	});

	it("passes the close exit code (including null) through to parseOutput", async () => {
		const child = makeChild();
		spawnMock.mockReturnValue(child);
		const parseOutput = vi.fn((_o: string, code: number | null) => [code]);
		const promise = runToolWithSpinner({
			label: "code",
			cmd: ["code"],
			cwd: ".",
			timeoutMs: 1000,
			parseOutput,
		});
		child.emit("close", null);
		const result = await promise;
		expect(parseOutput).toHaveBeenCalledWith("", null);
		expect(result.items).toEqual([null]);
	});
});

describe("runToolSilent", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("spawns silently (no stderr writes) and resolves parsed items on close", async () => {
		const child = makeChild();
		spawnMock.mockReturnValue(child);
		const parseOutput = vi.fn((output: string, code: number | null) => [{ output, code }]);
		const promise = runToolSilent({
			cmd: ["oxlint", "src"],
			cwd: "/repo",
			timeoutMs: 3000,
			parseOutput,
		});
		expect(spawnMock).toHaveBeenCalledWith("oxlint", ["src"], {
			cwd: "/repo",
			stdio: ["pipe", "pipe", "pipe"],
		});

		child.stdout.emitData("hello ");
		child.stderr.emitData("world");
		child.emit("close", 1);

		const result = await promise;
		expect(parseOutput).toHaveBeenCalledWith("hello world", 1);
		expect(result.items).toEqual([{ output: "hello world", code: 1 }]);
		// Silent: it must NOT emit any spinner / clear sequences.
		expect(stderr()).toBe("");
	});

	it("formats elapsedMs to one decimal", async () => {
		const child = makeChild();
		spawnMock.mockReturnValue(child);
		const promise = runToolSilent({
			cmd: ["x"],
			cwd: ".",
			timeoutMs: 9000,
			parseOutput: () => [],
		});
		vi.setSystemTime(1500);
		child.emit("close", 0);
		const result = await promise;
		expect(result.elapsedMs).toBe("1.5s");
	});

	it("returns empty when cmd[0] is undefined (no spawn)", async () => {
		const promise = runToolSilent({
			cmd: [],
			cwd: ".",
			timeoutMs: 1000,
			parseOutput: () => [{ nope: true }],
		});
		const result = await promise;
		expect(spawnMock).not.toHaveBeenCalled();
		expect(result.items).toEqual([]);
		expect(result.elapsedMs).toBe("0.0s");
	});

	it("kills the process with SIGTERM when the timeout elapses", async () => {
		const child = makeChild();
		spawnMock.mockReturnValue(child);
		const promise = runToolSilent({
			cmd: ["slow"],
			cwd: ".",
			timeoutMs: 500,
			parseOutput: () => [],
		});
		vi.advanceTimersByTime(500);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		child.emit("close", null);
		await promise;
	});

	it("resolves empty on spawn 'error' without calling parseOutput, and clears the kill timer", async () => {
		const child = makeChild();
		spawnMock.mockReturnValue(child);
		const parseOutput = vi.fn(() => [1]);
		const promise = runToolSilent({
			cmd: ["nope"],
			cwd: ".",
			timeoutMs: 1000,
			parseOutput,
		});
		child.emit("error", new Error("ENOENT"));
		const result = await promise;
		expect(parseOutput).not.toHaveBeenCalled();
		expect(result.items).toEqual([]);
		vi.advanceTimersByTime(2000);
		expect(child.kill).not.toHaveBeenCalled();
	});

	it("passes a null exit code through to parseOutput on close", async () => {
		const child = makeChild();
		spawnMock.mockReturnValue(child);
		const parseOutput = vi.fn((_o: string, code: number | null) => [code]);
		const promise = runToolSilent({
			cmd: ["code"],
			cwd: ".",
			timeoutMs: 1000,
			parseOutput,
		});
		child.emit("close", null);
		const result = await promise;
		expect(parseOutput).toHaveBeenCalledWith("", null);
		expect(result.items).toEqual([null]);
	});
});
