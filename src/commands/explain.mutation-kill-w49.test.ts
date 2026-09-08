// ===========================================
// explain command — wave pass1_w49 survivor-kill suite
// ===========================================
// Targets specific mutants that survived the existing explain.test.ts suite.
// Mocks the two data-layer boundaries exactly like explain.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "../lib/activity-utils.js";

vi.mock("../lib/api-client.js", () => ({
	getClient: vi.fn(),
}));

vi.mock("../lib/local-activity.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/local-activity.js")>();
	return {
		...actual,
		readLocalActivity: vi.fn(),
	};
});

import { getClient } from "../lib/api-client.js";
import { readLocalActivity } from "../lib/local-activity.js";
import { explainCommand } from "./explain.js";

const ANSI = /\x1b\[[0-9;]*m/g;
function strip(s: string): string {
	return s.replace(ANSI, "");
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function rawLog(): string {
	return String(logSpy.mock.calls[0]?.[0] ?? "");
}
function logged(): string {
	return strip(rawLog());
}
function errored(): string {
	return strip(String(errSpy.mock.calls[0]?.[0] ?? ""));
}

const mocks = {
	readLocalActivity: vi.mocked(readLocalActivity),
	getClient: vi.mocked(getClient),
};

const NOW = new Date("2099-06-01T12:00:00.000Z").getTime();
function isoAgo(ms: number): string {
	return new Date(NOW - ms).toISOString();
}
const MIN = 60_000;

function serverEvent(over: Partial<ActivityEvent> = {}): ActivityEvent {
	return {
		agent_name: "claude",
		event_type: "tool_use",
		tool_name: "Read",
		tool_input_summary: "src/index.ts",
		occurred_at: isoAgo(5 * MIN),
		...over,
	};
}

function fakeClient(callTool: () => Promise<unknown>): { callTool: () => Promise<unknown> } {
	return { callTool };
}
function serverResolves(value: unknown): void {
	// SAFETY: fakeClient's { callTool } shape matches the subset of
	// getClient()'s return type explainCommand actually calls.
	mocks.getClient.mockReturnValue(
		fakeClient(() => Promise.resolve(value)) as unknown as ReturnType<typeof getClient>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	process.exitCode = undefined;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	mocks.readLocalActivity.mockReturnValue([]);
	serverResolves({ events: [] });
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	process.exitCode = undefined;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------
// cutoff boundary: `>= cutoff` vs `> cutoff` (mutant 46351a246251736a)
// ---------------------------------------------------------------
describe("time-window cutoff is inclusive (>=)", () => {
	// test-contract: boundary — the cutoff filter uses `>=`, so an event
	// stamped exactly at the cutoff instant must still appear in the window.
	it("includes an event whose timestamp lands exactly on the cutoff instant", async () => {
		const durationMs = 60 * MIN; // default "1h"
		const cutoff = NOW - durationMs;
		serverResolves({
			events: [
				serverEvent({
					occurred_at: new Date(cutoff).toISOString(),
					tool_input_summary: "on-the-boundary.ts",
				}),
			],
		});

		await explainCommand({});

		// `>=` keeps it; `>` would drop it.
		expect(logged()).toContain("on-the-boundary.ts");
	});
});

// ---------------------------------------------------------------
// The detail-line `"" ` fallbacks at explainCommand's per-event build step
// (mutants b11a1c9732e3a6b0 / 02c6a7dd2c9fd237 / 971c5c0df2fc1168)
// ---------------------------------------------------------------
describe("full-mode detail line's empty-string fallbacks stay empty", () => {
	// test-contract: invariant — the detail line's `|| ""` fallbacks must
	// stay empty strings, not the literal text the arrays get built from.
	it("never leaks the mutation marker text when every fallback field is missing", async () => {
		serverResolves({
			events: [
				{
					agent_name: "claude",
					occurred_at: isoAgo(2 * MIN),
					// event_type, tool_name, tool_input_summary all absent.
				},
			],
		});

		await explainCommand({ full: true, json: true });

		const parsed = JSON.parse(rawLog());
		// Exact detail string: `${""} | ${""} | ${""}` -> " |  | ".
		expect(parsed.timeline[0].detail).toBe(" |  | ");
	});
});

// ---------------------------------------------------------------
// normal()'s `lines: string[] = []` (mutant 90c4554b7f0c5c07) and its two
// `lines.push("")` blank separators (7fa28f10ab19abf5 / 63fd085d18a8a4ee)
// ---------------------------------------------------------------
describe("normal-mode output never contains the mutation marker text", () => {
	// test-contract: invariant — normal()'s `lines` accumulator must start
	// empty; a seeded first element would shift the header and leak text.
	it("renders cleanly with an event + attribution present (exercises both blank pushes)", async () => {
		serverResolves({
			events: [
				serverEvent({
					attribution: { agent_lines: 8, human_lines: 2 },
					tool_input_summary: "clean.ts",
				}),
			],
		});

		await explainCommand({});

		const out = logged();
		expect(out).not.toContain("Stryker was here");
		// header() itself starts with "\n", so the first pushed line is "";
		// a bogus leading array element would push a non-empty line 0 instead.
		const rows = out.split("\n");
		expect(rows[0]).toBe("");
		expect(rows[1]).toContain("Timeline (last 1h)");
	});
});

// ---------------------------------------------------------------
// full()'s `lines: string[] = []` (mutant cdc69b2e2a4b418d)
// ---------------------------------------------------------------
describe("full-mode output never contains the mutation marker text", () => {
	// test-contract: invariant — full()'s `lines` accumulator must start
	// empty; a seeded first element would shift the header and leak text.
	it("keeps the header as the first rendered line", async () => {
		serverResolves({
			events: [serverEvent({ tool_input_summary: "clean-full.ts" })],
		});

		await explainCommand({ full: true });

		const out = logged();
		expect(out).not.toContain("Stryker was here");
		// header() itself starts with "\n", so the first pushed line is "";
		// a bogus leading array element would push a non-empty line 0 instead.
		const rows = out.split("\n");
		expect(rows[0]).toBe("");
		expect(rows[1]).toContain("Timeline — Full Detail (last 1h)");
	});
});

// ---------------------------------------------------------------
// `.join("\n")` in normal() (4b713db1e9ab905b / 45321ce57cbd31cf) and in
// full() (29c038cb5c2fe312 / 512a717127cd8df8) — replaced with `.join("")`
// would collapse every pushed line into one line with no separators.
// ---------------------------------------------------------------
describe("rendered output is newline-joined, not concatenated", () => {
	// test-contract: invariant — normal()'s `lines.join("\n")` must join
	// with a real newline, not concatenate every pushed line together.
	it("normal mode: the single console.log argument contains real newlines", async () => {
		serverResolves({
			events: [serverEvent({ tool_input_summary: "sep.ts" })],
		});

		await explainCommand({});

		// header + row + divider + count => at least 3 newline boundaries.
		const raw = rawLog();
		expect(raw).toContain("\n");
		expect(raw.split("\n").length).toBeGreaterThan(2);
	});

	// test-contract: invariant — full()'s `lines.join("\n")` must join with
	// a real newline, not concatenate every pushed line together.
	it("full mode: the single console.log argument contains real newlines", async () => {
		serverResolves({
			events: [
				serverEvent({ tool_input_summary: "sep-a.ts", occurred_at: isoAgo(2 * MIN) }),
				serverEvent({ tool_input_summary: "sep-b.ts", occurred_at: isoAgo(1 * MIN) }),
			],
		});

		await explainCommand({ full: true });

		const raw = rawLog();
		expect(raw).toContain("\n");
		expect(raw.split("\n").length).toBeGreaterThan(2);
	});
});

// ---------------------------------------------------------------
// `total > 0` guard on the attribution summary line
// (712b6610b47462c0 -> true, 6329ae37252ac701 -> total >= 0)
// ---------------------------------------------------------------
describe("attribution summary suppressed when total is exactly zero", () => {
	// test-contract: boundary — `total > 0` must exclude the boundary
	// value 0 itself, even when qualifying (nonzero) events exist.
	it("prints nothing when agent_lines and human_lines net to zero across events", async () => {
		// Both events pass the outer `attribution && (agent_lines||human_lines)`
		// filter (nonzero values), but the two agent_lines cancel to a net
		// total of 0 — the `total > 0` guard must still suppress the line.
		serverResolves({
			events: [
				serverEvent({
					attribution: { agent_lines: -5, human_lines: 0 },
					occurred_at: isoAgo(2 * MIN),
					tool_input_summary: "neg.ts",
				}),
				serverEvent({
					attribution: { agent_lines: 5, human_lines: 0 },
					occurred_at: isoAgo(1 * MIN),
					tool_input_summary: "pos.ts",
				}),
			],
		});

		await explainCommand({});

		const out = logged();
		// `true` or `>= 0` would print "Attribution: Agent wrote 0/0 lines (NaN%)".
		expect(out).not.toContain("Attribution:");
		expect(out).not.toContain("NaN");
	});
});

// ---------------------------------------------------------------
// normal()'s `if (event.detail)` mutated to unconditional `true`
// (mutant 125786ecdec25e06). In normal mode `event.detail` is always
// undefined (only `opts.full` populates it), so forcing the branch open
// calls `indent(c.dim(undefined), 24)` -> `undefined.split` throws,
// routing the whole command through the outer catch instead of rendering.
// ---------------------------------------------------------------
describe("normal mode never attempts to render a per-event detail block", () => {
	// test-contract: bug — normal mode's `event.detail` is always undefined;
	// forcing that branch open would throw inside indent()/c.dim() instead
	// of skipping the (non-existent) detail block.
	it("renders the event row cleanly with no thrown error", async () => {
		serverResolves({
			events: [serverEvent({ tool_input_summary: "no-detail-crash.ts" })],
		});

		await explainCommand({});

		expect(errored()).toBe("");
		expect(process.exitCode).toBeUndefined();
		expect(logged()).toContain("no-detail-crash.ts");
	});
});
