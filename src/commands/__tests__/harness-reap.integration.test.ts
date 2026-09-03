// ===========================================
// `interlinked harness reap` — orphan-daemon sweep
// ===========================================
// Covers:
//   1. Default dry-run path: prints/returns the candidate set, no SIGTERM.
//   2. `--force`: actually issues SIGTERM via process.kill (in-process, so
//      the harness session-protection rule on `kill <pid>` does NOT apply —
//      verified by checking that an orphan PID is signalled successfully).
//   3. `--all`: still protects ancestors but does NOT skip the active daemon.
//   4. Ancestor protection: process.ppid never appears as a candidate.
//   5. JSON output shape.
//
// All tests use vi.hoisted mocks for `node:child_process` (ps + spawn) and
// `node:fs` (pid file existence + content). No real subprocesses spawned.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execSync: vi.fn(),
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	unlinkSync: vi.fn(),
	statSync: vi.fn(),
	mkdirSync: vi.fn(),
	openSync: vi.fn(),
	closeSync: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execSync: mocks.execSync,
	spawn: mocks.spawn,
}));

vi.mock("node:fs", () => ({
	closeSync: mocks.closeSync,
	existsSync: mocks.existsSync,
	mkdirSync: mocks.mkdirSync,
	openSync: mocks.openSync,
	readFileSync: mocks.readFileSync,
	statSync: mocks.statSync,
	unlinkSync: mocks.unlinkSync,
}));

// Live reaping is identity-fenced: selection from `ps` is followed by a
// stable process-start/argv identity check immediately before every signal.
// This suite owns the selection and signalling choreography, so provide a
// deterministic identity here; replacement/unverified PID behavior is pinned
// separately in harness-process-reap.test.ts.
vi.mock("../../harness/daemon-process-identity.js", async (importOriginal) => {
	const actual = await importOriginal<
		typeof import("../../harness/daemon-process-identity.js")
	>();
	return {
		...actual,
		readHarnessProcessIdentity: vi.fn((_cwd: string, pid: number) => `identity:${pid}`),
	};
});

import { reapOrphanHarnesses } from "../harness-process.js";
import { harnessReapCommand } from "../harness-reap.js";

interface CapturedStdio {
	stdout: string;
	stderr: string;
}

async function captureStdio(fn: () => Promise<void> | void): Promise<CapturedStdio> {
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	const realStdoutWrite = process.stdout.write.bind(process.stdout);
	const realStderrWrite = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
		return true;
	}) as typeof process.stderr.write;
	const realConsoleLog = console.log;
	const realConsoleError = console.error;
	console.log = (...args: unknown[]): void => {
		stdoutChunks.push(`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
	};
	console.error = (...args: unknown[]): void => {
		stderrChunks.push(`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
	};
	try {
		await fn();
	} finally {
		process.stdout.write = realStdoutWrite;
		process.stderr.write = realStderrWrite;
		console.log = realConsoleLog;
		console.error = realConsoleError;
	}
	return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

const ORPHAN_A = 50001;
const ORPHAN_B = 50002;
const ACTIVE_PID = 60000;

/** Build a `ps -ax -o pid=,ppid=,command=` payload for the test. */
function psPayload(rows: Array<{ pid: number; ppid: number; cmd: string }>): string {
	return rows.map((r) => `${r.pid} ${r.ppid} ${r.cmd}`).join("\n");
}

const HARNESS_CMD = "node /home/u/interlinked-cli/dist/harness/server.js --cwd /repo";

beforeEach(() => {
	for (const m of Object.values(mocks)) m.mockReset();
	vi.spyOn(process, "cwd").mockReturnValue("/repo");
	// Default: pid file exists pointing at ACTIVE_PID
	mocks.existsSync.mockImplementation((p: string | Buffer | URL) => {
		const path = String(p);
		if (path === "/repo/.interlinked/harness.pid") return true;
		return false;
	});
	mocks.readFileSync.mockImplementation((p: string | Buffer | URL) => {
		const path = String(p);
		if (path === "/repo/.interlinked/harness.pid") return String(ACTIVE_PID);
		return "";
	});
	// `ps` runs twice: once via collectAncestorPids (`ps -o pid=,ppid= -ax`),
	// once via the orphan scan (`ps -ax -o pid=,ppid=,command=`). Default
	// payloads: empty ancestor chain (so process.ppid resolves to nothing
	// extra), and three harness rows (two orphans + one active).
	mocks.execSync.mockImplementation((cmd: string) => {
		if (cmd.includes("pid=,ppid= -ax")) {
			// ancestor walk uses pid + ppid only
			return "";
		}
		// orphan scan
		return psPayload([
			{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD },
			{ pid: ORPHAN_B, ppid: 1, cmd: HARNESS_CMD },
			{ pid: ACTIVE_PID, ppid: 1, cmd: HARNESS_CMD },
		]);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("reapOrphanHarnesses helper (refactored to return candidates)", () => {
	it("dry-run: returns candidates without calling process.kill", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			const result = reapOrphanHarnesses("/repo", { dryRun: true });
			expect(result.dryRun).toBe(true);
			expect(result.killed).toEqual([]);
			expect(result.candidates.map((c) => c.pid).sort()).toEqual(
				[ORPHAN_A, ORPHAN_B].sort(),
			);
			expect(killSpy).not.toHaveBeenCalled();
		} finally {
			killSpy.mockRestore();
		}
	});

	it("non-dry-run: SIGTERMs each orphan candidate", () => {
		const sentSignals: Array<{ pid: number; signal: string | number }> = [];
		// reapOrphanHarnesses now polls `process.kill(pid, 0)` after SIGTERM
		// to confirm the daemon actually exited. The mock has to model that
		// transition (alive -> dead after the signal lands) or the poller spins
		// until the SIGKILL escalation grace window elapses and the test times
		// out. Track "dead" PIDs and throw ESRCH from existence checks.
		const dead = new Set<number>();
		const killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation(((pid: number, sig?: string | number): true => {
				if (sig === 0) {
					if (dead.has(pid)) {
						const err = new Error("ESRCH") as NodeJS.ErrnoException;
						err.code = "ESRCH";
						throw err;
					}
					return true;
				}
				sentSignals.push({ pid, signal: sig ?? 0 });
				if (sig === "SIGTERM" || sig === "SIGKILL") dead.add(pid);
				return true;
			}) as typeof process.kill);
		try {
			const result = reapOrphanHarnesses("/repo");
			expect(result.dryRun).toBe(false);
			expect(result.killed.sort()).toEqual([ORPHAN_A, ORPHAN_B].sort());
			expect(sentSignals).toEqual(
				expect.arrayContaining([
					{ pid: ORPHAN_A, signal: "SIGTERM" },
					{ pid: ORPHAN_B, signal: "SIGTERM" },
				]),
			);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("signals every orphan before waiting for any one of them to exit", () => {
		const events: Array<{ pid: number; kind: "term" | "post-signal-poll" }> = [];
		const signalled = new Set<number>();
		const killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation(((pid: number, sig?: string | number): true => {
				if (sig === 0) {
					// Authentication probes happen before SIGTERM and are not exit
					// polling. Record only probes made after this PID was signalled.
					if (signalled.has(pid)) events.push({ pid, kind: "post-signal-poll" });
					const err = new Error("ESRCH") as NodeJS.ErrnoException;
					if (signalled.has(pid)) {
						err.code = "ESRCH";
						throw err;
					}
					return true;
				}
				if (sig === "SIGTERM") {
					signalled.add(pid);
					events.push({ pid, kind: "term" });
				}
				return true;
			}) as typeof process.kill);
		try {
			const result = reapOrphanHarnesses("/repo");
			expect(result.killed.sort()).toEqual([ORPHAN_A, ORPHAN_B].sort());
			const firstPollIndex = events.findIndex((entry) => entry.kind === "post-signal-poll");
			expect(firstPollIndex).toBeGreaterThanOrEqual(2);
			expect(events.slice(0, firstPollIndex)).toEqual([
				{ pid: ORPHAN_A, kind: "term" },
				{ pid: ORPHAN_B, kind: "term" },
			]);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("does not report EPERM as killed or clear pid files", () => {
		const sentSignals: Array<{ pid: number; signal: string | number }> = [];
		const killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation(((pid: number, sig?: string | number): true => {
				sentSignals.push({ pid, signal: sig ?? 0 });
				const err = new Error("EPERM") as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}) as typeof process.kill);
		try {
			const result = reapOrphanHarnesses("/repo");
			expect(result.killed).toEqual([]);
			expect(sentSignals).toEqual(
				expect.arrayContaining([
					{ pid: ORPHAN_A, signal: "SIGTERM" },
					{ pid: ORPHAN_B, signal: "SIGTERM" },
				]),
			);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("treats EPERM from signal-0 polling as still alive", () => {
		const sentSignals: Array<{ pid: number; signal: string | number }> = [];
		let now = 1_000;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		const killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation(((pid: number, sig?: string | number): true => {
				sentSignals.push({ pid, signal: sig ?? 0 });
				if (sig === 0) {
					now += 5_000;
					const err = new Error("EPERM") as NodeJS.ErrnoException;
					err.code = "EPERM";
					throw err;
				}
				return true;
			}) as typeof process.kill);
		try {
			const result = reapOrphanHarnesses("/repo");
			expect(result.killed).toEqual([]);
			expect(sentSignals).toEqual(
				expect.arrayContaining([
					{ pid: ORPHAN_A, signal: "SIGTERM" },
					{ pid: ORPHAN_A, signal: "SIGKILL" },
					{ pid: ORPHAN_B, signal: "SIGTERM" },
					{ pid: ORPHAN_B, signal: "SIGKILL" },
				]),
			);
		} finally {
			killSpy.mockRestore();
			nowSpy.mockRestore();
		}
	});

	it("excludes the active daemon by default", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			const result = reapOrphanHarnesses("/repo", { dryRun: true });
			const pids = result.candidates.map((c) => c.pid);
			expect(pids).not.toContain(ACTIVE_PID);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("killAll mode includes the active daemon as a candidate", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			const result = reapOrphanHarnesses("/repo", { dryRun: true, killAll: true });
			const pids = result.candidates.map((c) => c.pid);
			expect(pids).toContain(ACTIVE_PID);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("excludes ancestor PIDs (would terminate the user's shell otherwise)", () => {
		// Use the REAL process.ppid as the ancestor under test. Node treats
		// process.ppid as effectively read-only at runtime even though its
		// property descriptor reports `configurable: true` — Object.defineProperty
		// silently no-ops, so we cannot synthesise a fake ancestor PID. Instead
		// we emit a `ps` payload where the real ppid coincides with a row that
		// also matches the harness command pattern, and assert it gets filtered.
		const realPpid = process.ppid;
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) {
				return `${realPpid} 1\n`;
			}
			return psPayload([
				{ pid: realPpid, ppid: 1, cmd: HARNESS_CMD },
				{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD },
			]);
		});
		const result = reapOrphanHarnesses("/repo", { dryRun: true });
		const pids = result.candidates.map((cand) => cand.pid);
		expect(pids).not.toContain(realPpid);
		expect(pids).toContain(ORPHAN_A);
	});

	it("returns empty when ps command fails", () => {
		mocks.execSync.mockImplementation(() => {
			throw new Error("ps not found");
		});
		const result = reapOrphanHarnesses("/repo", { dryRun: true });
		expect(result.candidates).toEqual([]);
		expect(result.killed).toEqual([]);
	});

	it("ignores process rows that are not interlinked harness daemons", () => {
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) return "";
			return psPayload([
				{ pid: 90000, ppid: 1, cmd: "node /tmp/some-other-server.js" },
				{ pid: 90001, ppid: 1, cmd: "python /home/x/script.py" },
				{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD },
			]);
		});
		const result = reapOrphanHarnesses("/repo", { dryRun: true });
		expect(result.candidates.map((c) => c.pid)).toEqual([ORPHAN_A]);
	});

	it("does NOT reap daemons bound to a different workspace cwd", () => {
		// Regression: prior behavior matched on the harness binary path alone,
		// which meant `interlinked harness start` in workspace A would SIGTERM
		// an active daemon serving workspace B. The fix scopes candidates by
		// their `--cwd` argument; a daemon whose cmdline records a different
		// cwd is left alone.
		const OTHER_WORKSPACE_PID = 80000;
		const OTHER_WORKSPACE_CMD =
			"node /home/u/interlinked-cli/dist/harness/server.js --cwd /other-repo";
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) return "";
			return psPayload([
				{ pid: OTHER_WORKSPACE_PID, ppid: 1, cmd: OTHER_WORKSPACE_CMD },
				{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD },
			]);
		});
		const result = reapOrphanHarnesses("/repo", { dryRun: true });
		const pids = result.candidates.map((c) => c.pid);
		expect(pids).not.toContain(OTHER_WORKSPACE_PID);
		expect(pids).toContain(ORPHAN_A);
	});

	it("does NOT reap legacy daemons whose cmdline lacks a --cwd argument", () => {
		// Defensive: an old daemon spawned without `--cwd` cannot be attributed
		// to any workspace. Reaping it from this workspace would risk killing
		// hooks the user still relies on. We err on the side of caution.
		const LEGACY_PID = 80001;
		const LEGACY_CMD =
			"node /home/u/interlinked-cli/dist/harness/server.js --verbose";
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) return "";
			return psPayload([
				{ pid: LEGACY_PID, ppid: 1, cmd: LEGACY_CMD },
				{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD },
			]);
		});
		const result = reapOrphanHarnesses("/repo", { dryRun: true });
		const pids = result.candidates.map((c) => c.pid);
		expect(pids).not.toContain(LEGACY_PID);
		expect(pids).toContain(ORPHAN_A);
	});
});

describe("harnessReapCommand — CLI surface", () => {
	it("default invocation runs as dry-run, prints PID list, never kills", async () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			const captured = await captureStdio(() => harnessReapCommand({}));
			expect(killSpy).not.toHaveBeenCalled();
			expect(captured.stdout).toMatch(/dry-run/i);
			expect(captured.stdout).toContain(String(ORPHAN_A));
			expect(captured.stdout).toContain(String(ORPHAN_B));
		} finally {
			killSpy.mockRestore();
		}
	});

	it("--force calls process.kill(pid, SIGTERM) for each orphan", async () => {
		const sent: Array<{ pid: number; signal: string | number }> = [];
		const dead = new Set<number>();
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((
			pid: number,
			sig?: string | number,
		): true => {
			if (sig === 0) {
				if (dead.has(pid)) {
					const err = new Error("ESRCH") as NodeJS.ErrnoException;
					err.code = "ESRCH";
					throw err;
				}
				return true;
			}
			sent.push({ pid, signal: sig ?? 0 });
			if (sig === "SIGTERM" || sig === "SIGKILL") dead.add(pid);
			return true;
		}) as typeof process.kill);
		try {
			await captureStdio(() => harnessReapCommand({ force: true }));
			const sentTermPids = sent
				.filter((e) => e.signal === "SIGTERM")
				.map((e) => e.pid)
				.sort();
			expect(sentTermPids).toEqual([ORPHAN_A, ORPHAN_B].sort());
		} finally {
			killSpy.mockRestore();
		}
	});

	it("--all --force also targets the active daemon", async () => {
		const sent: number[] = [];
		// Model process death after SIGTERM so the post-signal exit-poll
		// (added when reap learned to verify, escalate to SIGKILL, then clean
		// stale pid files) doesn't time out waiting for the mock process to
		// "exit". Any signalled PID is marked dead; existence checks throw
		// ESRCH from then on.
		const dead = new Set<number>();
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((
			pid: number,
			sig?: string | number,
		): true => {
			if (sig === 0) {
				if (dead.has(pid)) {
					const err = new Error("ESRCH") as NodeJS.ErrnoException;
					err.code = "ESRCH";
					throw err;
				}
				return true;
			}
			if (sig === "SIGTERM") sent.push(pid);
			if (sig === "SIGTERM" || sig === "SIGKILL") dead.add(pid);
			return true;
		}) as typeof process.kill);
		try {
			await captureStdio(() => harnessReapCommand({ force: true, all: true }));
			expect(sent).toContain(ACTIVE_PID);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("--json emits a structured payload", async () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			const captured = await captureStdio(() =>
				harnessReapCommand({ json: true }),
			);
			const parsed = JSON.parse(captured.stdout) as {
				dry_run: boolean;
				candidates: Array<{ pid: number }>;
				killed: number[];
			};
			expect(parsed.dry_run).toBe(true);
			expect(parsed.candidates.map((c) => c.pid).sort()).toEqual(
				[ORPHAN_A, ORPHAN_B].sort(),
			);
			expect(parsed.killed).toEqual([]);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("reports zero orphans cleanly when nothing matches", async () => {
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) return "";
			return ""; // no harness rows at all
		});
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			const captured = await captureStdio(() => harnessReapCommand({}));
			expect(captured.stdout).toMatch(/0\b|no orphan/i);
			expect(killSpy).not.toHaveBeenCalled();
		} finally {
			killSpy.mockRestore();
		}
	});
});
