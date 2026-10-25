// ===========================================
// Trajectory State Machine — mutation-hardening tests
// ===========================================
//
// Each test pins a documented behavior of trajectory.ts (module header lines
// 1-25, interface docs lines 33-84) that the original trajectory.test.ts left
// unpinned. Written from mutation survivors (Campaign A, harness__trajectory).

import { describe, expect, it } from "vitest";
import { createTrajectoryDetector, type TrajectoryEvent } from "./trajectory.js";

const T0 = 1_700_000_000_000;

function ev(overrides: Partial<TrajectoryEvent> & { ts_ms: number }): TrajectoryEvent {
	return {
		hook_event: "PreToolUse",
		tool_name: "Bash",
		tool_input: { command: "echo hi" },
		...overrides,
	};
}

function bash(ts_ms: number, command: string, hook_event: TrajectoryEvent["hook_event"] = "PreToolUse") {
	return ev({ ts_ms, hook_event, tool_input: { command } });
}

function read(ts_ms: number, hook_event: TrajectoryEvent["hook_event"] = "PreToolUse") {
	return ev({ ts_ms, hook_event, tool_name: "Read", tool_input: { file_path: "/a.ts" } });
}

function feed(detector: ReturnType<typeof createTrajectoryDetector>, events: TrajectoryEvent[]) {
	return events.map((e) => detector.observe(e));
}

function lastOf<T>(items: T[]): T {
	const item = items[items.length - 1];
	if (item === undefined) throw new Error("empty");
	return item;
}

const hasLoop = (fs: { pattern: string }[]) => fs.some((f) => f.pattern === "tool_loop");

describe("trajectory ring buffer size option (header: default 50, lower bound 16)", () => {
	it("clamps a too-small bufferSize up to the 16-event lower bound", () => {
		const detector = createTrajectoryDetector({ bufferSize: 2 });
		const events = Array.from({ length: 6 }, (_, i) => bash(T0 + i * 1_000, "ls /tmp"));
		expect(hasLoop(lastOf(feed(detector, events)))).toBe(true);
	});

	it("keeps 50 events by default so a repeat spread over 50 events still counts", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [bash(T0, "ls /tmp")];
		for (let i = 1; i < 45; i++) events.push(bash(T0 + i * 100, `other${i}`));
		for (let i = 0; i < 5; i++) events.push(bash(T0 + 5_000 + i * 100, "ls /tmp"));
		expect(events).toHaveLength(50);
		expect(hasLoop(lastOf(feed(detector, events)))).toBe(true);
	});

	it("retains exactly bufferSize events: the oldest of 17 is evicted, no more", () => {
		const detector = createTrajectoryDetector({ bufferSize: 16 });
		const events: TrajectoryEvent[] = [bash(T0, "noise-first")];
		for (let i = 0; i < 5; i++) events.push(bash(T0 + 1_000 + i * 1_000, "ls /tmp"));
		for (let i = 0; i < 10; i++) events.push(bash(T0 + 10_000 + i * 1_000, `noise${i}`));
		events.push(bash(T0 + 25_000, "ls /tmp"));
		expect(events).toHaveLength(17);
		expect(hasLoop(lastOf(feed(detector, events)))).toBe(true);
	});

	it("evicts events past the cap so evicted repeats no longer count", () => {
		const detector = createTrajectoryDetector({ bufferSize: 16 });
		const events: TrajectoryEvent[] = [bash(T0, "ls /tmp")];
		for (let i = 0; i < 11; i++) events.push(bash(T0 + 1_000 + i * 1_000, `noise${i}`));
		for (let i = 0; i < 5; i++) events.push(bash(T0 + 20_000 + i * 1_000, "ls /tmp"));
		expect(events).toHaveLength(17);
		expect(hasLoop(lastOf(feed(detector, events)))).toBe(false);
	});
});

describe("trajectory cooldownMs option (interface docs: 0 fires on every observe)", () => {
	it("cooldownMs 0 lets tool_loop fire again on the very next observe", () => {
		const detector = createTrajectoryDetector({ cooldownMs: 0 });
		const events = Array.from({ length: 7 }, (_, i) => bash(T0 + i * 1_000, "ls /tmp"));
		const results = feed(detector, events);
		expect(hasLoop(results[5] ?? [])).toBe(true);
		expect(hasLoop(results[6] ?? [])).toBe(true);
	});

	it("a repeat fires again once exactly cooldownMs has elapsed (not before)", () => {
		const detector = createTrajectoryDetector({ cooldownMs: 10_000 });
		const events = Array.from({ length: 8 }, (_, i) => bash(T0 + i * 5_000, "ls /tmp"));
		const results = feed(detector, events);
		expect(hasLoop(results[5] ?? [])).toBe(true); // t=25s fires
		expect(hasLoop(results[6] ?? [])).toBe(false); // t=30s inside cooldown
		expect(hasLoop(results[7] ?? [])).toBe(true); // t=35s: 10s elapsed -> allowed
	});

	it("reset() clears the cooldown so a pattern can fire again immediately", () => {
		const detector = createTrajectoryDetector();
		const round = (base: number) => Array.from({ length: 6 }, (_, i) => bash(base + i * 5_000, "ls /tmp"));
		expect(hasLoop(lastOf(feed(detector, round(T0))))).toBe(true);
		detector.reset();
		expect(hasLoop(lastOf(feed(detector, round(T0 + 30_000))))).toBe(true);
	});

	it("a destructive_sequence finding is throttled inside its 30s window", () => {
		const detector = createTrajectoryDetector();
		const results = feed(detector, [
			bash(T0, "rm -rf build"),
			bash(T0 + 1_000, "mkdir build"),
			bash(T0 + 2_000, "rm -rf build"),
			bash(T0 + 3_000, "mkdir build"),
			bash(T0 + 4_000, "rm -rf build"),
		]);
		expect(results[2]?.some((f) => f.pattern === "destructive_sequence")).toBe(true);
		expect(results[4]?.some((f) => f.pattern === "destructive_sequence")).toBe(false);
	});

	it("an unbackedoff_retry finding is throttled inside its window", () => {
		const detector = createTrajectoryDetector();
		const results = feed(
			detector,
			Array.from({ length: 4 }, (_, i) => bash(T0 + i * 1_000, "npm test", "PostToolUseFailure")),
		);
		expect(results[2]?.some((f) => f.pattern === "unbackedoff_retry")).toBe(true);
		expect(results[3]?.some((f) => f.pattern === "unbackedoff_retry")).toBe(false);
	});
});

describe("trajectory.tool_loop window and state-change semantics (header: >5 in 60s)", () => {
	it("fires when 6 identical calls span 40s (inside the 60s window)", () => {
		const detector = createTrajectoryDetector();
		const events = Array.from({ length: 6 }, (_, i) => bash(T0 + i * 8_000, "ls /tmp"));
		expect(hasLoop(lastOf(feed(detector, events)))).toBe(true);
	});

	it("counts a call that sits exactly on the 60s window edge", () => {
		const detector = createTrajectoryDetector();
		const events = [0, 12_000, 24_000, 36_000, 48_000, 60_000].map((d) => bash(T0 + d, "ls /tmp"));
		expect(hasLoop(lastOf(feed(detector, events)))).toBe(true);
	});

	it("counts only PreToolUse calls, not their PostToolUse echoes", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 3; i++) {
			events.push(read(T0 + i * 10_000));
			events.push(read(T0 + i * 10_000 + 500, "PostToolUse"));
		}
		expect(hasLoop(lastOf(feed(detector, events)))).toBe(false);
	});

	it("a PreToolUse Edit with no PostToolUse is not an observable state change", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 3; i++) events.push(read(T0 + i * 5_000));
		events.push(ev({ ts_ms: T0 + 16_000, tool_name: "Edit", tool_input: { file_path: "/a.ts" } }));
		for (let i = 0; i < 3; i++) events.push(read(T0 + 17_000 + i * 5_000));
		expect(hasLoop(lastOf(feed(detector, events)))).toBe(true);
	});

	it("a successful Write between reads is an observable state change", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 3; i++) events.push(read(T0 + i * 5_000));
		events.push(
			ev({ ts_ms: T0 + 16_000, hook_event: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/a.ts" } }),
		);
		for (let i = 0; i < 3; i++) events.push(read(T0 + 17_000 + i * 5_000));
		expect(hasLoop(lastOf(feed(detector, events)))).toBe(false);
	});

	it("a successful MultiEdit between reads is an observable state change", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 3; i++) events.push(read(T0 + i * 5_000));
		events.push(
			ev({
				ts_ms: T0 + 16_000,
				hook_event: "PostToolUse",
				tool_name: "MultiEdit",
				tool_input: { file_path: "/a.ts" },
			}),
		);
		for (let i = 0; i < 3; i++) events.push(read(T0 + 17_000 + i * 5_000));
		expect(hasLoop(lastOf(feed(detector, events)))).toBe(false);
	});

	it("a state change exactly on the window edge still resets the batch", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			read(T0),
			ev({ ts_ms: T0, hook_event: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/a.ts" } }),
			read(T0 + 12_000),
			read(T0 + 24_000),
			read(T0 + 36_000),
			read(T0 + 48_000),
			read(T0 + 60_000),
		];
		// Only 5 reads follow the Edit; the read at T0 predates it.
		expect(hasLoop(lastOf(feed(detector, events)))).toBe(false);
	});
});

describe("trajectory.tool_loop finding shape (interface docs)", () => {
	function loopFinding() {
		const detector = createTrajectoryDetector();
		const events = Array.from({ length: 6 }, (_, i) => bash(T0 + i * 5_000, "ls /tmp"));
		const f = lastOf(feed(detector, events)).find((x) => x.pattern === "tool_loop");
		if (!f) throw new Error("no loop finding");
		return f;
	}

	it("carries exactly the up-to-3 most recent evidence snippets", () => {
		expect(loopFinding().evidence).toHaveLength(3);
	});

	it("reports a non-zero window_ms for the time-windowed pattern", () => {
		expect(loopFinding().window_ms).toBeGreaterThan(0);
	});

	it("reports the call count and the 60s window in the message", () => {
		expect(loopFinding().message).toMatch(/\b6\b[\s\S]*\b60s\b/);
	});
});

describe("trajectory.destructive_sequence preconditions (header: rm -> mkdir/touch -> rm)", () => {
	function fires(events: TrajectoryEvent[]): boolean {
		const detector = createTrajectoryDetector();
		return lastOf(feed(detector, events)).some((f) => f.pattern === "destructive_sequence");
	}

	it("does not fire when the final rm is only a PostToolUse event", () => {
		expect(
			fires([bash(T0, "rm -rf build"), bash(T0 + 1_000, "mkdir build"), bash(T0 + 2_000, "rm -rf build", "PostToolUse")]),
		).toBe(false);
	});

	it("does not fire when the final event is not a Bash call", () => {
		expect(
			fires([
				bash(T0, "rm -rf build"),
				bash(T0 + 1_000, "mkdir build"),
				ev({ ts_ms: T0 + 2_000, tool_name: "Read", tool_input: { command: "rm -rf build" } }),
			]),
		).toBe(false);
	});

	it("does not count a non-Bash event as the recreate step", () => {
		expect(
			fires([
				bash(T0, "rm -rf build"),
				ev({ ts_ms: T0 + 1_000, tool_name: "Read", tool_input: { command: "mkdir build" } }),
				bash(T0 + 2_000, "rm -rf build"),
			]),
		).toBe(false);
	});

	it("treats rmdir as destructive", () => {
		expect(fires([bash(T0, "rmdir build"), bash(T0 + 1_000, "mkdir build"), bash(T0 + 2_000, "rmdir build")])).toBe(true);
	});

	it("does not fire when the recreate targets a different path", () => {
		expect(fires([bash(T0, "rm -rf a"), bash(T0 + 1_000, "mkdir b"), bash(T0 + 2_000, "rm -rf a")])).toBe(false);
	});

	it("does not fire when the final rm targets a different path than the cycle", () => {
		expect(fires([bash(T0, "rm -rf a"), bash(T0 + 1_000, "mkdir a"), bash(T0 + 2_000, "rm -rf b")])).toBe(false);
	});

	it("treats 'build/' and 'build' as the same path when the earlier commands carry the slash", () => {
		expect(fires([bash(T0, "rm -rf build/"), bash(T0 + 1_000, "mkdir build/"), bash(T0 + 2_000, "rm -rf build")])).toBe(true);
	});

	it("treats 'build/' and 'build' as the same path when the final rm carries the slash", () => {
		expect(fires([bash(T0, "rm -rf build"), bash(T0 + 1_000, "mkdir build"), bash(T0 + 2_000, "rm -rf build/")])).toBe(true);
	});

	it("ignores surrounding quotes on the final rm target", () => {
		expect(fires([bash(T0, "rm -rf build"), bash(T0 + 1_000, "mkdir build"), bash(T0 + 2_000, 'rm -rf "build"')])).toBe(true);
	});

	it("reports the earlier rm, the recreate and the final rm as three evidence snippets and a non-zero window", () => {
		const detector = createTrajectoryDetector();
		const results = feed(detector, [
			bash(T0, "rm -rf build"),
			bash(T0 + 1_000, "mkdir build"),
			bash(T0 + 2_000, "rm -rf build"),
		]);
		const f = lastOf(results).find((x) => x.pattern === "destructive_sequence");
		expect(f?.evidence).toHaveLength(3);
		expect(f?.window_ms).toBeGreaterThan(0);
	});
});

describe("trajectory.unbackedoff_retry details (header: 3+ failures, no sleep/wait)", () => {
	function failures(n: number, command = "npm test"): TrajectoryEvent[] {
		return Array.from({ length: n }, (_, i) => bash(T0 + i * 1_000, command, "PostToolUseFailure"));
	}
	const retry = (fs: { pattern: string }[]) => fs.some((f) => f.pattern === "unbackedoff_retry");

	it("does not fire on only two consecutive failures", () => {
		const detector = createTrajectoryDetector();
		expect(retry(lastOf(feed(detector, failures(2))))).toBe(false);
	});

	it("a wait between attempts counts as backoff, like sleep", () => {
		const detector = createTrajectoryDetector();
		const events = [
			bash(T0, "npm test", "PostToolUseFailure"),
			bash(T0 + 500, "wait 5"),
			bash(T0 + 6_000, "npm test", "PostToolUseFailure"),
			bash(T0 + 7_000, "npm test", "PostToolUseFailure"),
			bash(T0 + 8_000, "npm test", "PostToolUseFailure"),
		];
		expect(retry(lastOf(feed(detector, events)))).toBe(false);
	});

	it("reports the full retry count but at most 3 evidence snippets and window_ms 0", () => {
		const detector = createTrajectoryDetector({ cooldownMs: 0 });
		const f = lastOf(feed(detector, failures(5))).find((x) => x.pattern === "unbackedoff_retry");
		expect(f?.message).toMatch(/5 retries/);
		expect(f?.evidence).toHaveLength(3);
		expect(f?.window_ms).toBe(0);
	});

	it("keeps an evidence snippet of exactly 80 characters whole", () => {
		const detector = createTrajectoryDetector();
		const cmd = "x".repeat(74); // "Bash: " + 74 chars = 80
		const f = lastOf(feed(detector, failures(3, cmd))).find((x) => x.pattern === "unbackedoff_retry");
		expect(f?.evidence[0]).toBe(`"Bash: ${cmd}"`);
	});

	it("bounds a long evidence snippet to 80 characters including the ellipsis", () => {
		const detector = createTrajectoryDetector();
		const f = lastOf(feed(detector, failures(3, "y".repeat(200)))).find((x) => x.pattern === "unbackedoff_retry");
		const inner = (f?.evidence[0] ?? "").slice(1, -1);
		expect(inner.length).toBeLessThanOrEqual(80);
		expect(inner.endsWith("…")).toBe(true);
	});

	it("keeps a command of exactly 80 characters whole in the message", () => {
		const detector = createTrajectoryDetector();
		const cmd = "z".repeat(80);
		const f = lastOf(feed(detector, failures(3, cmd))).find((x) => x.pattern === "unbackedoff_retry");
		expect(f?.message).toContain(cmd);
	});
});

describe("trajectory.silent_stall shape (interface docs: window_ms is how far back it looked)", () => {
	it("reports a non-zero window_ms for the stall gap", () => {
		const detector = createTrajectoryDetector();
		const results = feed(detector, [bash(T0, "ls"), bash(T0 + 11 * 60_000, "ls")]);
		const f = lastOf(results).find((x) => x.pattern === "silent_stall");
		expect(f?.window_ms).toBeGreaterThan(0);
	});
});
