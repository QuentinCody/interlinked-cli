import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
import { describe, expect, it } from "vitest";
import {
	type AutoCoordinationConfig,
	type CoordinationResponse,
	createAutoCoordinationState,
	DEFAULT_AUTO_COORDINATION_CONFIG,
	injectCoordinationWarnings,
	shouldCoordinate,
} from "./auto-coordinate.js";
import type { HarnessDecision, SessionTrajectory } from "./types.js";

const cfg = (over: Partial<AutoCoordinationConfig> = {}): AutoCoordinationConfig => ({
	...DEFAULT_AUTO_COORDINATION_CONFIG,
	enabled: true,
	...over,
});

const session = (toolCallCount: number): SessionTrajectory =>
	({ ...completeSessionFixture(), ...{ tool_call_count: toolCallCount } });

const emptyResponse = (over: Partial<CoordinationResponse> = {}): CoordinationResponse => ({
	heartbeat_recorded: true,
	unread: { total: 0, urgent: [] },
	task_changes: [],
	intent: null,
	server_time: "2026-06-05T00:00:00Z",
	...over,
});

describe("createAutoCoordinationState", () => {
	it("starts disabled-free with zero counters", () => {
		const s = createAutoCoordinationState();
		expect(s.lastCoordAt).toBe(0);
		expect(s.consecutiveMisses).toBe(0);
		expect(s.totalCheckins).toBe(0);
		expect(s.disabled).toBe(false);
		expect(typeof s.lastCoordTs).toBe("number");
	});
});

describe("shouldCoordinate", () => {
	const state = (over: Partial<ReturnType<typeof createAutoCoordinationState>> = {}) => ({
		...createAutoCoordinationState(),
		...over,
	});

	it("is false when disabled in config", () => {
		expect(shouldCoordinate(session(100), state(), cfg({ enabled: false }), "Bash")).toBe(false);
	});

	it("is false when the state is disabled (too many misses)", () => {
		expect(shouldCoordinate(session(100), state({ disabled: true }), cfg(), "Bash")).toBe(false);
	});

	it("is false for skip_tools", () => {
		expect(shouldCoordinate(session(100), state(), cfg(), "Read")).toBe(false);
	});

	it("is true when the max interval is exceeded (forced check)", () => {
		// lastCoordTs far in the past → msSince >= max_interval_ms.
		expect(
			shouldCoordinate(session(1), state({ lastCoordTs: 0 }), cfg(), "Bash"),
		).toBe(true);
	});

	it("is false when under the min interval (burst suppression)", () => {
		// Fresh check just happened → msSince < min_interval_ms.
		expect(
			shouldCoordinate(session(100), state({ lastCoordTs: Date.now() }), cfg(), "Bash"),
		).toBe(false);
	});

	it("respects the step interval once past the min interval", () => {
		const past = Date.now() - 60_000; // > min (30s), < max (120s)
		expect(
			shouldCoordinate(session(20), state({ lastCoordTs: past, lastCoordAt: 5 }), cfg(), "Bash"),
		).toBe(true); // 15 steps >= check_interval 10
		expect(
			shouldCoordinate(session(12), state({ lastCoordTs: past, lastCoordAt: 5 }), cfg(), "Bash"),
		).toBe(false); // 7 steps < 10
	});
});

describe("injectCoordinationWarnings", () => {
	it("adds a line per urgent message", () => {
		const d: HarnessDecision = { decision: "allow" };
		injectCoordinationWarnings(
			d,
			emptyResponse({
				unread: {
					total: 1,
					urgent: [
						{ id: 1, subject: "Deploy", importance: "high", sender_name: "Ana", preview: "go" },
					],
				},
			}),
		);
		expect(d.warnings).toHaveLength(1);
		expect(d.warnings?.[0]).toContain("HIGH from Ana");
	});

	it("nudges when total unread exceeds 5", () => {
		const d: HarnessDecision = { decision: "allow" };
		injectCoordinationWarnings(d, emptyResponse({ unread: { total: 9, urgent: [] } }));
		expect(d.warnings?.[0]).toContain("9 total unread");
	});

	it("flags reassigned vs cancelled/blocked task changes distinctly", () => {
		const d: HarnessDecision = { decision: "allow" };
		injectCoordinationWarnings(
			d,
			emptyResponse({
				task_changes: [
					{ id: 1, title: "A", status: "x", change_type: "reassigned", current_assignee: "Bo" },
					{ id: 2, title: "B", status: "x", change_type: "blocked" },
				],
			}),
		);
		expect(d.warnings?.some((w) => w.includes('"A" was reassigned to Bo'))).toBe(true);
		expect(d.warnings?.some((w) => w.includes('"B" is now blocked'))).toBe(true);
	});

	it("leaves warnings untouched when there is nothing to report", () => {
		const d: HarnessDecision = { decision: "allow" };
		injectCoordinationWarnings(d, emptyResponse());
		expect(d.warnings).toBeUndefined();
	});
});
