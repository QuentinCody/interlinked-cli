// Mutation-kill companion for hook-entry-daemon-gate.ts (PASS-1, W6/W9 LEAN MODE).
// Static SUT import per the placement rule in scratch/fleet-r3/CONTRACT-W6.md —
// this file targets specific surviving mutants (see receipts under
// scratch/fleet-r3/receipts/hook-entry-daemon-gate.jsonl for the full mapping).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The directory selfHealServerPath (unexported) computes as
 *  `dirname(fileURLToPath(import.meta.url))`. `fileURLToPath` has exactly one
 *  call site in this module's whole reachable dependency closure (verified by
 *  grep before writing this mock), so redirecting it unconditionally cannot
 *  affect any other function under test in this file. Reassigned per test in
 *  the "selfHealServerPath" describe below so each candidate-slot case gets
 *  an isolated, empty sandbox — real files created there are what the REAL
 *  (unmocked) existsSync sees; only this "here" anchor is faked. */
let selfHealHere = "";

vi.mock("node:url", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:url")>();
	return {
		...actual,
		fileURLToPath: () => join(selfHealHere, "hook-entry-daemon-gate.ts"),
	};
});

/** Calls the real (unmocked) `spawnDaemonDetached` makes to `child_process.spawn`
 *  when self-heal runs with no `deps.spawnDaemon` override. `spawn` has exactly
 *  one call site in this module's reachable dependency closure (verified by
 *  grep before writing this mock), so replacing it cannot affect any other
 *  function under test in this file — and no real process is ever launched. */
const spawnCalls: Array<{ command: string; args: string[]; options: unknown }> = [];

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (command: string, args: string[], options: unknown) => {
			spawnCalls.push({ command, args, options });
			return Object.assign(new actual.ChildProcess(), { pid: process.pid });
		},
	};
});

import {
	attemptDaemonSelfHeal,
	coldDaemonUnreachableBlockReason,
	isHarnessRecoveryCommand,
} from "./hook-entry-daemon-gate.js";
import { DEFAULT_DAEMON_HEAP_MB } from "./harness/memory-ceiling.js";
import type { UnifiedHookEvent } from "./harness/unified-event.js";

function makeEvent(cwd: string): UnifiedHookEvent {
	return {
		schema_version: "1",
		event_id: "e1",
		session_id: "s1",
		ts: "2026-08-17T00:00:00.000Z",
		runner: "claude-code",
		runner_native_event: "PreToolUse",
		phase: "pre-tool",
		action: { kind: "shell_command", command: "echo hi", cwd, tool_class: "read" },
		context: { cwd },
		raw: null,
	};
}

function shell(command: string): UnifiedHookEvent["action"] {
	return { kind: "shell_command", command, tool_class: "modify" };
}

/** Build a string of exactly `n` literal spaces — avoids miscounting spaces by
 *  eye inside a string literal when pinning an exact quantifier boundary. */
const sp = (n: number): string => " ".repeat(n);

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "he-daemon-gate-mk-"));
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	spawnCalls.length = 0;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("daemonDownBlockMessage — exact full-message invariant (mass-kills the StringLiteral family)", () => {
	// test-contract: invariant — every literal segment of the block message, and
	// the why/context interpolation, must survive verbatim; this pins the FULL
	// string a blocked agent sees, not a substring of it.
	it("P1: the dead-pid message is the exact concatenation, with no ledger context", () => {
		writeFileSync(join(dir, ".interlinked", "harness.pid"), "2147480000\n");
		const reason = coldDaemonUnreachableBlockReason(makeEvent(dir), dir, {});
		expect(reason).toEqual(
			"BLOCKED: the interlinked harness should be guarding this project but is unreachable " +
				"(harness pid present, no live daemon). " +
				"The guard layer has cut out mid-session, so tool calls are blocked to avoid running " +
				"unguarded. The daemon supervisor is bringing it back — retry your call in a few seconds. " +
				"Do NOT start a daemon by hand; concurrent starts race each other. To intentionally run " +
				"this project unguarded, use `interlinked disable` (recorded + auditable); for a one-off " +
				"bypass, set INTERLINKED_ALLOW_NO_DAEMON=1.",
		);
	});

	// test-contract: invariant — same full-message pin, the OTHER `why` branch
	// (no pid file at all, but a committed config.json) — proves the `why`
	// interpolation itself is exact, not just the six trailing segments.
	it("P2: the no-pid/configured message is the exact concatenation, with the OTHER why-clause", () => {
		writeFileSync(join(dir, ".interlinked", "config.json"), "{}");
		const reason = coldDaemonUnreachableBlockReason(makeEvent(dir), dir, {});
		expect(reason).toEqual(
			"BLOCKED: the interlinked harness should be guarding this project but is unreachable " +
				"(configured here, but no live daemon). " +
				"The guard layer has cut out mid-session, so tool calls are blocked to avoid running " +
				"unguarded. The daemon supervisor is bringing it back — retry your call in a few seconds. " +
				"Do NOT start a daemon by hand; concurrent starts race each other. To intentionally run " +
				"this project unguarded, use `interlinked disable` (recorded + auditable); for a one-off " +
				"bypass, set INTERLINKED_ALLOW_NO_DAEMON=1.",
		);
	});
});

describe("daemonCutOut — dead-but-present pid must still block even with an orphaned socket file", () => {
	// test-contract: bug — a crashed daemon can leave its .sock file behind (the
	// OS does not clean it up); a dead pid must still block even when a socket
	// file is present, or a crash reads as "alive but slow".
	it("P1: a dead raw pid plus a present socket file still BLOCKS, not allows", () => {
		writeFileSync(join(dir, ".interlinked", "harness.pid"), "2147480000\n");
		writeFileSync(join(dir, ".interlinked", "harness.sock"), "");
		const reason = coldDaemonUnreachableBlockReason(makeEvent(dir), dir, {});
		expect(reason).toContain("BLOCKED");
		expect(reason).toContain("harness pid present");
	});

	// test-contract: bug — the framed-daemon variant of the same orphaned-socket
	// crash: `--protocol framed` writes harness-default.{pid,sock} instead of the
	// raw names, so the same dead+socket combination must be checked there too.
	it("P2: a dead FRAMED pid plus its matching socket file still BLOCKS", () => {
		writeFileSync(join(dir, ".interlinked", "harness-default.pid"), "2147480000\n");
		writeFileSync(join(dir, ".interlinked", "harness-default.sock"), "");
		const reason = coldDaemonUnreachableBlockReason(makeEvent(dir), dir, {});
		expect(reason).toContain("BLOCKED");
	});
});

describe("isHarnessRecoveryCommand — a chaining char smuggled inside the tsx-path capture", () => {
	// test-contract: security — \S{0,80} in the tsx-path capture accepts shell
	// metacharacters; SHELL_CHAINING must still reject one smuggled inside it,
	// not just one placed after "start" like every existing negative case.
	it("N1: rejects a semicolon+subshell smuggled into the tsx path segment", () => {
		expect(
			isHarnessRecoveryCommand(shell("npx tsx a;touch$(pwned)index.ts harness start")),
		).toBe(false);
	});

	// test-contract: security — same gap, a pipe instead of `;`/`$()`, confirming
	// SHELL_CHAINING's full character class is what is doing the rejecting here,
	// not an accident of one specific metacharacter.
	it("N2: rejects a pipe smuggled into the tsx path segment", () => {
		expect(
			isHarnessRecoveryCommand(shell("npx tsx a|rm -rf ~index.ts harness start")),
		).toBe(false);
	});
});

describe("HARNESS_RECOVERY_COMMAND — every separator's 1..4 boundary, position by position", () => {
	// test-contract: invariant — HARNESS_RECOVERY_COMMAND gained a `|disable`
	// branch on 2026-08-16; this pins the CURRENT five-separator shape directly
	// so a narrowed or widened `\s{1,4}` at the npx-separator position is caught
	// at both ends of its range.
	it("P1/N1: npx separator accepts 1 and 4 spaces, rejects 5", () => {
		expect(isHarnessRecoveryCommand(shell(`npx${sp(1)}interlinked harness start`))).toBe(true);
		expect(isHarnessRecoveryCommand(shell(`npx${sp(4)}interlinked harness start`))).toBe(true);
		expect(isHarnessRecoveryCommand(shell(`npx${sp(5)}interlinked harness start`))).toBe(false);
	});

	// test-contract: invariant — same boundary pin, the tsx-path separator.
	it("P2/N2: tsx-path separator accepts 1 and 4 spaces, rejects 5", () => {
		expect(isHarnessRecoveryCommand(shell(`tsx${sp(1)}src/index.ts harness start`))).toBe(true);
		expect(isHarnessRecoveryCommand(shell(`tsx${sp(4)}src/index.ts harness start`))).toBe(true);
		expect(isHarnessRecoveryCommand(shell(`tsx${sp(5)}src/index.ts harness start`))).toBe(false);
	});

	// test-contract: invariant — the separator shared by BOTH the `harness ...`
	// and the `disable` alternative (the one node the 2026-08-16 refactor
	// wrapped in a group), pinned through both branches.
	it("P3/N3: pre-branch separator (shared by harness AND disable) accepts 1/4, rejects 5", () => {
		expect(isHarnessRecoveryCommand(shell(`interlinked${sp(1)}harness start`))).toBe(true);
		expect(isHarnessRecoveryCommand(shell(`interlinked${sp(4)}harness start`))).toBe(true);
		expect(isHarnessRecoveryCommand(shell(`interlinked${sp(5)}harness start`))).toBe(false);
		expect(isHarnessRecoveryCommand(shell(`interlinked${sp(4)}disable`))).toBe(true);
		expect(isHarnessRecoveryCommand(shell(`interlinked${sp(5)}disable`))).toBe(false);
	});

	// test-contract: invariant — same boundary pin, the harness-to-start/restart
	// separator.
	it("P4/N4: harness-to-start separator accepts 1 and 4 spaces, rejects 5", () => {
		expect(isHarnessRecoveryCommand(shell(`interlinked harness${sp(1)}start`))).toBe(true);
		expect(isHarnessRecoveryCommand(shell(`interlinked harness${sp(4)}start`))).toBe(true);
		expect(isHarnessRecoveryCommand(shell(`interlinked harness${sp(5)}start`))).toBe(false);
	});

	// test-contract: invariant — same boundary pin, the repeated flag-tail
	// separator (`{0,8}` repetitions of `\s{1,4}--flag`).
	it("P5/N5: flag separator accepts 1 and 4 spaces, rejects 5", () => {
		expect(isHarnessRecoveryCommand(shell(`interlinked harness start${sp(1)}--verbose`))).toBe(true);
		expect(isHarnessRecoveryCommand(shell(`interlinked harness start${sp(4)}--verbose`))).toBe(true);
		expect(isHarnessRecoveryCommand(shell(`interlinked harness start${sp(5)}--verbose`))).toBe(false);
	});
});

describe("selfHealServerPath — candidate discovery (via attemptDaemonSelfHeal, node:url's fileURLToPath faked)", () => {
	// `outer` is the per-test-unique root; `here` (what fileURLToPath resolves
	// to) is a SUBDIRECTORY of it, not `outer` itself. Candidate 2 is
	// `here/../harness/server.js` — if `here` were mkdtemp'd directly under the
	// shared OS tmpdir, `here/..` would collapse to that SAME shared root for
	// every test, leaking one test's candidate-2 file into every other test's
	// candidate-2 check. Nesting `here` one level inside `outer` keeps
	// `here/..` (== `outer`) unique per test, and `afterEach` removes it whole.
	let outer: string;
	let here: string;

	beforeEach(() => {
		outer = mkdtempSync(join(tmpdir(), "he-selfheal-sandbox-"));
		here = join(outer, "here");
		mkdirSync(here, { recursive: true });
		selfHealHere = here;
	});
	afterEach(() => {
		rmSync(outer, { recursive: true, force: true });
		selfHealHere = "";
	});

	/** Create an empty file at `here/<segments>` — existsSync only checks
	 *  presence, so empty content is enough. */
	function createCandidate(...segments: string[]): void {
		const full = join(here, ...segments);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, "");
	}

	interface Spawned {
		path: string | null;
	}

	function healOnce(spawned: Spawned): string {
		return attemptDaemonSelfHeal(dir, {}, {
			now: () => 1_700_000_000_000,
			spawnDaemon: (serverPath) => {
				spawned.path = serverPath;
				return process.pid;
			},
		});
	}

	// test-contract: invariant — candidate 1 must be built from the literal
	// segments "harness" and "server.js" exactly; any wrong segment makes
	// existsSync miss the ONLY file this sandbox contains.
	it("P1: found when only the exact candidate-1 path (here/harness/server.js) exists", () => {
		createCandidate("harness", "server.js");
		const spawned: Spawned = { path: null };
		expect(healOnce(spawned)).toBe("spawned");
		expect(spawned.path).toBe(join(here, "harness", "server.js"));
	});

	// test-contract: invariant — negative control for P1: nothing on disk must
	// fail closed to "skipped", not silently spawn with a wrong/undefined path.
	it("N1: skipped when no candidate exists anywhere", () => {
		const spawned: Spawned = { path: null };
		expect(healOnce(spawned)).toBe("skipped");
		expect(spawned.path).toBeNull();
	});

	// test-contract: invariant — candidate 2's ".." segment and its own
	// "harness"/"server.js" occurrences are literals independent of candidate
	// 1's; with candidate 1 absent, only the exact candidate-2 path is found.
	it("P2: found when only the exact candidate-2 path (here/../harness/server.js) exists", () => {
		createCandidate("..", "harness", "server.js");
		const spawned: Spawned = { path: null };
		expect(healOnce(spawned)).toBe("spawned");
		expect(spawned.path).toBe(join(here, "..", "harness", "server.js"));
	});

	// test-contract: invariant — candidate 3's "dist" segment and its own
	// "harness"/"server.js" occurrences are literals independent of candidates
	// 1 and 2's; with both absent, only the exact candidate-3 path is found.
	it("P3: found when only the exact candidate-3 path (here/dist/harness/server.js) exists", () => {
		createCandidate("dist", "harness", "server.js");
		const spawned: Spawned = { path: null };
		expect(healOnce(spawned)).toBe("spawned");
		expect(spawned.path).toBe(join(here, "dist", "harness", "server.js"));
	});
});

describe("spawnDaemonDetached — exact argv/options invariant (mass-kills the 12 literal mutants)", () => {
	// test-contract: invariant — the respawned daemon must get the SAME heap
	// ceiling, protocol, and session-id every real daemon start uses
	// (DEFAULT_DAEMON_HEAP_MB); every deps.spawnDaemon override elsewhere hides
	// this exact argv, so only this test can pin it.
	it("P1: spawns process.execPath with the exact argv and detached/ignore options", () => {
		const result = attemptDaemonSelfHeal(dir, {}, {
			resolveServerPath: () => "/fake/harness/server.js",
			now: () => 1_700_000_000_000,
		});
		expect(result).toBe("spawned");
		expect(spawnCalls).toHaveLength(1);
		const call = spawnCalls[0]!;
		expect(call.command).toBe(process.execPath);
		expect(call.args).toEqual([
			`--max-old-space-size=${DEFAULT_DAEMON_HEAP_MB}`,
			"--expose-gc",
			"/fake/harness/server.js",
			"--cwd",
			dir,
			"--protocol",
			"dual",
			"--session-id",
			"default",
		]);
		expect(call.options).toEqual({ detached: true, stdio: "ignore" });
	});

	it.each([
		["999999999999", `--max-old-space-size=${DEFAULT_DAEMON_HEAP_MB}`],
		["-1", `--max-old-space-size=${DEFAULT_DAEMON_HEAP_MB}`],
		["Infinity", `--max-old-space-size=${DEFAULT_DAEMON_HEAP_MB}`],
	] as const)("uses the validated heap override %s", (raw, expected) => {
		const previous = process.env.INTERLINKED_HARNESS_HEAP_MB;
		process.env.INTERLINKED_HARNESS_HEAP_MB = raw;
		try {
			expect(
				attemptDaemonSelfHeal(dir, {}, {
					resolveServerPath: () => "/fake/harness/server.js",
					now: () => 1_700_000_000_000,
				}),
			).toBe("spawned");
			expect(spawnCalls[0]?.args[0]).toBe(expected);
		} finally {
			if (previous === undefined) delete process.env.INTERLINKED_HARNESS_HEAP_MB;
			else process.env.INTERLINKED_HARNESS_HEAP_MB = previous;
		}
	});
});
