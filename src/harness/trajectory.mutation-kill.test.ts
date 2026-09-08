// Survivor-kill tests for src/harness/trajectory.ts, sourced from
// scratch/fleet-r3/trajectory-mutants-full.json (137 survivors from the
// per-file mutation manifest, generation 725).
//
// trajectory.ts exports exactly one runtime function, createTrajectoryDetector
// (plus types) — every internal detector and helper is reachable only via
// detector.observe(event), so every case here drives a full event sequence
// through a fresh detector and asserts on the resulting findings. Each test
// names the specific mutant(s) it kills; the exact textual mutation and the
// empirical confirmation that these assertions actually distinguish
// pristine from mutant both live in
// scratch/fleet-r3/src_harness_trajectory.ts-shadow-verify.mts (companion
// scratch script, not part of the shipped suite).
//
// 36 further survivors were traced to structurally-redundant guards (a check
// duplicated by a later line, a buffer-hole/NaN/no-op-splice state that's
// unreachable via the typed public API) and confirmed equivalent by a
// 400-input-per-mutant fuzz pass with zero divergence
// (scratch/fleet-r3/src_harness_trajectory.ts-equivalence-fuzz.mts) — those
// are NOT re-asserted here since no observable behavior distinguishes them.

import { describe, expect, it } from "vitest";
import { createTrajectoryDetector, type TrajectoryEvent, type TrajectoryFinding } from "./trajectory.js";

const T0 = 1_700_000_000_000;

function ev(overrides: Partial<TrajectoryEvent> & { ts_ms: number }): TrajectoryEvent {
	return {
		hook_event: "PreToolUse",
		tool_name: "Bash",
		tool_input: { command: "echo hi" },
		...overrides,
	};
}

function observeAll(
	detector: ReturnType<typeof createTrajectoryDetector>,
	events: TrajectoryEvent[],
): TrajectoryFinding[][] {
	return events.map((e) => detector.observe(e));
}

function firstOfPattern(traces: TrajectoryFinding[][], pattern: TrajectoryFinding["pattern"]): TrajectoryFinding | undefined {
	for (const t of traces) {
		const f = t.find((x) => x.pattern === pattern);
		if (f) return f;
	}
	return undefined;
}

function countOfPattern(traces: TrajectoryFinding[][], pattern: TrajectoryFinding["pattern"]): number {
	return traces.reduce((n, t) => n + t.filter((x) => x.pattern === pattern).length, 0);
}

// ==========================================================================
// STATE_CHANGE_TOOLS membership (module scope)
// ==========================================================================
describe("STATE_CHANGE_TOOLS membership — each listed tool actually breaks the loop count", () => {
	function stateChangeSplits(tool: string): TrajectoryFinding[][] {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 3; i++) events.push(ev({ ts_ms: T0 + i * 5_000, tool_name: "Read", tool_input: { file_path: "/a.ts" } }));
		events.push(ev({ ts_ms: T0 + 16_000, tool_name: tool, tool_input: { file_path: "/a.ts" } }));
		events.push(
			ev({ ts_ms: T0 + 16_500, hook_event: "PostToolUse", tool_name: tool, tool_input: { file_path: "/a.ts" }, succeeded: true }),
		);
		for (let i = 0; i < 3; i++)
			events.push(ev({ ts_ms: T0 + 17_000 + i * 5_000, tool_name: "Read", tool_input: { file_path: "/a.ts" } }));
		return observeAll(detector, events);
	}

	// Kills: "Write" -> "" stripped from STATE_CHANGE_TOOLS.
	it('P: a "Write" between reads splits the run, so it never fires', () => {
		expect(firstOfPattern(stateChangeSplits("Write"), "tool_loop")).toBeUndefined();
	});
	// Kills: "MultiEdit" -> "" stripped from STATE_CHANGE_TOOLS.
	it('P: a "MultiEdit" between reads splits the run, so it never fires', () => {
		expect(firstOfPattern(stateChangeSplits("MultiEdit"), "tool_loop")).toBeUndefined();
	});
	// Kills: "NotebookEdit" -> "" stripped from STATE_CHANGE_TOOLS.
	it('P: a "NotebookEdit" between reads splits the run, so it never fires', () => {
		expect(firstOfPattern(stateChangeSplits("NotebookEdit"), "tool_loop")).toBeUndefined();
	});
	// Kills: "apply_patch" -> "" stripped from STATE_CHANGE_TOOLS.
	it('P: an "apply_patch" between reads splits the run, so it never fires', () => {
		expect(firstOfPattern(stateChangeSplits("apply_patch"), "tool_loop")).toBeUndefined();
	});
});

// ==========================================================================
// DESTRUCTIVE_RX / RECREATE_RX boundary mutants (module scope)
// ==========================================================================
describe("DESTRUCTIVE_RX / RECREATE_RX regex boundaries", () => {
	function cycle(events: TrajectoryEvent[]): TrajectoryFinding[][] {
		return observeAll(createTrajectoryDetector(), events);
	}

	// Kills: DESTRUCTIVE_RX's leading `^` dropped — an "rm" mid-string (not
	// command-initial) would incorrectly match.
	it("N: a trailing command with 'rm' mid-string (not command-initial) never starts a cycle", () => {
		const traces = cycle([
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "x rm build" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeUndefined();
	});
	// Kills: DESTRUCTIVE_RX's leading `\s*` -> `\S*`.
	it("P: leading whitespace before 'rm' still matches DESTRUCTIVE_RX", () => {
		const traces = cycle([
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: " rm build" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeDefined();
	});
	// Kills: DESTRUCTIVE_RX's `sudo\s+` -> `sudo\s` (exactly one space).
	it("P: 'sudo ' (single space) before rm still matches DESTRUCTIVE_RX", () => {
		const traces = cycle([
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "sudo rm build" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeDefined();
	});
	// Kills: DESTRUCTIVE_RX's `sudo\s+` -> `sudo\S+`.
	it("P: 'sudo' followed by two spaces before rm still matches (sudo\\s+ allows 1-or-more)", () => {
		const traces = cycle([
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "sudo  rm build" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeDefined();
	});
	// Kills: RECREATE_RX's leading `^` dropped.
	it("N: a recreate with 'mkdir' mid-string (not command-initial) never completes a cycle", () => {
		const traces = cycle([
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "x mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf build" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeUndefined();
	});
	// Kills: RECREATE_RX's leading `\s*` -> `\S*`.
	it("P: leading whitespace before 'mkdir' still matches RECREATE_RX", () => {
		const traces = cycle([
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: " mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf build" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeDefined();
	});
	// Kills: RECREATE_RX's `sudo\s+` -> `sudo\s`.
	it("P: 'sudo ' (single space) before mkdir still matches RECREATE_RX", () => {
		const traces = cycle([
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "sudo mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf build" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeDefined();
	});
	// Kills: RECREATE_RX's `sudo\s+` -> `sudo\S+`.
	it("P: 'sudo' followed by two spaces before mkdir still matches", () => {
		const traces = cycle([
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "sudo  mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf build" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeDefined();
	});
	// Kills: RECREATE_RX's `cat\s*>` -> `cat\s>` (exactly one space required).
	it("P: 'cat>file' with zero spaces before '>' still matches (cat\\s*> allows zero)", () => {
		const traces = cycle([
			ev({ ts_ms: T0, tool_input: { command: "rm -f build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "cat> build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -f build" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeDefined();
	});
	// Kills: RECREATE_RX's `cat\s*>` -> `cat\S*>` (no whitespace allowed).
	it("P: 'cat > file' with a space before '>' still matches (cat\\s*> allows any count)", () => {
		const traces = cycle([
			ev({ ts_ms: T0, tool_input: { command: "rm -f build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "cat > build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -f build" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeDefined();
	});
});

// ==========================================================================
// createTrajectoryDetector: bufferSize resolution
// ==========================================================================
describe("createTrajectoryDetector — bufferSize resolution", () => {
	// Kills: Math.max(MIN_BUFFER_SIZE, ...) -> Math.min(...). A requested
	// bufferSize below the 16-event floor must still be RAISED to 16, not
	// shrunk to the smaller request.
	it("P: a bufferSize request below the 16-event floor is raised to 16, not honored as-is", () => {
		const detector = createTrajectoryDetector({ bufferSize: 5 });
		const events: TrajectoryEvent[] = [
			...Array.from({ length: 3 }, (_, i) => ev({ ts_ms: T0 + i * 100, tool_input: { command: `drown${i}` } })),
			...Array.from({ length: 6 }, (_, i) => ev({ ts_ms: T0 + 300 + i * 100, tool_input: { command: "ls /tmp" } })),
		];
		const traces = observeAll(detector, events);
		// With the floor properly enforced (16), all 3+6=9 events fit in the
		// buffer and the 6 identical "ls /tmp" calls are still counted
		// together, exceeding the >5 threshold.
		const finding = firstOfPattern(traces, "tool_loop");
		expect(finding).toBeDefined();
		// Kills `TOOL_LOOP_WINDOW_MS / 1000` -> `* 1000` in the message
		// template: the reported window would read "60000000s" instead of
		// "60s". `firstOfPattern`/`toBeDefined()` alone can't see this — the
		// finding still fires either way, only its message text changes.
		expect(finding?.message).toContain("in 60s)");
	});
	// Kills: `opts?.bufferSize ?? DEFAULT_BUFFER_SIZE` -> `opts?.bufferSize &&
	// DEFAULT_BUFFER_SIZE`. When bufferSize is unset, `undefined && DEFAULT`
	// is undefined (not DEFAULT), so Math.max(16, undefined) is NaN and the
	// `buffer.length > bufferSize` trim check can never be true again — the
	// ring buffer stops evicting entirely.
	it("P: with no bufferSize override, the ring buffer still caps growth at the 50-event default", () => {
		const detector = createTrajectoryDetector({ cooldownMs: 0 });
		const events = Array.from({ length: 53 }, (_, i) => ev({ ts_ms: T0 + i * 200, tool_input: { command: "ls /tmp" } }));
		const traces = observeAll(detector, events);
		// The reported repeat count in the message must never exceed 50 (the
		// default cap) — search every fired tool_loop message for a count
		// bigger than the cap, which would only appear if eviction had
		// silently stopped working.
		const overCap = traces
			.flat()
			.filter((f) => f.pattern === "tool_loop")
			.some((f) => /\((\d+) identical calls/.exec(f.message)?.[1] !== undefined && Number(/\((\d+) identical calls/.exec(f.message)![1]) > 50);
		expect(overCap).toBe(false);
		// Kills `-EVIDENCE_MAX_ITEMS` -> `+EVIDENCE_MAX_ITEMS` in the
		// UNRELATED evidence-array slice (`entry.events.slice(-EVIDENCE_MAX_ITEMS)`
		// inside detectToolLoop, not the ring-buffer trim checked above):
		// `slice(-3)` keeps the LAST 3 entries; `slice(+3)` keeps everything
		// FROM index 3 onward, which grows past 3 once the repeat count
		// itself exceeds 3 (it does here, up to 50+) instead of staying capped.
		const evidenceLengths = traces
			.flat()
			.filter((f) => f.pattern === "tool_loop")
			.map((f) => f.evidence.length);
		expect(evidenceLengths.every((n) => n <= 3)).toBe(true);
	});
});

// ==========================================================================
// createTrajectoryDetector.fired — cooldown bookkeeping
// ==========================================================================
describe("createTrajectoryDetector.fired — cooldown arithmetic", () => {
	// Kills: `cooldown <= 0` -> `false`. With cooldownMs:0 the cooldown must
	// be fully disabled — including across an out-of-order (earlier)
	// timestamp, where a naive `nowMs - last < cooldown` fallback would read
	// a negative delta as "still in cooldown".
	it("P: cooldownMs:0 always allows refiring, even across an out-of-order timestamp", () => {
		const detector = createTrajectoryDetector({ cooldownMs: 0 });
		const events: TrajectoryEvent[] = [
			...Array.from({ length: 6 }, (_, i) => ev({ ts_ms: T0 + i * 1_000, tool_input: { command: "ls /tmp" } })),
			ev({ ts_ms: T0 + 2_000, tool_input: { command: "ls /tmp" } }),
		];
		const traces = observeAll(detector, events);
		expect(countOfPattern(traces, "tool_loop")).toBeGreaterThanOrEqual(2);
	});
	// Kills: `nowMs - last < cooldown` -> `true` (permanent suppression).
	// After the real 60s cooldown window fully elapses, tool_loop must be
	// able to fire again on a fresh run.
	it("P: tool_loop refires on a fresh run once the 60s cooldown has fully elapsed", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			...Array.from({ length: 6 }, (_, i) => ev({ ts_ms: T0 + i, tool_input: { command: "ls /tmp" } })),
			...Array.from({ length: 6 }, (_, i) => ev({ ts_ms: T0 + 60_001 + i, tool_input: { command: "pwd" } })),
		];
		const traces = observeAll(detector, events);
		expect(countOfPattern(traces, "tool_loop")).toBe(2);
	});
	// Kills: `nowMs - last < cooldown` -> `nowMs - last <= cooldown`
	// (off-by-one). At EXACTLY the cooldown boundary, the strict `<` reads
	// the cooldown as expired (allows refiring one tick earlier than `<=`
	// would).
	it("P: boundary — refires at exactly nowMs - last === cooldown (60000ms)", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			...Array.from({ length: 6 }, () => ev({ ts_ms: T0, tool_input: { command: "ls /tmp" } })),
			...Array.from({ length: 6 }, (_, i) => ev({ ts_ms: T0 + 59_995 + i, tool_input: { command: "ls /tmp" } })),
		];
		const traces = observeAll(detector, events);
		expect(countOfPattern(traces, "tool_loop")).toBe(2);
		// Kills `e.ts_ms < cutoff` -> `e.ts_ms <= cutoff` in detectToolLoop's
		// COUNTING loop (the second of two textual occurrences — the first is
		// the state-change scan above it): the two batches share the SAME
		// command key on purpose, so at the final event the boundary-exact
		// first-batch entries (ts_ms === cutoff) are still in-window under `<`
		// but wrongly excluded under `<=`. The firing COUNT stays 2 either
		// way (checked above); only the last firing's reported repeat count
		// (12 vs 6) exposes the divergence.
		const finalFinding = traces
			.flat()
			.filter((f) => f.pattern === "tool_loop")
			.at(-1);
		expect(finalFinding?.message).toContain("(12 identical calls");
	});
});

// ==========================================================================
// createTrajectoryDetector.observe — per-pattern cooldown keys
// ==========================================================================
describe("createTrajectoryDetector.observe — cooldown bookkeeping keys", () => {
	// Kills: "silent_stall" -> "" at either the fired() or markFired() call
	// site. If the two calls use different keys, the cooldown never
	// actually engages, so a second stall within the SAME window fires
	// again instead of being suppressed.
	it("P: silent_stall's cooldown suppresses a second stall report within an overridden window", () => {
		const detector = createTrajectoryDetector({ cooldownMs: 20 * 60_000 });
		const events: TrajectoryEvent[] = [
			ev({ ts_ms: T0, tool_input: { command: "ls" } }),
			ev({ ts_ms: T0 + 11 * 60_000, tool_input: { command: "ls" } }),
			ev({ ts_ms: T0 + 11 * 60_000 + 30_000, tool_input: { command: "ls" } }),
			ev({ ts_ms: T0 + 22 * 60_000 + 30_000, tool_input: { command: "ls" } }),
		];
		const traces = observeAll(detector, events);
		expect(countOfPattern(traces, "silent_stall")).toBe(1);
		// Kills `"warning"` -> `""` and `[quoteEvidence(summarizeInput(prev))]`
		// -> `[]` in detectSilentStall's own returned finding: neither mutant
		// changes HOW MANY times silent_stall fires (the count check above
		// can't see them), only the finding's own severity/evidence content.
		const finding = firstOfPattern(traces, "silent_stall");
		expect(finding?.severity).toBe("warning");
		expect(finding?.evidence.length).toBe(1);
	});
	// Kills: "destructive_sequence" -> "" at either call site.
	it("P: destructive_sequence's cooldown suppresses a second identical cycle report within 30s", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 15_000, tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 20_000, tool_input: { command: "rm -rf build" } }),
		];
		const traces = observeAll(detector, events);
		expect(countOfPattern(traces, "destructive_sequence")).toBe(1);
	});
	// Kills: "unbackedoff_retry" -> "" at either call site.
	it("P: unbackedoff_retry's cooldown suppresses a second identical-run report within 60s", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = Array.from({ length: 4 }, (_, i) =>
			ev({ ts_ms: T0 + i * 1_000, hook_event: "PostToolUseFailure", tool_input: { command: "npm test" }, succeeded: false }),
		);
		const traces = observeAll(detector, events);
		expect(countOfPattern(traces, "unbackedoff_retry")).toBe(1);
		// Kills `"warning"` -> `""` (detectUnbackedoffRetry's own finding) and
		// the evidence-map arrow `(e) => quoteEvidence(summarizeInput(e))` ->
		// `() => undefined` (every evidence slot becomes `undefined`/`null`):
		// neither mutant changes HOW MANY times unbackedoff_retry fires, only
		// the finding's own severity/evidence content.
		const finding = firstOfPattern(traces, "unbackedoff_retry");
		expect(finding?.severity).toBe("warning");
		expect(finding?.evidence.every((e) => typeof e === "string" && e.length > 0)).toBe(true);
	});
});

// ==========================================================================
// createTrajectoryDetector.push — ring buffer capacity
// ==========================================================================
describe("createTrajectoryDetector.push — ring buffer capacity", () => {
	// Kills the "never trim" family (`buffer.length > bufferSize` -> false /
	// -> `<=`, the arithmetic `- bufferSize` -> `+ bufferSize` overflow
	// splice, and the emptied splice block statement): with cooldownMs:0,
	// more than 50 identical events must never report a repeat count above
	// 50.
	it("P: the ring buffer caps repeat-count growth at bufferSize=50 forever", () => {
		const detector = createTrajectoryDetector({ cooldownMs: 0 });
		const events = Array.from({ length: 55 }, (_, i) => ev({ ts_ms: T0 + i * 200, tool_input: { command: "ls /tmp" } }));
		const traces = observeAll(detector, events);
		const counts = traces
			.flat()
			.filter((f) => f.pattern === "tool_loop")
			.map((f) => Number(/\((\d+) identical calls/.exec(f.message)?.[1] ?? "0"));
		expect(Math.max(...counts)).toBeLessThanOrEqual(50);
		// Kills `buffer.length - bufferSize` -> `buffer.length + bufferSize`:
		// splice's deleteCount clamps to buffer.length, so the wrong-sign
		// arithmetic wipes the buffer to EMPTY every time the cap is exceeded
		// (deleteCount is always > buffer.length) instead of trimming to
		// exactly 50. A wiped-then-regrown buffer's repeat count never climbs
		// back past 50 either, so the max-count check above can't see this —
		// it stops firing tool_loop AT ALL past event 51, where a correctly
		// capped buffer keeps reporting the loop on every subsequent event.
		expect(traces.at(-1)?.some((f) => f.pattern === "tool_loop")).toBe(true);
	});
});

// ==========================================================================
// createTrajectoryDetector.reset
// ==========================================================================
describe("createTrajectoryDetector.reset", () => {
	// Kills the emptied reset() body ({ buffer.length = 0; lastFireMs.clear();
	// } -> {}). 3 identical reads (below the >5 threshold) never fire
	// tool_loop, so lastFireMs never records it — isolating this test from
	// cooldown interference. If reset() is a no-op, the pre-reset 3 events
	// are still in the buffer when 3 more of the SAME command land
	// post-reset, completing a 6-count loop a properly-emptied buffer never
	// would.
	it("P: reset() actually empties the ring buffer, not just a no-op", () => {
		const detector = createTrajectoryDetector();
		observeAll(detector, [
			ev({ ts_ms: T0, tool_input: { command: "ls /tmp" } }),
			ev({ ts_ms: T0 + 1_000, tool_input: { command: "ls /tmp" } }),
			ev({ ts_ms: T0 + 2_000, tool_input: { command: "ls /tmp" } }),
		]);
		detector.reset();
		const traces = observeAll(detector, [
			ev({ ts_ms: T0 + 3_000, tool_input: { command: "ls /tmp" } }),
			ev({ ts_ms: T0 + 4_000, tool_input: { command: "ls /tmp" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "ls /tmp" } }),
		]);
		expect(firstOfPattern(traces, "tool_loop")).toBeUndefined();
	});
});

// ==========================================================================
// detectUnbackedoffRetry
// ==========================================================================
describe("detectUnbackedoffRetry", () => {
	// Kills `e.tool_name !== "Bash"` -> false (the walk-back loop's OWN
	// check). A non-Bash event interposed one slot back, carrying a
	// fabricated matching command AND PostToolUseFailure, must still break
	// the count.
	it("N: a non-Bash event interposed in the walk-back breaks the consecutive count", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, hook_event: "PostToolUseFailure", tool_name: "Read", tool_input: { command: "npm test" }, succeeded: false }),
			ev({ ts_ms: T0 + 100, hook_event: "PostToolUseFailure", tool_input: { command: "npm test" }, succeeded: false }),
			ev({ ts_ms: T0 + 200, hook_event: "PostToolUseFailure", tool_input: { command: "npm test" }, succeeded: false }),
		]);
		expect(firstOfPattern(traces, "unbackedoff_retry")).toBeUndefined();
	});
	// Kills SLEEP_RX.test -> false AND the emptied {return null;} block: a
	// real sleep preceding 3 genuine consecutive failures must void the
	// whole finding (backoff WAS observed further back in the walk).
	it("N: a sleep earlier in the walk voids an otherwise-qualifying run", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_input: { command: "sleep 5" } }),
			ev({ ts_ms: T0 + 100, hook_event: "PostToolUseFailure", tool_input: { command: "npm test" }, succeeded: false }),
			ev({ ts_ms: T0 + 200, hook_event: "PostToolUseFailure", tool_input: { command: "npm test" }, succeeded: false }),
			ev({ ts_ms: T0 + 300, hook_event: "PostToolUseFailure", tool_input: { command: "npm test" }, succeeded: false }),
		]);
		expect(firstOfPattern(traces, "unbackedoff_retry")).toBeUndefined();
	});
	// Kills SLEEP_RX.test -> true: a non-sleep, non-matching command earlier
	// in the walk must NOT be mistaken for a backoff.
	it("P: a non-sleep command earlier in the walk is not mistaken for a backoff", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_input: { command: "ls -la" } }),
			ev({ ts_ms: T0 + 100, hook_event: "PostToolUseFailure", tool_input: { command: "npm test" }, succeeded: false }),
			ev({ ts_ms: T0 + 200, hook_event: "PostToolUseFailure", tool_input: { command: "npm test" }, succeeded: false }),
			ev({ ts_ms: T0 + 300, hook_event: "PostToolUseFailure", tool_input: { command: "npm test" }, succeeded: false }),
		]);
		expect(firstOfPattern(traces, "unbackedoff_retry")).toBeDefined();
	});
	// Kills `evidenceEvents.slice(0, EVIDENCE_MAX_ITEMS)` -> unsliced.
	// cooldownMs:0 lets events 4 and 5 also emit findings (not suppressed by
	// the default 60s cooldown), so the evidence array at consecutive=5 is
	// actually observed and must still cap at 3.
	it("P: evidence is capped at EVIDENCE_MAX_ITEMS(3) even with 5 consecutive failures", () => {
		const detector = createTrajectoryDetector({ cooldownMs: 0 });
		const events = Array.from({ length: 5 }, (_, i) =>
			ev({ ts_ms: T0 + i * 100, hook_event: "PostToolUseFailure", tool_input: { command: "npm test" }, succeeded: false }),
		);
		const traces = observeAll(detector, events);
		const allEvidenceLengths = traces.flat().filter((f) => f.pattern === "unbackedoff_retry").map((f) => f.evidence.length);
		expect(allEvidenceLengths.every((n) => n <= 3)).toBe(true);
		expect(allEvidenceLengths.length).toBeGreaterThan(0);
	});
});

// ==========================================================================
// extractFirstPath
// ==========================================================================
describe("extractFirstPath", () => {
	function cycle(events: TrajectoryEvent[]): TrajectoryFinding[][] {
		return observeAll(createTrajectoryDetector(), events);
	}
	// Kills the 2 remaining "" -> "Stryker was here!" fallback mutants
	// (`!rest` and the loop-exhausted trailing return). Both fixtures make
	// EVERY command (earlier-rm, recreate, trailing) hit the identical
	// fallback path: under pristine all three targets are "" — blocked by
	// findDestructiveCyclePrefix's `target && pathsOverlap(...)` truthy
	// gate, so no cycle forms; if the fallback becomes a non-empty string,
	// all three become identical non-empty values that trivially overlap.
	it("N: three bare (trailing-whitespace-only) commands never form a cycle", () => {
		const traces = cycle([
			ev({ ts_ms: T0, tool_input: { command: "rm   " } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir   " } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm   " } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeUndefined();
	});
	it("N: three flags-only commands never form a cycle", () => {
		const traces = cycle([
			ev({ ts_ms: T0, tool_input: { command: "rm -rf -v" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir -p -v" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf -v" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeUndefined();
	});
	// Kills the quote-strip `.replace(..., "")` argument: a fully
	// single-quoted token must strip to the bare path, matching the
	// unquoted form elsewhere.
	it("P: a fully single-quoted token strips to the bare path, matching the unquoted form", () => {
		const traces = cycle([
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf 'build'" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeDefined();
	});
	// Kills the leading-anchor drop (`/^['"]|['"]$/g` -> `/['"]|['"]$/g`) AND
	// the trailing-anchor drop (-> `/^['"]|['"]/g`): a MID-token quote
	// (neither leading nor trailing) must survive un-stripped.
	it("N: a quote embedded mid-token is not stripped, so it never overlaps a plain path", () => {
		const traces = cycle([
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf bu'ild" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeUndefined();
	});
});

// ==========================================================================
// normalizeInput (tool_loop dedup key)
// ==========================================================================
describe("normalizeInput", () => {
	// Kills `!input`->""->"Stryker..." AND `fields=[]`->`["Stryker..."]`
	// together: mixing tool_input=undefined (hits the early "!input" return)
	// with tool_input={} (falls through the field loop to an empty join) —
	// both must normalize to the identical "" key.
	it("P: undefined and {} tool_input both normalize to the identical empty dedup key", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			...Array.from({ length: 3 }, (_, i) => ev({ ts_ms: T0 + i * 1_000, tool_input: undefined })),
			...Array.from({ length: 3 }, (_, i) => ev({ ts_ms: T0 + 3_000 + i * 1_000, tool_input: {} })),
		]);
		expect(firstOfPattern(traces, "tool_loop")).toBeDefined();
	});
	function distinctFieldNeverMerges(field: string) {
		const events = Array.from({ length: 6 }, (_, i) => ev({ ts_ms: T0 + i * 1_000, tool_input: { [field]: `/v${i}.ts` } }));
		return observeAll(createTrajectoryDetector(), events);
	}
	// Kills "file_path"/"path"/"url"/"pattern"/"old_string" -> "" (each
	// strips that field name from the loop, so distinct values would
	// falsely merge into one dedup key).
	it("N: 6 different file_path values never merge into one dedup key", () => {
		expect(firstOfPattern(distinctFieldNeverMerges("file_path"), "tool_loop")).toBeUndefined();
	});
	it("N: 6 different path values never merge into one dedup key", () => {
		expect(firstOfPattern(distinctFieldNeverMerges("path"), "tool_loop")).toBeUndefined();
	});
	it("N: 6 different url values never merge into one dedup key", () => {
		expect(firstOfPattern(distinctFieldNeverMerges("url"), "tool_loop")).toBeUndefined();
	});
	it("N: 6 different pattern values never merge into one dedup key", () => {
		expect(firstOfPattern(distinctFieldNeverMerges("pattern"), "tool_loop")).toBeUndefined();
	});
	it("N: 6 different old_string values never merge into one dedup key", () => {
		expect(firstOfPattern(distinctFieldNeverMerges("old_string"), "tool_loop")).toBeUndefined();
	});
	// Kills `v.trim()` -> `v`: trailing whitespace on a field value must not
	// create a spurious distinct dedup key.
	it("P: trailing whitespace on a field value is trimmed before keying", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			...Array.from({ length: 3 }, (_, i) => ev({ ts_ms: T0 + i * 1_000, tool_input: { command: "rm build" } })),
			...Array.from({ length: 3 }, (_, i) => ev({ ts_ms: T0 + 3_000 + i * 1_000, tool_input: { command: "rm build " } })),
		]);
		expect(firstOfPattern(traces, "tool_loop")).toBeDefined();
	});
	// Kills `"|"` -> `""`: a two-field key and a one-field key whose
	// no-separator concatenation happens to collide must stay distinct.
	it("N: the field separator prevents a two-field key colliding with a one-field key", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			...Array.from({ length: 3 }, (_, i) => ev({ ts_ms: T0 + i * 1_000, tool_input: { command: "a", file_path: "b" } })),
			...Array.from({ length: 3 }, (_, i) => ev({ ts_ms: T0 + 3_000 + i * 1_000, tool_input: { command: "afile_path=b" } })),
		]);
		expect(firstOfPattern(traces, "tool_loop")).toBeUndefined();
	});
});

// ==========================================================================
// pathsOverlap
// ==========================================================================
describe("pathsOverlap", () => {
	// Kills BOTH `/\/+$/` -> `/\/$/` occurrences. A single trailing slash
	// can't distinguish "one or more" from "exactly one"; two consecutive
	// slashes can: pristine strips both (greedy); an unquantified pattern
	// only strips the last one, leaving a mismatch.
	it("P: two trailing slashes on the scanned event's target still overlap (a-side strip)", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build//" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir build//" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf build" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeDefined();
	});
	it("P: two trailing slashes on the trailing event's target still overlap (b-side strip)", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf build//" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeDefined();
	});
	// Kills `na === nb` -> `true` and the RECREATE branch's
	// `target && pathsOverlap(...)` -> `true` / `||`: genuinely different
	// target names must never be treated as overlapping or accepted as a
	// recreate that completes the cycle.
	it("N: genuinely different target names never overlap", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir staging" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf build" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeUndefined();
	});
});

// ==========================================================================
// readCommand
// ==========================================================================
describe("readCommand", () => {
	// Kills `typeof cmd === "string"` -> `true`: a non-string `command`
	// field (fabricated; TS types are erased at runtime) must normalize to
	// "", never pass through as-is. A raw number equals itself under strict
	// `!==`, so an un-normalized non-string command would otherwise satisfy
	// the retry loop's identity check and fire on 3 "identical" values.
	it("N: a non-string command field never counts as a real (matching) command", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			...Array.from({ length: 3 }, (_, i) =>
				ev({
					ts_ms: T0 + i * 100,
					hook_event: "PostToolUseFailure",
					tool_input: { command: 42 as unknown as string },
					succeeded: false,
				}),
			),
		]);
		expect(firstOfPattern(traces, "unbackedoff_retry")).toBeUndefined();
	});
});

// ==========================================================================
// summarizeInput
// ==========================================================================
describe("summarizeInput", () => {
	// Kills `e.tool_input?.file_path` -> `e.tool_input.file_path` (optional
	// chaining removed): must not throw when tool_input itself is undefined
	// and the event carries no command either.
	it("P: an event with no tool_input at all does not throw building evidence", () => {
		const detector = createTrajectoryDetector();
		const events = Array.from({ length: 6 }, (_, i) => ev({ ts_ms: T0 + i * 1_000, tool_name: "Glob", tool_input: undefined }));
		expect(() => observeAll(detector, events)).not.toThrow();
		const traces = observeAll(createTrajectoryDetector(), events);
		const finding = firstOfPattern(traces, "tool_loop");
		expect(finding).toBeDefined();
		// Kills readCommand's `""` -> `"Stryker was here!"` fallback: with no
		// tool_input, summarizeInput's `if (cmd) return ...` only takes the
		// command branch when readCommand's empty-fallback is genuinely falsy.
		// `toBeDefined()` alone can't see this — the finding still fires
		// either way, only its evidence text changes (bare tool name "Glob"
		// vs "Glob: Stryker was here!").
		expect(finding?.evidence[0]).toBe('"Glob"');
	});
});

// ==========================================================================
// truncate
// ==========================================================================
describe("truncate", () => {
	// Kills `s.length <= max` -> `<`: a command of EXACTLY EVIDENCE_MAX_CHARS
	// (80) must pass through untruncated, not gain a spurious ellipsis.
	it("N: a command of exactly 80 chars is not truncated (boundary)", () => {
		const cmd = `npm test -- ${"x".repeat(68)}`; // 12 + 68 = 80 chars
		expect(cmd.length).toBe(80);
		const traces = observeAll(createTrajectoryDetector(), [
			...Array.from({ length: 3 }, (_, i) =>
				ev({ ts_ms: T0 + i * 100, hook_event: "PostToolUseFailure", tool_input: { command: cmd }, succeeded: false }),
			),
		]);
		const finding = firstOfPattern(traces, "unbackedoff_retry");
		expect(finding?.message).toContain(cmd);
		expect(finding?.message).not.toContain("…");
	});
	// Kills `Math.max(0, max - 1)` -> `Math.min(0, max - 1)` (79 real chars
	// collapses to 0) AND `max - 1` -> `max + 1` (79 grows to 81): a long
	// command's truncated evidence must retain exactly 79 real characters
	// before the ellipsis.
	it("P: a long command keeps exactly 79 real characters before the ellipsis", () => {
		const cmd = `npm test -- ${"x".repeat(200)}`;
		const traces = observeAll(createTrajectoryDetector(), [
			...Array.from({ length: 3 }, (_, i) =>
				ev({ ts_ms: T0 + i * 100, hook_event: "PostToolUseFailure", tool_input: { command: cmd }, succeeded: false }),
			),
		]);
		const finding = firstOfPattern(traces, "unbackedoff_retry");
		const truncated = /on (.+)$/.exec(finding?.message ?? "")?.[1];
		expect(truncated?.endsWith("…")).toBe(true);
		expect(truncated?.length).toBe(80); // 79 real chars + the ellipsis char
	});
});

// ==========================================================================
// findDestructiveCyclePrefix
// ==========================================================================
describe("findDestructiveCyclePrefix", () => {
	// Kills `e.tool_name !== "Bash"` -> false: a non-Bash event carrying a
	// fabricated matching `command` field must not be treated as a real
	// recreate.
	it("N: a non-Bash event's command field is never treated as a real recreate", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_name: "Read", tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf build" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeUndefined();
	});
	// Kills `recreateAt === -1 && RECREATE_RX.test(cmd)` -> `||`: once a
	// recreate is found, a SECOND (earlier, decoy) recreate-shaped command
	// must not overwrite it. The decoy uses a different flag, so its
	// evidence text differs from the real recreate's, making an overwrite
	// observable via the evidence content.
	it("P: recreateAt is not overwritten by an earlier decoy recreate", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 3_000, tool_input: { command: "mkdir -p build" } }), // decoy, earlier, different flag
			ev({ ts_ms: T0 + 6_000, tool_input: { command: "mkdir build" } }), // real recreate, closer to the trailing rm
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf build" } }),
		]);
		const finding = firstOfPattern(traces, "destructive_sequence");
		expect(finding).toBeDefined();
		expect(finding?.evidence.some((e) => e.includes("mkdir build") && !e.includes("-p"))).toBe(true);
	});
	// Kills `recreateAt !== -1 && DESTRUCTIVE_RX.test(cmd)` -> `true` / `||`
	// AND the isolated `recreateAt !== -1` -> `true`: bypassing the
	// recreateAt gate lets a PREMATURE destructive-shaped command
	// short-circuit the scan via `break` before it ever reaches the
	// legitimate recreate sitting further back.
	it("N: a destructive command before any recreate is found does not short-circuit the scan", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_input: { command: "mkdir build" } }), // the real, legitimate recreate — furthest back
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "rm -rf build" } }), // premature "earlier rm" candidate
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf build" } }), // trailing rm
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeUndefined();
	});
	// Kills the EARLIER-RM branch's `target && pathsOverlap(...)` -> `true` /
	// `||`. An earlier rm targeting a DIFFERENT path must never complete
	// the cycle even when a genuinely valid recreate exists.
	it("N: an earlier rm targeting a DIFFERENT path never completes the cycle", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_input: { command: "rm -rf staging" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf build" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeUndefined();
	});
	// Round-2 fresh-eyes finding: the existing "destructive command before any
	// recreate is found" test above (line ~743) does NOT actually distinguish
	// the mutant from pristine — in that 3-event fixture, the genuine
	// recreate sits BEFORE the decoy rm in scan order, so `earlierRmAt`
	// never gets a chance to be set either way and both pristine and mutant
	// return null for the same (different) reason. This case places a decoy
	// rm on the SAME path CLOSER to the trailing rm than the genuine
	// recreate+earlier-rm pair, so the two implementations only diverge here:
	// pristine keeps scanning past the decoy (its `recreateAt !== -1` gate
	// isn't met yet) and finds the real cycle further back; the
	// force-true/`||`-loosened mutants let the decoy satisfy the
	// earlier-rm branch immediately and `break` before ever reaching the
	// genuine recreate, so `recreateAt` stays -1 and the whole match is lost.
	// test-contract: bug — kills recreateAt!==-1&&DESTRUCTIVE_RX.test(cmd)->true,
	// the ||-loosened variant, the isolated recreateAt!==-1->true, and the
	// isolated recreateAt===-1->false (which prevents recreateAt from ever
	// being set at all, same observable: no cycle found).
	it("P: a decoy earlier-rm closer to the trigger does not short-circuit past a genuine cycle further back", () => {
		const detector = createTrajectoryDetector({ cooldownMs: 0 });
		const traces = observeAll(detector, [
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }), // genuine earlier rm, furthest back
			ev({ ts_ms: T0 + 2_000, tool_input: { command: "mkdir build" } }), // genuine recreate
			ev({ ts_ms: T0 + 4_000, tool_input: { command: "rm -rf build" } }), // decoy: closer to the trigger, scanned first
			ev({ ts_ms: T0 + 6_000, tool_input: { command: "rm -rf build" } }), // trailing rm that triggers the scan
		]);
		const finding = traces[3]?.find((f) => f.pattern === "destructive_sequence");
		expect(finding).toBeDefined();
		expect(finding?.message).toContain("destructive cycle on build");
	});
});

// ==========================================================================
// detectDestructiveSequence — last.hook_event / last.tool_name guard
// ==========================================================================
describe("detectDestructiveSequence — trailing-event guard", () => {
	// Kills the whole-OR->false, the isolated hook_event subcheck->false, AND
	// the OR->AND swap all at once: with hook_event="PostToolUse" (not
	// PreToolUse) and tool_name="Bash", the hook_event disjunct is the ONLY
	// one true.
	it("N: a PostToolUse (not PreToolUse) trailing event never starts a cycle", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, hook_event: "PostToolUse", tool_input: { command: "rm -rf build" }, succeeded: true }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeUndefined();
	});
	// Kills the isolated tool_name subcheck->false. A fabricated `command`
	// field on a non-Bash tool is what makes the divergence observable —
	// readCommand only looks at the field, not the tool_name.
	it("N: a non-Bash tool carrying a command-shaped field never starts a cycle", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_name: "Read", tool_input: { command: "rm -rf build" } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeUndefined();
	});
	// Kills `!lastTarget` -> false: the trailing command matches
	// DESTRUCTIVE_RX but extractFirstPath parses an EMPTY target ("rm" with
	// only trailing whitespace, no path token at all).
	it("N: a bare 'rm' with no path argument never starts a cycle (empty target)", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_input: { command: "rm ///" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir ///" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm   " } }),
		]);
		expect(firstOfPattern(traces, "destructive_sequence")).toBeUndefined();
	});
	// Kills `[earlierRmAt, recreateAt, buffer.length-1]` -> `[]` (evidence
	// array), the SAME array's `buffer.length - 1` -> `+ 1` (last-event slot
	// goes out-of-bounds, filtered away), and the "warning" severity literal.
	it("P: a valid cycle carries exactly 3 evidence entries and 'warning' severity", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_input: { command: "rm -rf staging" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir staging" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf staging" } }),
		]);
		const finding = firstOfPattern(traces, "destructive_sequence");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("warning");
		expect(finding?.evidence.length).toBe(3);
	});
});

// ==========================================================================
// detectSilentStall
// ==========================================================================
describe("detectSilentStall", () => {
	// Kills `gap / 60_000` -> `gap * 60_000`: the reported minute count must
	// be the DIVISION result, not a wildly larger multiplication.
	it("P: an 11-minute gap reports exactly '11m' idle, not a multiplied value", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_input: { command: "ls" } }),
			ev({ ts_ms: T0 + 11 * 60_000, tool_input: { command: "ls" } }),
		]);
		const finding = firstOfPattern(traces, "silent_stall");
		expect(finding?.message).toContain("11m");
	});
});

// ==========================================================================
// detectToolLoop — state-change scan (first backward loop)
// ==========================================================================
describe("detectToolLoop — state-change scan", () => {
	// Kills `e.hook_event === "PostToolUse"` -> `true`: a Write PreToolUse
	// event (no matching Post at all) must NOT be recognized as a state
	// change.
	it("N: a Write PreToolUse (no Post) is not a recognized state change", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			...Array.from({ length: 3 }, (_, i) => ev({ ts_ms: T0 + i * 5_000, tool_name: "Read", tool_input: { file_path: "/a.ts" } })),
			ev({ ts_ms: T0 + 16_000, tool_name: "Write", tool_input: { file_path: "/a.ts" } }),
			...Array.from({ length: 3 }, (_, i) => ev({ ts_ms: T0 + 17_000 + i * 5_000, tool_name: "Read", tool_input: { file_path: "/a.ts" } })),
		]);
		expect(firstOfPattern(traces, "tool_loop")).toBeDefined();
	});
	// Kills `e.hook_event === "PostToolUse"` -> `!==`: a Write PostToolUse
	// event (no separate Pre pushed) IS a recognized state change and must
	// split the run.
	it("P: a Write PostToolUse (no separate Pre) is a recognized state change", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			...Array.from({ length: 3 }, (_, i) => ev({ ts_ms: T0 + i * 5_000, tool_name: "Read", tool_input: { file_path: "/a.ts" } })),
			ev({ ts_ms: T0 + 16_000, hook_event: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/a.ts" }, succeeded: true }),
			...Array.from({ length: 3 }, (_, i) => ev({ ts_ms: T0 + 17_000 + i * 5_000, tool_name: "Read", tool_input: { file_path: "/a.ts" } })),
		]);
		expect(firstOfPattern(traces, "tool_loop")).toBeUndefined();
	});
	// Kills the AND->OR swap: a Read PostToolUse event (tool_name NOT in
	// STATE_CHANGE_TOOLS, hook_event happens to be "PostToolUse") must NOT
	// count as a state change under the real AND.
	it("N: a non-state-change tool's PostToolUse event alone is not a state change", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			...Array.from({ length: 3 }, (_, i) => ev({ ts_ms: T0 + i * 5_000, tool_name: "Read", tool_input: { file_path: "/a.ts" } })),
			ev({ ts_ms: T0 + 16_000, hook_event: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/a.ts" }, succeeded: true }),
			...Array.from({ length: 3 }, (_, i) => ev({ ts_ms: T0 + 17_000 + i * 5_000, tool_name: "Read", tool_input: { file_path: "/a.ts" } })),
		]);
		expect(firstOfPattern(traces, "tool_loop")).toBeDefined();
	});
	// Kills `stateChangeIdx + 1` -> `- 1`: with the state change at index 1
	// (after exactly 1 prior read), counting must start strictly AFTER it —
	// exactly 5 reads (boundary, does not fire), not 6 (re-including the
	// pre-change read).
	it("N: counting starts strictly after the found state change, not one slot earlier (boundary)", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_name: "Read", tool_input: { file_path: "/a.ts" } }),
			ev({ ts_ms: T0 + 1_000, hook_event: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/a.ts" }, succeeded: true }),
			...Array.from({ length: 5 }, (_, i) => ev({ ts_ms: T0 + 2_000 + i * 1_000, tool_name: "Read", tool_input: { file_path: "/a.ts" } })),
		]);
		expect(firstOfPattern(traces, "tool_loop")).toBeUndefined();
	});
	// Kills `e.hook_event !== "PreToolUse"` -> `false` (the counting loop's
	// own filter): a PostToolUse event with a matching key must be excluded
	// from the count.
	it("N: a PostToolUse event with a matching key is excluded from the repeat count", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0, tool_name: "Read", tool_input: { file_path: "/a.ts" } }),
			ev({ ts_ms: T0 + 1_000, tool_name: "Read", tool_input: { file_path: "/a.ts" } }),
			ev({ ts_ms: T0 + 2_000, hook_event: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/a.ts" }, succeeded: true }),
			ev({ ts_ms: T0 + 3_000, tool_name: "Read", tool_input: { file_path: "/a.ts" } }),
			ev({ ts_ms: T0 + 4_000, tool_name: "Read", tool_input: { file_path: "/a.ts" } }),
			ev({ ts_ms: T0 + 5_000, tool_name: "Read", tool_input: { file_path: "/a.ts" } }),
		]);
		expect(firstOfPattern(traces, "tool_loop")).toBeUndefined();
	});
	// Kills `e.ts_ms < cutoff` -> `<=` in the FIRST (state-change-scan) loop.
	// A read pushed BEFORE the state change, with a ts_ms exactly at the
	// window cutoff, only leaks into the count when the mutant's early `<=`
	// break stops the scan before it ever examines the write event that
	// pristine correctly finds.
	it("N: cutoff boundary — the state-change event AT the cutoff is still examined", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0 + 1, tool_name: "Read", tool_input: { file_path: "/a.ts" } }),
			ev({ ts_ms: T0, hook_event: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/a.ts" }, succeeded: true }),
			...Array.from({ length: 5 }, (_, i) => ev({ ts_ms: T0 + 56_000 + i * 1_000, tool_name: "Read", tool_input: { file_path: "/a.ts" } })),
		]);
		expect(firstOfPattern(traces, "tool_loop")).toBeUndefined();
	});
	// Kills `e.ts_ms < cutoff` -> `false` in the state-change scan's OWN
	// window-break (the loop must give up once it walks past the 60s
	// lookback window, not keep scanning indefinitely). Removing the break
	// lets the scan discover a state-change event lying OUTSIDE the window
	// — reachable here only because it arrives out of order (pushed after
	// three genuinely in-window reads, but stamped with a much older
	// ts_ms) — which then wrongly becomes the new starting point for the
	// repeat count, truncating away duplicate calls that ARE inside the
	// window.
	// test-contract: invariant — the tool_loop repeat count must include
	// every duplicate call whose own ts_ms falls inside the 60s lookback
	// window, regardless of where an out-of-window state-change event sits
	// in the scan order.
	it("N: a state-change event outside the 60s window, delivered out of order, never truncates the in-window repeat count", () => {
		const traces = observeAll(createTrajectoryDetector(), [
			ev({ ts_ms: T0 + 41_000, tool_name: "Read", tool_input: { file_path: "/dup.ts" } }),
			ev({ ts_ms: T0 + 42_000, tool_name: "Read", tool_input: { file_path: "/dup.ts" } }),
			ev({ ts_ms: T0 + 43_000, tool_name: "Read", tool_input: { file_path: "/dup.ts" } }),
			// Pushed AFTER the three reads above, but stamped with a ts_ms far
			// outside the 60s window measured from the final event below.
			ev({ ts_ms: T0 + 1_000, hook_event: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/other.ts" }, succeeded: true }),
			ev({ ts_ms: T0 + 90_000, tool_name: "Read", tool_input: { file_path: "/dup.ts" } }),
			ev({ ts_ms: T0 + 95_000, tool_name: "Read", tool_input: { file_path: "/dup.ts" } }),
			ev({ ts_ms: T0 + 100_000, tool_name: "Read", tool_input: { file_path: "/dup.ts" } }), // cutoff = T0+40_000
		]);
		expect(firstOfPattern(traces, "tool_loop")).toBeDefined();
	});
});
