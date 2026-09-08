import { parseWire, wireNumber, wireObject } from "../lib/value-validation.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CWD = "/mutation-latency";
const LOG = `${CWD}/.interlinked/logs/latency.jsonl`;
let files = new Map<string, string>();

vi.mock("node:fs", () => ({
	existsSync: (path: string) => files.has(path),
	readFileSync: (path: string) => files.get(path) ?? "",
}));

import { computeLatencyReport, harnessLatencyCommand } from "./harness-latency.js";

const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	hook_event: "PostToolUse",
	session_id: "session-1",
	checks_ran: ["typescript"],
	checks_timing_ms: 10,
	...overrides,
});

function writeLines(...values: unknown[]): void {
	files.set(LOG, values.map((value) => JSON.stringify(value)).join("\n"));
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	});
	try {
		await fn();
	} finally {
		write.mockRestore();
	}
	return chunks.join("");
}

beforeEach(() => {
	files = new Map();
	vi.spyOn(process, "cwd").mockReturnValue(CWD);
});

afterEach(() => vi.restoreAllMocks());

describe("untrusted latency record fields", () => {
	// test-contract: security — wrong primitive types are normalized so aggregation never treats them as valid labels or session ids
	it("normalizes wrong types while preserving null optionals and valid labels", () => {
		writeLines(
			record({ hook_event: null, session_id: null }),
			record({ hook_event: 42, session_id: 42 }),
			record({ hook_event: "PreToolUse", session_id: "s2" }),
		);
		const report = computeLatencyReport(CWD);
		expect(report.total_events).toBe(3);
		expect(report.by_hook_event).toEqual({ unknown: 2, PreToolUse: 1 });
		expect(report.slowest_sessions.map((entry) => entry.session_id)).toEqual(["s2"]);
	});

	// test-contract: boundary — valid string and null optionals remain distinct public aggregation cases
	it("keeps string hook and session values while null values use their documented fallbacks", () => {
		writeLines(
			record({ hook_event: "PreToolUse", session_id: "named", checks_timing_ms: 20 }),
			record({ hook_event: null, session_id: null, checks_timing_ms: 30 }),
		);
		const report = computeLatencyReport(CWD);
		expect(report.by_hook_event).toEqual({ PreToolUse: 1, unknown: 1 });
		expect(report.slowest_sessions).toEqual([
			{ session_id: "named", max_timing_ms: 20, event_count: 1 },
		]);
	});
});

describe("record boundaries and percentile edges", () => {
	// test-contract: boundary — blank, malformed, and primitive JSONL lines are ignored without changing valid event counts
	it("skips blank, malformed, and non-object lines", () => {
		files.set(LOG, `\n  \nnot-json\nnull\n[1,2]\n${JSON.stringify(record({ checks_timing_ms: 7 }))}\n`);
		const report = computeLatencyReport(CWD);
		expect(report.total_events).toBe(1);
		expect(report.post_tool_use).toEqual({ timing_count: 1, p50: 7, p90: 7, p99: 7, max: 7 });
	});

	// test-contract: invariant — nearest-rank percentiles use ceil(q*n)-1 and preserve a zero-record null boundary
	it("uses exact nearest-rank indices and nulls all percentiles for zero timings", () => {
		writeLines(...[10, 20, 30, 40].map((checks_timing_ms) => record({ checks_timing_ms })));
		expect(computeLatencyReport(CWD).post_tool_use).toEqual({
			timing_count: 4,
			p50: 20,
			p90: 40,
			p99: 40,
			max: 40,
		});
		writeLines(record({ hook_event: "PreToolUse", checks_timing_ms: null }));
		expect(computeLatencyReport(CWD).post_tool_use).toEqual({
			timing_count: 0,
			p50: null,
			p90: null,
			p99: null,
			max: null,
		});
	});

	// test-contract: invariant — equal timings do not replace the established session maximum
	it("retains the first equal maximum and counts both events", () => {
		writeLines(
			record({ session_id: "same", checks_timing_ms: 50 }),
			record({ session_id: "same", checks_timing_ms: 50 }),
		);
		expect(computeLatencyReport(CWD).slowest_sessions).toEqual([
			{ session_id: "same", max_timing_ms: 50, event_count: 2 },
		]);
	});
});

describe("per-tool public report", () => {
	// test-contract: boundary — a tool row with no numeric timings has empty percentiles and a null max
	it("emits an empty timing shape for a present tool with no timing", () => {
		writeLines(record({ checks_ran: ["typescript"], checks_timing_ms: null, tool_breakdown: null }));
		expect(computeLatencyReport(CWD, { compute_by_tool: true }).by_tool).toEqual([
			{
				tool: "typescript",
				events: 0,
				when_present: { timing_count: 0, p50: null, p90: null, p99: null, max: null },
			},
		]);
	});

	// test-contract: invariant — real breakdown mode ignores legacy records and malformed breakdown entries
	it("uses only valid real breakdown timings once breakdown data is present", () => {
		writeLines(
			record({ tool_breakdown: [{ tool: "tsc", ms: 12, finding_count: 0 }] }),
			record({ tool_breakdown: [{ tool: "tsc", ms: 12, finding_count: 0 }, null, { tool: "bad" }] }),
			record({ tool_breakdown: null, checks_ran: ["legacy"], checks_timing_ms: 999 }),
		);
		const report = computeLatencyReport(CWD, { compute_by_tool: true });
		expect(report.by_tool).toEqual([
			{
				tool: "tsc",
				events: 2,
				when_present: { timing_count: 2, p50: 12, p90: 12, p99: 12, max: 12 },
			},
		]);
	});
});

describe("harnessLatencyCommand output", () => {
	// test-contract: public-api — JSON mode emits the complete report and never leaks mutation-marker text
	it("renders JSON output with stable report fields", async () => {
		writeLines(record({ checks_timing_ms: 25 }));
		const output = await captureStdout(() => harnessLatencyCommand({ json: true }));
		const parsed = parseWire(JSON.parse(output), wireObject({ "total_events": wireNumber, "post_tool_use": wireObject({ "max": wireNumber }) }), "test JSON value");
		expect(parsed.total_events).toBe(1);
		expect(parsed.post_tool_use.max).toBe(25);
		expect(output).not.toContain("Stryker was here!");
	});

	// test-contract: public-api — by-tool human output includes rows only when requested and data exists
	it("renders the requested per-tool table", async () => {
		writeLines(record({ tool_breakdown: [{ tool: "tsc", ms: 25, finding_count: 0 }] }));
		const output = await captureStdout(() => harnessLatencyCommand({ byTool: true }));
		expect(output).toContain("Per-tool stats:");
		expect(output).toContain("tsc");
	});
});
