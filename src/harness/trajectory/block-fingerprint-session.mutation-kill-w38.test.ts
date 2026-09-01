import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTracker } from "../session-state.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import type { BlockFingerprint } from "./block-fingerprint.js";

// Hoisted mock fns so both vi.mock factories (evaluated before imports) can
// close over them, and individual tests can reconfigure/inspect them.
const mockResolveProposedContent = vi.hoisted(() => vi.fn());
const mockLoadArmedFingerprints = vi.hoisted(() => vi.fn());
const mockPersistArmedFingerprints = vi.hoisted(() => vi.fn());

vi.mock("../overlay-content.js", () => ({
	resolveProposedContent: mockResolveProposedContent,
}));

vi.mock("./fingerprint-archive.js", () => ({
	loadArmedFingerprints: mockLoadArmedFingerprints,
	persistArmedFingerprints: mockPersistArmedFingerprints,
}));

import {
	formatWorkaroundStopLine,
	noteWorkaroundSignal,
	observeBlockWorkaround,
	recordBlockFingerprint,
} from "./block-fingerprint-session.js";

function write(filePath: string | undefined, content: string): HarnessEvent {
	const tool_input: Record<string, unknown> = { content };
	if (filePath !== undefined) tool_input.file_path = filePath;
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		tool_name: "Write",
		tool_input,
		cwd: "/repo",
		timestamp: "t",
	};
}

function bash(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		cwd: "/repo",
		timestamp: "t",
	};
}

function fresh(): SessionTrajectory {
	return new SessionTracker().recordEvent(bash("ls"));
}

const T0 = 1_000_000;
const BLOCK: HarnessDecision = { decision: "block", reason: "no", rule_id: "empty_catch" };
const ALLOW: HarnessDecision = { decision: "allow" };

beforeEach(() => {
	vi.clearAllMocks();
	// Default behavior mirrors the real modules closely enough for tests that
	// don't specifically target these seams.
	mockResolveProposedContent.mockImplementation((_path: string, input: Record<string, unknown>) =>
		typeof input.content === "string" ? input.content : "",
	);
	mockLoadArmedFingerprints.mockReturnValue(null);
	mockPersistArmedFingerprints.mockImplementation(() => undefined);
});

describe("noteWorkaroundSignal — dedup key uses BOTH fields (mutation-kill)", () => {
	// test-contract: boundary — dedup must require detector AND ruleId to match,
	// not either alone (else unrelated signals collapse into one).
	it("keeps two signals with the same detector but different ruleId", () => {
		const s = fresh();
		noteWorkaroundSignal(s, { detector: "D", ruleId: "R1" });
		noteWorkaroundSignal(s, { detector: "D", ruleId: "R2" });
		expect(s.workaround_signals).toEqual([
			{ detector: "D", ruleId: "R1" },
			{ detector: "D", ruleId: "R2" },
		]);
	});

	// test-contract: boundary — same as above, mirrored on the other field.
	it("keeps two signals with the same ruleId but different detector", () => {
		const s = fresh();
		noteWorkaroundSignal(s, { detector: "A", ruleId: "X" });
		noteWorkaroundSignal(s, { detector: "B", ruleId: "X" });
		expect(s.workaround_signals).toEqual([
			{ detector: "A", ruleId: "X" },
			{ detector: "B", ruleId: "X" },
		]);
	});
});

describe("formatWorkaroundStopLine — exact string shape (mutation-kill)", () => {
	// test-contract: invariant — only the first 4 signals are named in the line.
	it("lists at most 4 signals, dropping the 5th", () => {
		const s = fresh();
		for (let i = 0; i < 5; i++) {
			noteWorkaroundSignal(s, { detector: `det${i}`, ruleId: `rule${i}` });
		}
		const line = formatWorkaroundStopLine(s);
		expect(line).toContain("det0 (vs rule0)");
		expect(line).toContain("det3 (vs rule3)");
		expect(line).not.toContain("det4");
		expect(line).not.toContain("rule4");
	});

	// test-contract: invariant — signals are joined with "; ", not concatenated.
	it("joins multiple signals with an explicit semicolon-space separator", () => {
		const s = fresh();
		noteWorkaroundSignal(s, { detector: "same-content-resurfacing", ruleId: "eval_injection" });
		noteWorkaroundSignal(s, { detector: "config-loosening-in-window", ruleId: "coverage_gate" });
		const line = formatWorkaroundStopLine(s);
		expect(line).toContain(
			"same-content-resurfacing (vs eval_injection); config-loosening-in-window (vs coverage_gate)",
		);
	});

	// test-contract: invariant — the trailing explanatory sentence is present verbatim.
	it("carries the gate-defect explanatory sentence", () => {
		const s = fresh();
		noteWorkaroundSignal(s, { detector: "d", ruleId: "r" });
		const line = formatWorkaroundStopLine(s);
		expect(line).toContain(
			"change, that is a gate defect to report — routing around it silently defeats the guarantee it protects.",
		);
	});
});

describe("candidateFromEvent — field extraction (mutation-kill, via observeBlockWorkaround)", () => {
	// test-contract: boundary — a Write naming only `path` (not `file_path`) is
	// still resolved, and normalizes backslashes to forward slashes.
	it("resolves the target from `path` when `file_path` is absent, normalizing backslashes", () => {
		const s = fresh();
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Write",
			tool_input: { path: "src\\danger.ts", content: "eval(x)" },
			cwd: "/repo",
			timestamp: "t",
		};
		observeBlockWorkaround(s, event, BLOCK, "/repo", T0);
		expect(s.block_fingerprints?.[0]?.target).toBe("src/danger.ts");
	});

	// test-contract: invariant — a blocked Write's fingerprint carries channel "write".
	it("tags a blocked Write's fingerprint with channel write", () => {
		const s = fresh();
		observeBlockWorkaround(s, write("src/danger.ts", "eval(x)"), BLOCK, "/repo", T0);
		expect(s.block_fingerprints?.[0]?.channel).toBe("write");
	});

	// test-contract: invariant — a blocked Bash command's fingerprint carries channel "command".
	it("tags a blocked Bash command's fingerprint with channel command", () => {
		const s = fresh();
		observeBlockWorkaround(s, bash("git commit -m x"), BLOCK, "/repo", T0);
		expect(s.block_fingerprints?.[0]?.channel).toBe("command");
	});

	// test-contract: bug — a non-string `file_path` must never reach `path.resolve`;
	// strField's type guard is the only thing preventing a crash there.
	it("does not crash when a blocked Write carries a non-string file_path", () => {
		const s = fresh();
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Write",
			// SAFETY: deliberately wrong runtime type — probing strField's typeof guard.
			tool_input: { file_path: 123 as unknown as string, content: "eval(x)" },
			cwd: "/repo",
			timestamp: "t",
		};
		expect(() => observeBlockWorkaround(s, event, BLOCK, "/repo", T0)).not.toThrow();
		expect(s.block_fingerprints?.[0]?.target).toBeNull();
	});

	// test-contract: bug — a non-string bash `command` must fall back to
	// undefined content, never reach the shingle tokenizer with a number.
	it("does not crash when an allowed Bash event carries a non-string command", () => {
		const s = fresh();
		observeBlockWorkaround(s, bash("git commit -m x"), BLOCK, "/repo", T0);
		const weird: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Bash",
			// SAFETY: deliberately wrong runtime type — probing the typeof guard.
			tool_input: { command: 123 as unknown as string },
			cwd: "/repo",
			timestamp: "t",
		};
		expect(() => observeBlockWorkaround(s, weird, ALLOW, "/repo", T0 + 1000)).not.toThrow();
	});

	// test-contract: boundary — when a Write's early-return (no name found) is
	// skipped, the candidate must not accidentally match an armed fingerprint
	// through a resolved `content` field the early return would have omitted.
	it("does not resurface an armed fingerprint via a nameless Write's content", () => {
		const s = fresh();
		recordBlockFingerprint(s, { ruleId: "eval_injection", content: "eval(x)", target: null, atMs: T0 });
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Write",
			tool_input: { content: "eval(x)" },
			cwd: "/repo",
			timestamp: "t",
		};
		const sig = observeBlockWorkaround(s, event, ALLOW, "/repo", T0 + 1000);
		expect(sig).toBeNull();
	});

	// test-contract: bug — the fallback content for a fingerprint with neither
	// candidate content nor command must be an EMPTY string (empty shingle set),
	// not a placeholder that would fabricate a false content match.
	it("arms an empty-shingle fingerprint when a blocked Write has no name and no reachable content", () => {
		const s = fresh();
		observeBlockWorkaround(s, write(undefined, "irrelevant"), BLOCK, "/repo", T0);
		expect(s.block_fingerprints?.[0]?.shingles.size).toBe(0);
	});
});

describe("nothingToObserve — fast-exit skips candidate extraction (mutation-kill)", () => {
	// test-contract: invariant — with nothing armed and an allowed event, the
	// hot-path exit must skip calling into overlay content resolution entirely.
	it("never calls resolveProposedContent when nothing is armed and the event is allowed", () => {
		const s = fresh();
		const event = write("src/a.ts", "hello");
		const sig = observeBlockWorkaround(s, event, ALLOW, "/repo", T0);
		expect(sig).toBeNull();
		expect(mockResolveProposedContent).not.toHaveBeenCalled();
	});
});

describe("hydrateOnce — persisted-archive plumbing (mutation-kill)", () => {
	// test-contract: invariant — a persisted archive's fingerprints are adopted
	// as-is (not silently discarded) on the first event of a fresh session.
	it("adopts a non-empty persisted fingerprint list on first hydrate", () => {
		const persisted: BlockFingerprint = {
			ruleId: "persisted_rule",
			shingles: new Set(["a", "b"]),
			target: "src/old.ts",
			atMs: T0,
		};
		mockLoadArmedFingerprints.mockReturnValueOnce({ fingerprints: [persisted], signals: [] });
		const s = fresh();
		observeBlockWorkaround(s, bash("echo hi"), ALLOW, "/repo", T0);
		expect(s.block_fingerprints).toHaveLength(1);
		expect(s.block_fingerprints?.[0]?.ruleId).toBe("persisted_rule");
	});

	// test-contract: invariant — an EMPTY persisted signals list must not
	// spuriously initialize `workaround_signals` to a defined (but empty) array;
	// it should stay untouched (undefined) when there is nothing to hydrate.
	it("leaves workaround_signals untouched when the persisted signals list is empty", () => {
		mockLoadArmedFingerprints.mockReturnValueOnce({ fingerprints: [], signals: [] });
		const s = fresh();
		expect(s.workaround_signals).toBeUndefined();
		observeBlockWorkaround(s, bash("echo hi"), ALLOW, "/repo", T0);
		expect(s.workaround_signals).toBeUndefined();
	});
});

describe("persistNow — write-through call args (mutation-kill)", () => {
	// test-contract: invariant — a blocked event must call persistArmedFingerprints
	// at all, with the actual (non-empty) armed set, not a stubbed-out no-op.
	it("persists the actual (non-empty) armed fingerprint set after a block", () => {
		const s = fresh();
		observeBlockWorkaround(s, bash("git commit -m x"), BLOCK, "/repo", T0);
		expect(mockPersistArmedFingerprints).toHaveBeenCalledTimes(1);
		const call = mockPersistArmedFingerprints.mock.calls[0];
		expect(call?.[0]).toBe("/repo");
		expect(call?.[1]).toBe("s");
		const persistedFingerprints = call?.[2] as unknown[]; // SAFETY: mocked call arg, shape asserted by test.
		expect(persistedFingerprints.length).toBe(1);
	});

	// test-contract: invariant — the detected workaround signal must be part of
	// the persisted signals array, not silently dropped to [].
	it("persists the actual (non-empty) workaround signals set after a detection", () => {
		const s = fresh();
		observeBlockWorkaround(s, bash("git commit -m x"), BLOCK, "/repo", T0);
		observeBlockWorkaround(
			s,
			bash("INTERLINKED_DISABLE_BASELINE_GUARD=1 git commit -m x"),
			ALLOW,
			"/repo",
			T0 + 1000,
		);
		const calls = mockPersistArmedFingerprints.mock.calls;
		const lastCall = calls[calls.length - 1];
		expect(lastCall?.[3]).toEqual([{ detector: "escape-env-after-block", ruleId: "empty_catch" }]);
	});
});

describe("observeBlockWorkaround — a null signal must never reach noteWorkaroundSignal (mutation-kill)", () => {
	// test-contract: bug — when detectWorkaround finds nothing, the choke-point
	// must not call noteWorkaroundSignal(session, null) (it would crash reading
	// `.detector` off null) nor persist again for this event.
	it("does not throw and does not re-persist when no workaround is detected on an allowed event", () => {
		const s = fresh();
		observeBlockWorkaround(s, bash("git commit -m x"), BLOCK, "/repo", T0);
		mockPersistArmedFingerprints.mockClear();
		const unrelated = bash("npm test");
		expect(() => observeBlockWorkaround(s, unrelated, ALLOW, "/repo", T0 + 1000)).not.toThrow();
		expect(mockPersistArmedFingerprints).not.toHaveBeenCalled();
	});
});
