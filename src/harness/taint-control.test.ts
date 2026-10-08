import { describe, expect, it } from "vitest";
import { createFreshSession } from "./session-state-mutators.js";
import {
	buildTaintView,
	clearSessionTaint,
	finiteOrNull,
	isTaintControlRequest,
	networkBlockedAt,
	OPERATOR_CLEAR_FILE,
	operatorClearSource,
	RECENT_SOURCE_COUNT,
	TAINT_CONTROL_EVENT,
	unknownSessionReport,
	viewFromSession,
} from "./taint-control.js";
import { DEFAULT_TAINT_CONFIG } from "./taint-tracker.js";
import type { HarnessEvent, SessionTrajectory, TaintSource } from "./types.js";

const CONFIG = DEFAULT_TAINT_CONFIG;

function session(id = "s-1"): SessionTrajectory {
	return createFreshSession(
		{
			hook_event: "SessionStart",
			session_id: id,
			agent_source: "claude",
			timestamp: "2026-10-05T00:00:00.000Z",
			// SAFETY: createFreshSession reads only these four fields; the rest of
			// HarnessEvent is optional tool context no taint view consults.
		} as HarnessEvent,
		id,
	);
}

function source(over: Partial<TaintSource> = {}): TaintSource {
	return { file: "f", level: "Public", at_step: 0, provenance: "local_read", ...over };
}

describe("taint-control primitives — positive (must hold)", () => {
	it("P1: Infinity serializes as null, a finite limit stays itself", () => {
		expect(finiteOrNull(Number.POSITIVE_INFINITY)).toBeNull();
		expect(finiteOrNull(10_000)).toBe(10_000);
	});

	it("P2: network is blocked at and above the configured level", () => {
		expect(networkBlockedAt("Confidential", "Confidential")).toBe(true);
		expect(networkBlockedAt("HighlyConfidential", "Confidential")).toBe(true);
	});

	it("P3: the control event name and the clear marker path are stable", () => {
		expect(TAINT_CONTROL_EVENT).toBe("TaintControl");
		expect(operatorClearSource("because", 7)).toEqual({
			file: OPERATOR_CLEAR_FILE,
			level: "Public",
			at_step: 7,
			provenance: "local_read",
			detail: "because",
		});
	});

	it("P4: both control requests validate", () => {
		expect(isTaintControlRequest({ operation: "status" })).toBe(true);
		expect(isTaintControlRequest({ operation: "status", session_id: "s" })).toBe(true);
		expect(isTaintControlRequest({ operation: "clear", session_id: "s", reason: "r" })).toBe(true);
	});
});

describe("taint-control primitives — negative (must not hold)", () => {
	it("N1: network is not blocked below the configured level", () => {
		expect(networkBlockedAt("Internal", "Confidential")).toBe(false);
		expect(networkBlockedAt("Public", "Confidential")).toBe(false);
	});

	it("N2: a clear without a session id or reason is rejected", () => {
		expect(isTaintControlRequest({ operation: "clear", session_id: "s" })).toBe(false);
		expect(isTaintControlRequest({ operation: "clear", reason: "r" })).toBe(false);
		expect(isTaintControlRequest({ operation: "erase", session_id: "s" })).toBe(false);
		expect(isTaintControlRequest("status")).toBe(false);
	});
});

describe("buildTaintView — positive (must fire)", () => {
	it("P1: names the old-format setter as inferred and reports the block state", () => {
		// The shape of the real c698b9a9 snapshot: one unflagged Confidential
		// source among many Public ones.
		const legacySources = [
			source({ file: "<bash:curl x>", level: "Public", at_step: 1 }),
			source({ file: "<command-output>", level: "Confidential", at_step: 769 }),
			source({ file: "<command-output>", level: "Confidential", at_step: 900 }),
		];
		const view = buildTaintView({
			session_id: "s-1",
			agent_name: "worker",
			sensitivity_level: "Confidential",
			step_limit: 10_000,
			sources: legacySources,
			config: CONFIG,
			origin: "live-snapshot",
		});
		expect(view.set_by).toEqual({
			file: "<command-output>",
			level: "Confidential",
			at_step: 769,
			detail: null,
			inferred: true,
		});
		expect(view.network_blocked).toBe(true);
		expect(view.source_count).toBe(3);
		expect(view.origin).toBe("live-snapshot");
	});

	it("P2: prefers the escalated source and marks it proven", () => {
		const flaggedSources = [
			source({ file: "early", level: "Confidential", at_step: 1 }),
			source({ file: ".env", level: "Confidential", at_step: 5, escalated: true, detail: "d" }),
		];
		const view = buildTaintView({
			session_id: "s-1",
			agent_name: null,
			sensitivity_level: "Confidential",
			step_limit: null,
			sources: flaggedSources,
			config: CONFIG,
			origin: "daemon-memory",
		});
		expect(view.set_by).toMatchObject({ file: ".env", inferred: false, detail: "d" });
	});

	it("P3: a live session renders with its own level, limit and trailing sources", () => {
		const s = session();
		s.sensitivity_level = "Confidential";
		s.step_limit = 10_000;
		for (let i = 0; i < RECENT_SOURCE_COUNT + 3; i++) {
			s.taint_sources.push(source({ file: `f${i}`, level: "Public", at_step: i }));
		}
		const view = viewFromSession(s, CONFIG);
		expect(view.recent_sources).toHaveLength(RECENT_SOURCE_COUNT);
		expect(view.recent_sources[0]?.file).toBe("f3");
		expect(view.step_limit).toBe(10_000);
		expect(view.origin).toBe("daemon-memory");
	});
});

describe("buildTaintView — negative (must not fire)", () => {
	it("N1: no source at the current level yields no setter", () => {
		const view = buildTaintView({
			session_id: "s-1",
			agent_name: null,
			sensitivity_level: "Confidential",
			step_limit: null,
			sources: [source({ file: "cfg", level: "Internal", at_step: 1, escalated: true })],
			config: CONFIG,
			origin: "daemon-memory",
		});
		expect(view.set_by).toBeNull();
	});

	it("N2: a Public session is not reported as network-blocked", () => {
		const view = viewFromSession(session(), CONFIG);
		expect(view.network_blocked).toBe(false);
		expect(view.step_limit).toBeNull();
		expect(unknownSessionReport("zz").ok).toBe(false);
	});
});

describe("clearSessionTaint — positive (must fire)", () => {
	it("P1: lowers the level, resets the step limit and keeps the history", () => {
		const s = session();
		s.sensitivity_level = "Confidential";
		s.step_limit = 10_000;
		s.tool_call_count = 4242;
		s.taint_sources.push(source({ file: "<command-output>", level: "Confidential", at_step: 769 }));
		const outcome = clearSessionTaint(s, CONFIG, "false positive: youtube public key");

		expect(s.sensitivity_level).toBe("Public");
		expect(s.step_limit).toBe(Number.POSITIVE_INFINITY);
		expect(s.taint_sources).toHaveLength(2);
		expect(s.taint_sources[0]?.file).toBe("<command-output>");
		expect(s.taint_sources[1]).toEqual({
			file: OPERATOR_CLEAR_FILE,
			level: "Public",
			at_step: 4242,
			provenance: "local_read",
			detail: "false positive: youtube public key",
		});
		expect(outcome).toMatchObject({
			previous_level: "Confidential",
			previous_step_limit: 10_000,
			new_level: "Public",
			new_step_limit: null,
			set_by: "<command-output>",
			set_by_inferred: true,
		});
	});
});

describe("clearSessionTaint — negative (must not fire)", () => {
	it("N1: never truncates or rewrites earlier sources", () => {
		const s = session();
		s.sensitivity_level = "Internal";
		s.taint_sources.push(source({ file: "a" }), source({ file: "b" }));
		clearSessionTaint(s, CONFIG, "r");
		expect(s.taint_sources.map((x) => x.file)).toEqual(["a", "b", OPERATOR_CLEAR_FILE]);
	});
});
