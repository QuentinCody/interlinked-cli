import { parseWire, wireAbsentOptional, wireArray, wireNullable, wireNumber, wireObject, wireRecord, wireString } from "../lib/value-validation.js";
// ===========================================
// `interlinked harness latency` — behavioral coverage
// ===========================================
// Drives BOTH the pure aggregator (computeLatencyReport) and the Commander
// handler (harnessLatencyCommand) to ~100%.
//
// node:fs is mocked (a tiny virtual filesystem keyed by path) so we can:
//   - flip existsSync true/false (missing-log → empty report branch),
//   - make readFileSync THROW on an existing path (the fs-read catch branch,
//     unreachable with real fs on a readable temp file),
//   - serve arbitrary JSONL content (malformed-line skip, percentile math).
//
// The handler writes via process.stdout.write — we spy that and assert exact
// rendered strings (percentiles, padded columns, the em-dash null formatter,
// the "(none)" empty-sessions branch, the by-tool table). No real fs, no
// network, no wall-clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- node:fs mock -------------------------------------------------------
// A virtual filesystem. `files` maps absolute path → string content. A path
// listed in `readThrows` makes readFileSync throw (exercises the catch).
interface FsState {
	files: Map<string, string>;
	readThrows: Set<string>;
}

let fsState: FsState;

function freshFs(): FsState {
	return { files: new Map(), readThrows: new Set() };
}

vi.mock("node:fs", () => ({
	existsSync: (p: string): boolean =>
		fsState.files.has(p) || fsState.readThrows.has(p),
	readFileSync: (p: string): string => {
		if (fsState.readThrows.has(p)) {
			const err: Error & { code?: string } = new Error("EACCES read");
			err.code = "EACCES";
			throw err;
		}
		const content = fsState.files.get(p);
		if (content === undefined) {
			const err: Error & { code?: string } = new Error("ENOENT");
			err.code = "ENOENT";
			throw err;
		}
		return content;
	},
}));

import {
	computeLatencyReport,
	harnessLatencyCommand,
	type LatencyReport,
} from "./harness-latency.js";

const isCapturedLatencyReport = wireObject({ "total_events": wireNumber, "by_hook_event": wireRecord(wireNumber), "post_tool_use": wireObject({ "timing_count": wireNumber, "p50": wireNullable(wireNumber), "p90": wireNullable(wireNumber), "p99": wireNullable(wireNumber), "max": wireNullable(wireNumber) }), "slowest_sessions": wireArray(wireObject({ "session_id": wireString, "max_timing_ms": wireNumber, "event_count": wireNumber })), "by_tool": wireAbsentOptional(wireArray(wireObject({ "tool": wireString, "events": wireNumber, "when_present": wireObject({ "timing_count": wireNumber, "p50": wireNullable(wireNumber), "p90": wireNullable(wireNumber), "p99": wireNullable(wireNumber), "max": wireNullable(wireNumber) }) }))) });

// ---- helpers ------------------------------------------------------------

const CWD = "/repo";
const DEFAULT_LOG = "/repo/.interlinked/logs/latency.jsonl";

/** Build one latency record with sane defaults; override any field. */
const sample = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	hook_event: "PostToolUse",
	session_id: "s1",
	checks_ran: ["typescript", "biome_lint"],
	checks_timing_ms: 1000,
	...overrides,
});

/** Write records as JSONL into the virtual fs at the default log path. */
function writeLog(records: object[], path = DEFAULT_LOG): void {
	fsState.files.set(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** Capture everything the handler writes to process.stdout. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const spy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: string | Uint8Array): boolean => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
			return true;
		});
	try {
		await fn();
	} finally {
		spy.mockRestore();
	}
	return chunks.join("");
}

beforeEach(() => {
	fsState = freshFs();
	vi.spyOn(process, "cwd").mockReturnValue(CWD);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// =========================================================================
// computeLatencyReport — pure aggregator
// =========================================================================

describe("computeLatencyReport — empty / missing log", () => {
	it("returns a fully-zeroed report when the log does not exist", () => {
		const report = computeLatencyReport(CWD);
		expect(report).toEqual<LatencyReport>({
			total_events: 0,
			by_hook_event: {},
			post_tool_use: { timing_count: 0, p50: null, p90: null, p99: null, max: null },
			slowest_sessions: [],
		});
		// The empty branch never attaches by_tool.
		expect(report.by_tool).toBeUndefined();
	});

	it("returns the empty report when readFileSync throws (fs-read catch branch)", () => {
		// existsSync → true, but the read itself faults (permission glitch).
		fsState.readThrows.add(DEFAULT_LOG);
		const report = computeLatencyReport(CWD);
		expect(report.total_events).toBe(0);
		expect(report.post_tool_use.timing_count).toBe(0);
		expect(report.slowest_sessions).toEqual([]);
	});
});

describe("computeLatencyReport — log_path option (?? fallback)", () => {
	it("uses the default <cwd>/.interlinked/logs path when log_path is omitted", () => {
		writeLog([sample(), sample()]);
		expect(computeLatencyReport(CWD).total_events).toBe(2);
	});

	it("honors an explicit log_path override", () => {
		const custom = "/tmp/custom-latency.jsonl";
		writeLog([sample()], custom);
		// The default path is absent, proving the override is what was read.
		expect(computeLatencyReport(CWD, { log_path: custom }).total_events).toBe(1);
	});
});

describe("computeLatencyReport — parsing & grouping", () => {
	it("counts total events", () => {
		writeLog([sample(), sample(), sample()]);
		expect(computeLatencyReport(CWD).total_events).toBe(3);
	});

	it("skips blank lines and malformed JSON without crashing", () => {
		fsState.files.set(
			DEFAULT_LOG,
			[
				JSON.stringify(sample()),
				"", // blank → continue
				"   ", // whitespace-only → trimmed to "" → continue
				"{not valid json", // throws in JSON.parse → caught + skipped
				JSON.stringify(sample()),
			].join("\n") + "\n",
		);
		expect(computeLatencyReport(CWD).total_events).toBe(2);
	});

	it("P1: parses a well-formed record with every field present", () => {
		writeLog([sample()]);
		const report = computeLatencyReport(CWD);
		expect(report.total_events).toBe(1);
		expect(report.by_hook_event.PostToolUse).toBe(1);
	});

	it("N1: a line that parses to a bare JSON null is skipped instead of crashing", () => {
		// Before the isJsonObject gate, `JSON.parse("null") as LatencyRecord`
		// was pushed unchecked; the aggregation loop's `r.hook_event` access
		// then threw on the null row (not caught -- that try/catch only wraps
		// the parse+push, not later use), crashing the whole report.
		fsState.files.set(
			DEFAULT_LOG,
			[JSON.stringify(sample()), "null", JSON.stringify(sample())].join("\n") + "\n",
		);
		expect(() => computeLatencyReport(CWD)).not.toThrow();
		const report = computeLatencyReport(CWD);
		expect(report.total_events).toBe(2); // the null line contributes nothing
	});

	it("N2: a line that parses to a top-level JSON array is skipped", () => {
		fsState.files.set(
			DEFAULT_LOG,
			[JSON.stringify(sample()), JSON.stringify(["not", "a", "record"])].join("\n") + "\n",
		);
		const report = computeLatencyReport(CWD);
		expect(report.total_events).toBe(1);
	});

	it("N3: a session_id of the wrong type is folded to null rather than reaching .slice() as a non-string", () => {
		// The human-readable renderer calls session_id.slice(0, 36) with no
		// per-use typeof guard; a non-string session_id must not reach it.
		writeLog([sample({ session_id: 12345, checks_timing_ms: 500 })]);
		const report = computeLatencyReport(CWD);
		// session_id coerced to null -> excluded from session stats (same as
		// the pre-existing "ignores records with no session_id" behavior).
		expect(report.slowest_sessions).toEqual([]);
	});

	it("groups counts by hook_event and buckets a null hook_event under 'unknown'", () => {
		writeLog([
			sample({ hook_event: "PreToolUse" }),
			sample({ hook_event: "PreToolUse" }),
			sample({ hook_event: "PostToolUse" }),
			sample({ hook_event: null }), // → "unknown" via ??
			sample({ hook_event: 123 }), // wrong type is normalized to null, not "123"
		]);
		const report = computeLatencyReport(CWD);
		expect(report.by_hook_event).toEqual({
			PreToolUse: 2,
			PostToolUse: 1,
			unknown: 2,
		});
	});
});

describe("computeLatencyReport — PostToolUse percentiles", () => {
	it("computes p50/p90/p99/max over checks_timing_ms", () => {
		writeLog(
			[100, 200, 300, 400, 500].map((ms) => sample({ checks_timing_ms: ms })),
		);
		const p = computeLatencyReport(CWD).post_tool_use;
		expect(p.timing_count).toBe(5);
		expect(p.p50).toBe(300); // ceil(.5*5)=3 → idx 2
		expect(p.p90).toBe(500); // ceil(.9*5)=5 → idx 4
		expect(p.p99).toBe(500);
		expect(p.max).toBe(500);
	});

	it("computes p99 via nearest-rank over 100 samples", () => {
		writeLog(
			Array.from({ length: 100 }, (_, i) => sample({ checks_timing_ms: (i + 1) * 10 })),
		);
		expect(computeLatencyReport(CWD).post_tool_use.p99).toBe(990);
	});

	it("excludes non-numeric checks_timing_ms AND non-PostToolUse events from timings", () => {
		writeLog([
			sample({ checks_timing_ms: 100 }),
			sample({ checks_timing_ms: null }), // typeof !== number → excluded
			sample({ hook_event: "PreToolUse", checks_timing_ms: 999 }), // not PostToolUse → excluded from postTimings
			sample({ checks_timing_ms: 200 }),
		]);
		const p = computeLatencyReport(CWD).post_tool_use;
		expect(p.timing_count).toBe(2);
		expect(p.max).toBe(200);
	});

	it("sorts PostToolUse timings before applying nearest-rank percentiles", () => {
		// An already sorted fixture would let a removed/reversed sort survive.
		writeLog(
			[300, 100, 200].map((checks_timing_ms) => sample({ checks_timing_ms })),
		);
		expect(computeLatencyReport(CWD).post_tool_use).toEqual({
			timing_count: 3,
			p50: 200,
			p90: 300,
			p99: 300,
			max: 300,
		});
	});

	it("does not create a timed session for a non-numeric timing", () => {
		writeLog([
			sample({ session_id: "untimed", checks_timing_ms: null }),
			sample({ session_id: "timed", checks_timing_ms: 10 }),
		]);
		expect(computeLatencyReport(CWD).slowest_sessions).toEqual([
			{ session_id: "timed", max_timing_ms: 10, event_count: 1 },
		]);
	});

	it("leaves percentiles null and max null when no PostToolUse timing exists", () => {
		writeLog([sample({ hook_event: "PreToolUse", checks_timing_ms: 50 })]);
		const p = computeLatencyReport(CWD).post_tool_use;
		expect(p).toEqual({ timing_count: 0, p50: null, p90: null, p99: null, max: null });
	});
});

describe("computeLatencyReport — slowest sessions", () => {
	it("ranks sessions by max event timing and counts events", () => {
		writeLog([
			sample({ session_id: "fast", checks_timing_ms: 100 }),
			sample({ session_id: "slow", checks_timing_ms: 30000 }),
			sample({ session_id: "slow", checks_timing_ms: 12000 }), // second event same session
			sample({ session_id: "medium", checks_timing_ms: 5000 }),
		]);
		const sessions = computeLatencyReport(CWD).slowest_sessions;
		expect(sessions[0]).toEqual({ session_id: "slow", max_timing_ms: 30000, event_count: 2 });
		expect(sessions.map((s) => s.session_id)).toEqual(["slow", "medium", "fast"]);
	});

	it("ignores records with no session_id when building session stats", () => {
		writeLog([
			sample({ session_id: null, checks_timing_ms: 9999 }),
			sample({ session_id: "s1", checks_timing_ms: 10 }),
		]);
		const sessions = computeLatencyReport(CWD).slowest_sessions;
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.session_id).toBe("s1");
	});

	it("does not update max when a later event is smaller (the > guard)", () => {
		writeLog([
			sample({ session_id: "s1", checks_timing_ms: 500 }),
			sample({ session_id: "s1", checks_timing_ms: 100 }), // smaller → max stays 500
		]);
		expect(computeLatencyReport(CWD).slowest_sessions[0]?.max_timing_ms).toBe(500);
	});

	it("respects the top_sessions cap (slice)", () => {
		writeLog(
			Array.from({ length: 5 }, (_, i) =>
				sample({ session_id: `s${i}`, checks_timing_ms: (i + 1) * 1000 }),
			),
		);
		const sessions = computeLatencyReport(CWD, { top_sessions: 2 }).slowest_sessions;
		expect(sessions).toHaveLength(2);
		expect(sessions.map((s) => s.session_id)).toEqual(["s4", "s3"]);
	});
});

describe("computeLatencyReport — by_tool (compute_by_tool)", () => {
	it("omits by_tool entirely when compute_by_tool is falsy", () => {
		writeLog([sample()]);
		expect(computeLatencyReport(CWD).by_tool).toBeUndefined();
		expect(computeLatencyReport(CWD, { compute_by_tool: false }).by_tool).toBeUndefined();
	});

	it("prefers real per-tool timings from tool_breakdown when ANY record has it", () => {
		writeLog([
			sample({
				tool_breakdown: [
					{ tool: "tsc", ms: 800, finding_count: 0 },
					{ tool: "biome", ms: 200, finding_count: 0 },
				],
			}),
			sample({
				// This record has NO tool_breakdown — must be SKIPPED in breakdown mode
				// (the `if (!Array.isArray(r.tool_breakdown)) continue` branch).
				tool_breakdown: null,
				checks_ran: ["should_not_appear"],
			}),
			sample({
				tool_breakdown: [
					{ tool: "tsc", ms: 500, finding_count: 1 },
					// malformed entries that must be skipped:
					null,
					{ tool: "biome" }, // ms not a number
					{ ms: 5 }, // tool not a string
				],
			}),
		]);
		const report = computeLatencyReport(CWD, { compute_by_tool: true });
		expect(report.by_tool).toBeDefined();
		const tsc = report.by_tool?.find((t) => t.tool === "tsc");
		const biome = report.by_tool?.find((t) => t.tool === "biome");
		expect(tsc?.events).toBe(2);
		expect(tsc?.when_present.max).toBe(800);
		expect(tsc?.when_present.p50).toBe(500); // ceil(.5*2)-1=0 → idx 0 of [500,800]
		expect(biome?.events).toBe(1); // only the first record's valid biome entry
		expect(biome?.when_present.max).toBe(200);
		// The legacy checks_ran tool must NOT leak in when breakdown mode is active.
		expect(report.by_tool?.find((t) => t.tool === "should_not_appear")).toBeUndefined();
		// Ordering: most-frequent first (tsc=2 before biome=1).
		expect(report.by_tool?.map((t) => t.tool)).toEqual(["tsc", "biome"]);
	});

	it("falls back to checks_ran when-present approximation for legacy logs", () => {
		writeLog([
			sample({ checks_ran: ["typescript"], checks_timing_ms: 500, tool_breakdown: null }),
			sample({ checks_ran: ["typescript"], checks_timing_ms: 700, tool_breakdown: null }),
		]);
		const report = computeLatencyReport(CWD, { compute_by_tool: true });
		const tsc = report.by_tool?.find((t) => t.tool === "typescript");
		expect(tsc?.events).toBe(2);
		expect(tsc?.when_present.max).toBe(700);
	});

	it("uses legacy checks_ran when tool_breakdown is present but empty", () => {
		writeLog([
			sample({ tool_breakdown: [], checks_ran: ["legacy"], checks_timing_ms: 400 }),
			sample({ tool_breakdown: null, checks_ran: ["legacy"], checks_timing_ms: 600 }),
		]);
		const report = computeLatencyReport(CWD, { compute_by_tool: true });
		expect(report.by_tool).toEqual([
			expect.objectContaining({
				tool: "legacy",
				events: 2,
				when_present: expect.objectContaining({ max: 600 }),
			}),
		]);
	});

	it("orders tools by descending event count, regardless of insertion order", () => {
		writeLog([
			sample({ checks_ran: ["one"], checks_timing_ms: 100, tool_breakdown: null }),
			sample({ checks_ran: ["many"], checks_timing_ms: 200, tool_breakdown: null }),
			sample({ checks_ran: ["many"], checks_timing_ms: 300, tool_breakdown: null }),
		]);
		expect(computeLatencyReport(CWD, { compute_by_tool: true }).by_tool?.map((t) => t.tool)).toEqual([
			"many",
			"one",
		]);
	});

	it("handles legacy records with non-array checks_ran and non-string / null timing", () => {
		writeLog([
			sample({ checks_ran: null, tool_breakdown: null }), // not an array → continue
			sample({ checks_ran: ["typescript", 123], checks_timing_ms: null, tool_breakdown: null }),
		]);
		const report = computeLatencyReport(CWD, { compute_by_tool: true });
		const tsc = report.by_tool?.find((t) => t.tool === "typescript");
		// "typescript" bucket exists but with zero timings (checks_timing_ms null),
		// so events=0 and percentiles are null.
		expect(tsc?.events).toBe(0);
		expect(tsc?.when_present.p50).toBeNull();
		expect(tsc?.when_present.max).toBeNull();
		// The numeric 123 entry (typeof !== string) is skipped entirely.
		expect(report.by_tool?.some((t) => t.tool === "123")).toBe(false);
	});

	// test-contract: boundary — malformed checks_ran entries never become non-string tool rows in the public report
	it("excludes non-string checks_ran entries from the complete by-tool report shape", () => {
		writeLog([
			sample({ checks_ran: null, tool_breakdown: null }),
			sample({ checks_ran: ["typescript", 123], checks_timing_ms: null, tool_breakdown: null }),
		]);
		const report = computeLatencyReport(CWD, { compute_by_tool: true });
		expect(report.by_tool).toEqual([
			{
				tool: "typescript",
				events: 0,
				when_present: { timing_count: 0, p50: null, p90: null, p99: null, max: null },
			},
		]);
	});

	it("emits an empty by_tool array when no records carry tool info", () => {
		writeLog([sample({ checks_ran: [], tool_breakdown: null })]);
		const report = computeLatencyReport(CWD, { compute_by_tool: true });
		expect(report.by_tool).toEqual([]);
	});
});

// =========================================================================
// harnessLatencyCommand — Commander handler (output rendering)
// =========================================================================

describe("harnessLatencyCommand — JSON output", () => {
	it("prints the full report as pretty JSON and returns early", async () => {
		writeLog([sample({ checks_timing_ms: 100 }), sample({ checks_timing_ms: 300 })]);
		const out = await captureStdout(() => harnessLatencyCommand({ json: true }));
		const parsed = parseWire(JSON.parse(out), isCapturedLatencyReport, "test JSON value");
		expect(parsed.total_events).toBe(2);
		// percentile() nearest-rank: ceil(.5*2)-1=0 → idx 0 of sorted [100,300].
		expect(parsed.post_tool_use.p50).toBe(100);
		expect(parsed.post_tool_use.max).toBe(300);
		expect(parsed.by_hook_event.PostToolUse).toBe(2);
		// JSON path emits no human-readable header.
		expect(out).not.toContain("Harness latency report");
		// Pretty-printed (2-space indent) and newline-terminated.
		expect(out).toContain('\n  "total_events": 2');
		expect(out.endsWith("}\n")).toBe(true);
	});

	it("passes compute_by_tool through when --by-tool and --json combine", async () => {
		writeLog([
			sample({ tool_breakdown: [{ tool: "tsc", ms: 800, finding_count: 0 }] }),
		]);
		const out = await captureStdout(() =>
			harnessLatencyCommand({ json: true, byTool: true }),
		);
		const parsed = parseWire(JSON.parse(out), isCapturedLatencyReport, "test JSON value");
		expect(parsed.by_tool?.[0]?.tool).toBe("tsc");
		expect(parsed.by_tool?.[0]?.when_present.max).toBe(800);
	});

	it("does NOT compute by_tool when byTool is omitted (default-false branch)", async () => {
		writeLog([
			sample({ tool_breakdown: [{ tool: "tsc", ms: 800, finding_count: 0 }] }),
		]);
		const out = await captureStdout(() => harnessLatencyCommand({ json: true }));
		const parsed = parseWire(JSON.parse(out), isCapturedLatencyReport, "test JSON value");
		expect(parsed.by_tool).toBeUndefined();
	});
});

describe("harnessLatencyCommand — human-readable output", () => {
	// test-contract: public-api — the empty human report preserves the documented blank separators between sections
	it("renders the complete empty report with its section separators", async () => {
		const out = await captureStdout(() => harnessLatencyCommand());
		expect(out).toBe(
			[
				"Harness latency report",
				"──────────────────────",
				"  Total events:        0",
				"",
				"  By hook_event:",
				"",
				"  PostToolUse check timing:",
				"    samples              0",
				"    p50                  —",
				"    p90                  —",
				"    p99                  —",
				"    max                  —",
				"",
				"  Top slowest sessions (by max event timing):",
				"    (none)",
			].join("\n") + "\n",
		);
	});

	// test-contract: public-api — hook-event rows are ordered by descending event count, independent of log insertion order
	it("sorts hook-event rows by descending count", async () => {
		writeLog([
			sample({ hook_event: "PreToolUse" }),
			sample({ hook_event: "PostToolUse" }),
			sample({ hook_event: "PostToolUse" }),
		]);
		const out = await captureStdout(() => harnessLatencyCommand());
		const rows = out
			.split("\n")
			.filter((line) => /^    (?:PostToolUse|PreToolUse)/.test(line));
		expect(rows).toEqual(["    PostToolUse          2", "    PreToolUse           1"]);
	});

	it("renders header, total, hook-event breakdown, and PostToolUse percentiles", async () => {
		writeLog([
			sample({ hook_event: "PostToolUse", session_id: "alpha", checks_timing_ms: 100 }),
			sample({ hook_event: "PostToolUse", session_id: "beta", checks_timing_ms: 200 }),
			sample({ hook_event: "PreToolUse", session_id: "alpha", checks_timing_ms: 50 }),
		]);
		const out = await captureStdout(() => harnessLatencyCommand());
		expect(out).toContain("Harness latency report");
		expect(out).toContain("──────────────────────");
		expect(out).toContain("Total events:        3");
		// By hook_event sorted desc by count (PostToolUse 2 before PreToolUse 1).
		const postIdx = out.indexOf("PostToolUse");
		const preIdx = out.indexOf("PreToolUse");
		expect(postIdx).toBeGreaterThanOrEqual(0);
		expect(postIdx).toBeLessThan(preIdx);
		// Padded label width (padEnd 20) + count.
		expect(out).toMatch(/PostToolUse {10}2/);
		// PostToolUse percentile block with sub-1000ms "ms" formatting.
		expect(out).toContain("PostToolUse check timing:");
		expect(out).toContain("samples              2");
		// nearest-rank p50 of [100,200] is the first element (idx 0) → 100 ms.
		expect(out).toContain("p50                  100 ms");
		expect(out).toContain("max                  200 ms");
		expect(out.endsWith("\n")).toBe(true);
	});

	it("formats >=1000ms timings as seconds with 2 decimals", async () => {
		writeLog([sample({ session_id: "slowsess", checks_timing_ms: 30000 })]);
		const out = await captureStdout(() => harnessLatencyCommand());
		expect(out).toContain("p50                  30.00 s");
		expect(out).toContain("max                  30.00 s");
	});

	it("formats exactly 1000ms as seconds rather than milliseconds", async () => {
		writeLog([sample({ checks_timing_ms: 1000 })]);
		const out = await captureStdout(() => harnessLatencyCommand());
		expect(out).toContain("p50                  1.00 s");
		expect(out).not.toContain("p50                  1000 ms");
	});

	it("preserves the human report headings, separators, and no mutation marker", async () => {
		writeLog([
			sample({ hook_event: "PostToolUse", checks_timing_ms: 100 }),
			sample({ hook_event: "PreToolUse", checks_timing_ms: 50 }),
		]);
		const out = await captureStdout(() => harnessLatencyCommand());
		expect(out).toContain("\n\n  By hook_event:\n");
		expect(out).toContain("\n\n  PostToolUse check timing:\n");
		expect(out).toContain("\n\n  Top slowest sessions (by max event timing):\n");
		expect(out).not.toContain("Stryker was here");
	});

	it("renders the em-dash for null percentiles when there are no timings", async () => {
		// A single non-PostToolUse event → total_events 1 but zero post timings.
		writeLog([sample({ hook_event: "SessionStart", session_id: "x", checks_timing_ms: null })]);
		const out = await captureStdout(() => harnessLatencyCommand());
		expect(out).toContain("samples              0");
		expect(out).toContain("p50                  —");
		expect(out).toContain("p90                  —");
		expect(out).toContain("p99                  —");
		expect(out).toContain("max                  —");
	});

	it("prints the slowest-sessions table with truncated/padded ids and event counts", async () => {
		const longId = "session-0123456789-abcdefghij-klmnopqrst-uvwxyz"; // > 36 chars
		writeLog([
			sample({ session_id: longId, checks_timing_ms: 12000 }),
			sample({ session_id: longId, checks_timing_ms: 8000 }),
		]);
		const out = await captureStdout(() => harnessLatencyCommand());
		expect(out).toContain("Top slowest sessions (by max event timing):");
		// id sliced to 36 chars.
		const sliced = longId.slice(0, 36);
		expect(out).toContain(sliced);
		expect(out).not.toContain(longId); // full id is longer than the slice
		// timing rendered as seconds + event count suffix.
		expect(out).toMatch(new RegExp(`${sliced}.* {2}12\\.00 s {2}\\(2 events\\)`));
	});

	it("prints '(none)' when there are no sessions with timing", async () => {
		// total_events > 0 but no session_id+timing pair → empty slowest_sessions.
		writeLog([sample({ session_id: null, checks_timing_ms: null })]);
		const out = await captureStdout(() => harnessLatencyCommand());
		expect(out).toContain("Top slowest sessions (by max event timing):");
		expect(out).toContain("(none)");
	});

	it("renders the per-tool table when --by-tool yields rows", async () => {
		writeLog([
			sample({
				tool_breakdown: [
					{ tool: "tsc", ms: 800, finding_count: 0 },
					{ tool: "biome", ms: 1500, finding_count: 0 },
				],
			}),
			sample({
				tool_breakdown: [{ tool: "tsc", ms: 600, finding_count: 0 }],
			}),
		]);
		const out = await captureStdout(() => harnessLatencyCommand({ byTool: true }));
		expect(out).toContain("Per-tool stats:");
		// Header columns: tool padEnd(24)+" ", events padEnd(8)+" ", p50/p99
		// padEnd(10)+" ", max. So 21 / 3 / 8 / 8 spaces between labels.
		expect(out).toMatch(/tool {21}events {3}p50 {8}p99 {8}max/);
		// tsc row: tool padEnd(24)+join-space → 22 spaces after "tsc"; events
		// String padEnd(8)+join-space → 8 spaces after "2"; then the p50 value.
		expect(out).toMatch(/tsc {22}2 {8}600 ms {5}800 ms {5}800 ms/);
		expect(out).toMatch(/biome {20}1 {8}1\.50 s/);
		// Ordering: tsc (2 events) before biome (1 event).
		expect(out.indexOf("tsc")).toBeLessThan(out.indexOf("biome"));
	});

	it("omits the per-tool section when by_tool is an empty array", async () => {
		// --by-tool requested, but no records carry any tool info → [] → section
		// guarded out by `report.by_tool.length > 0`.
		writeLog([sample({ checks_ran: [], tool_breakdown: null })]);
		const out = await captureStdout(() => harnessLatencyCommand({ byTool: true }));
		expect(out).not.toContain("Per-tool stats:");
	});

	it("omits the per-tool section entirely when --by-tool is not passed", async () => {
		writeLog([
			sample({ tool_breakdown: [{ tool: "tsc", ms: 800, finding_count: 0 }] }),
		]);
		const out = await captureStdout(() => harnessLatencyCommand());
		expect(out).not.toContain("Per-tool stats:");
	});

	it("renders a coherent empty-log report (missing log → all zeros)", async () => {
		// No writeLog → existsSync false → empty report.
		const out = await captureStdout(() => harnessLatencyCommand());
		expect(out).toContain("Total events:        0");
		expect(out).toContain("samples              0");
		expect(out).toContain("(none)");
		expect(out).not.toContain("Per-tool stats:");
	});
});
