// ===========================================
// harness-process — companion behavioral tests
// ===========================================
// Drives every exported helper plus the internal orphan-selection /
// termination / pid-file-cleanup / stale-dist machinery through a fully
// mocked `node:fs` + `node:child_process` surface. The mock is backed by a
// tiny in-memory filesystem so existence, contents, and mtimes can be staged
// per case without touching the real disk (which matters: `getHarnessServerPath`
// and `ensureDistFresh` resolve paths relative to the real repo otherwise).
//
// `process.kill` is spied in the reap/liveness cases so no real signal is ever
// delivered. Coverage target: ~100% line+branch of harness-process.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -----------------------------------------------------------------------------
// In-memory filesystem backing the node:fs mock
// -----------------------------------------------------------------------------
const vfs = vi.hoisted(() => {
	const files = new Map<string, { content: string; mtimeMs: number }>();
	return {
		files,
		reset(): void {
			files.clear();
		},
	};
});

const mocks = vi.hoisted(() => ({
	execSync: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execSync: mocks.execSync,
	spawn: mocks.spawn,
}));

vi.mock("../harness/daemon-process-identity.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../harness/daemon-process-identity.js")>();
	return { ...actual, readHarnessProcessIdentity: vi.fn((_cwd: string, pid: number) => `id:${pid}`) };
});

vi.mock("node:fs", () => {
	const enoent = (p: string): NodeJS.ErrnoException => {
		const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, '${p}'`);
		err.code = "ENOENT";
		return err;
	};
	return {
		existsSync: (p: string | URL): boolean => vfs.files.has(String(p)),
		readFileSync: (p: string | URL, encoding?: unknown): string | Buffer => {
			const f = vfs.files.get(String(p));
			if (!f) throw enoent(String(p));
			// Match node:fs semantics: an encoding (string or { encoding })
			// returns a string; no encoding returns a Buffer. The source's
			// readDaemonStderrLog relies on the Buffer path (`.subarray(...)`).
			if (encoding === undefined || encoding === null) return Buffer.from(f.content, "utf-8");
			return f.content;
		},
		statSync: (p: string | URL): { size: number; mtimeMs: number } => {
			const f = vfs.files.get(String(p));
			if (!f) throw enoent(String(p));
			return { size: Buffer.byteLength(f.content, "utf-8"), mtimeMs: f.mtimeMs };
		},
		mkdirSync: (p: string | URL): undefined => {
			vfs.files.set(String(p), { content: "", mtimeMs: 0 });
			return undefined;
		},
		readdirSync: (p: string | URL): string[] => {
			const dir = String(p).replace(/\/+$/, "");
			const out = new Set<string>();
			for (const key of vfs.files.keys()) {
				if (key.startsWith(`${dir}/`)) {
					const rest = key.slice(dir.length + 1);
					if (!rest.includes("/")) out.add(rest);
				}
			}
			return [...out];
		},
		rmSync: (p: string | URL): undefined => {
			vfs.files.delete(String(p));
			return undefined;
		},
		unlinkSync: (p: string | URL): undefined => {
			vfs.files.delete(String(p));
			return undefined;
		},
		openSync: (p: string | URL): number => {
			if (!vfs.files.has(String(p))) vfs.files.set(String(p), { content: "", mtimeMs: 0 });
			return 4242;
		},
		closeSync: (_fd: number): undefined => undefined,
		writeFileSync: (p: string | URL, data: string): undefined => {
			vfs.files.set(String(p), { content: String(data), mtimeMs: 0 });
			return undefined;
		},
	};
});

import {
	closeDaemonStderrLog,
	collectAncestorPids,
	type DaemonStderrLog,
	ensureDistFresh,
	getFramedSocketPath,
	getHarnessServerPath,
	getPidPath,
	getSocketPath,
	isHarnessRunning,
	openDaemonStderrLog,
	readActiveHarnessPid,
	readDaemonStderrLog,
	reapOrphanHarnesses,
} from "./harness-process.js";

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------
const CWD = "/repo";
const PID_FILE = "/repo/.interlinked/harness.pid";

function setFile(path: string, content: string, mtimeMs = 0): void {
	vfs.files.set(path, { content, mtimeMs });
}

function psPayload(rows: Array<{ pid: number; ppid: number; cmd: string }>): string {
	return rows.map((r) => `${r.pid} ${r.ppid} ${r.cmd}`).join("\n");
}

const HARNESS_CMD = `node /home/u/interlinked-cli/dist/harness/server.js --cwd ${CWD}`;

beforeEach(() => {
	vfs.reset();
	mocks.execSync.mockReset();
	mocks.spawn.mockReset();
	vi.spyOn(process, "cwd").mockReturnValue(CWD);
	// Default execSync: empty ancestor walk, empty orphan scan. Individual
	// tests override as needed.
	mocks.execSync.mockImplementation((cmd: string) => {
		if (cmd.includes("pid=,ppid= -ax")) return "";
		return "";
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// =============================================================================
// Path helpers
// =============================================================================
describe("harness-process — path helpers", () => {
	it("getSocketPath joins the config dir with harness.sock", () => {
		expect(getSocketPath(CWD)).toBe("/repo/.interlinked/harness.sock");
	});

	it("getSocketPath defaults to process.cwd()", () => {
		expect(getSocketPath()).toBe("/repo/.interlinked/harness.sock");
	});

	it("getPidPath joins the config dir with harness.pid", () => {
		expect(getPidPath(CWD)).toBe(PID_FILE);
	});

	it("getFramedSocketPath coalesces an undefined session id to the default front door", () => {
		// `sessionId || "default"` → "default" → framed default socket
		// (NOT the legacy harness.sock — that only happens when daemonPathsFor
		// is called with no session id at all).
		expect(getFramedSocketPath(CWD, undefined)).toBe("/repo/.interlinked/harness-default.sock");
	});

	it("getFramedSocketPath returns a per-session socket for a named session", () => {
		expect(getFramedSocketPath(CWD, "sess-A1")).toBe("/repo/.interlinked/harness-sess-A1.sock");
	});

	it("getFramedSocketPath treats an empty string session id as the default front door", () => {
		// Empty string is falsy → coalesces to "default" → framed default socket.
		expect(getFramedSocketPath(CWD, "")).toBe("/repo/.interlinked/harness-default.sock");
	});
});

// =============================================================================
// readActiveHarnessPid
// =============================================================================
describe("harness-process — readActiveHarnessPid", () => {
	it("returns null when no pid file exists", () => {
		expect(readActiveHarnessPid(CWD)).toBeNull();
	});

	it("returns null for a non-numeric pid file", () => {
		setFile(PID_FILE, "not-a-number");
		expect(readActiveHarnessPid(CWD)).toBeNull();
	});

	it("returns the parsed pid for a valid pid file", () => {
		setFile(PID_FILE, "  12345 \n");
		expect(readActiveHarnessPid(CWD)).toBe(12345);
	});

	it("returns null when reading the pid file throws", () => {
		// File reports existing but read throws — exercises the catch branch.
		setFile(PID_FILE, "999");
		const spy = vi.spyOn(vfs.files, "get").mockImplementationOnce(() => {
			throw new Error("EACCES");
		});
		try {
			expect(readActiveHarnessPid(CWD)).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});
});

// =============================================================================
// isHarnessRunning
// =============================================================================
describe("harness-process — isHarnessRunning", () => {
	it("reports not running when no pid file exists", () => {
		expect(isHarnessRunning(CWD)).toEqual({ running: false });
	});

	it("reports not running for a NaN pid file", () => {
		setFile(PID_FILE, "garbage");
		expect(isHarnessRunning(CWD)).toEqual({ running: false });
	});

	it("reports running when the pid is alive (signal 0 succeeds)", () => {
		setFile(PID_FILE, "4321");
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		try {
			expect(isHarnessRunning(CWD)).toEqual({ running: true, pid: 4321 });
			expect(killSpy).toHaveBeenCalledWith(4321, 0);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("cleans up the stale pid file and reports not running when signal 0 throws", () => {
		setFile(PID_FILE, "4321");
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("ESRCH");
		});
		try {
			expect(isHarnessRunning(CWD)).toEqual({ running: false });
			// Stale pid file removed.
			expect(vfs.files.has(PID_FILE)).toBe(false);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("swallows unlink failure while cleaning a stale pid file", () => {
		setFile(PID_FILE, "4321");
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("ESRCH");
		});
		// Make the unlink (delete) throw to exercise the inner best-effort catch.
		const delSpy = vi.spyOn(vfs.files, "delete").mockImplementationOnce(() => {
			throw new Error("EBUSY");
		});
		try {
			expect(isHarnessRunning(CWD)).toEqual({ running: false });
		} finally {
			killSpy.mockRestore();
			delSpy.mockRestore();
		}
	});

	it("defaults cwd to process.cwd() when called with no argument", () => {
		// No pid file under /repo → not running, but the call must resolve a path.
		expect(isHarnessRunning().running).toBe(false);
	});
});

// =============================================================================
// collectAncestorPids
// =============================================================================
describe("harness-process — collectAncestorPids", () => {
	it("always includes the current pid and parent pid", () => {
		const pids = collectAncestorPids();
		expect(pids.has(process.pid)).toBe(true);
		if (process.ppid) expect(pids.has(process.ppid)).toBe(true);
	});

	it("walks the parent chain from the ps table up to the root", () => {
		// Build a chain: ppid -> 500 -> 400 -> 1. The walk should add 500 and 400.
		const ppid = process.ppid || 999;
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) {
				return [`${ppid} 500`, "500 400", "400 1", "9999 8888"].join("\n");
			}
			return "";
		});
		const pids = collectAncestorPids();
		expect(pids.has(500)).toBe(true);
		expect(pids.has(400)).toBe(true);
		// Unrelated branch not walked.
		expect(pids.has(9999)).toBe(false);
	});

	it("returns the base set when ps fails", () => {
		mocks.execSync.mockImplementation(() => {
			throw new Error("ps unavailable");
		});
		const pids = collectAncestorPids();
		expect(pids.has(process.pid)).toBe(true);
	});

	it("stops the walk when a parent resolves to <= 1", () => {
		const ppid = process.ppid || 777;
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) {
				// ppid's parent is 1 → loop breaks immediately after adding ppid.
				return `${ppid} 1\n`;
			}
			return "";
		});
		const pids = collectAncestorPids();
		expect(pids.has(ppid)).toBe(true);
	});
});

// =============================================================================
// reapOrphanHarnesses — selection + termination + pid-file cleanup
// =============================================================================
describe("harness-process — reapOrphanHarnesses", () => {
	const ORPHAN_A = 50001;
	const ORPHAN_B = 50002;
	const ACTIVE = 60000;

	function stageScan(rows: Array<{ pid: number; ppid: number; cmd: string }>): void {
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) return "";
			return psPayload(rows);
		});
	}

	it("dry-run returns candidates without signalling", () => {
		setFile(PID_FILE, String(ACTIVE));
		stageScan([
			{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD },
			{ pid: ORPHAN_B, ppid: 1, cmd: HARNESS_CMD },
			{ pid: ACTIVE, ppid: 1, cmd: HARNESS_CMD },
		]);
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		try {
			const result = reapOrphanHarnesses(CWD, { dryRun: true });
			expect(result.dryRun).toBe(true);
			expect(result.killed).toEqual([]);
			// Active daemon excluded by default.
			expect(result.candidates.map((c) => c.pid).sort()).toEqual([ORPHAN_A, ORPHAN_B]);
			expect(killSpy).not.toHaveBeenCalled();
		} finally {
			killSpy.mockRestore();
		}
	});

	it("returns an empty result when ps throws", () => {
		mocks.execSync.mockImplementation(() => {
			throw new Error("ps not found");
		});
		const result = reapOrphanHarnesses(CWD, { dryRun: true });
		expect(result).toEqual({ candidates: [], killed: [], dryRun: true });
	});

	it("returns empty when execSync yields a non-string (defensive)", () => {
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) return "";
			return undefined;
		});
		const result = reapOrphanHarnesses(CWD, { dryRun: true });
		expect(result.candidates).toEqual([]);
	});

	it("live reap SIGTERMs each orphan, clears pid files, and writes a stderr summary", () => {
		setFile(PID_FILE, String(ACTIVE));
		// Per-orphan pid files that must be cleaned after the kill.
		setFile("/repo/.interlinked/harness-a.pid", String(ORPHAN_A));
		setFile("/repo/.interlinked/harness-a.sock", "");
		stageScan([
			{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD },
			{ pid: ORPHAN_B, ppid: 1, cmd: HARNESS_CMD },
		]);
		const sent: Array<{ pid: number; sig: string | number }> = [];
		const dead = new Set<number>();
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((
			pid: number,
			sig?: string | number,
		): true => {
			if (sig === 0) {
				if (dead.has(pid)) {
					const e: NodeJS.ErrnoException = new Error("ESRCH");
					e.code = "ESRCH";
					throw e;
				}
				return true;
			}
			sent.push({ pid, sig: sig ?? 0 });
			if (sig === "SIGTERM" || sig === "SIGKILL") dead.add(pid);
			return true;
		}));
		const stderrChunks: string[] = [];
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(((chunk: string | Uint8Array): boolean => {
				stderrChunks.push(String(chunk));
				return true;
			}));
		try {
			const result = reapOrphanHarnesses(CWD);
			expect(result.dryRun).toBe(false);
			expect(result.killed.sort()).toEqual([ORPHAN_A, ORPHAN_B]);
			expect(
				sent
					.filter((s) => s.sig === "SIGTERM")
					.map((s) => s.pid)
					.sort(),
			).toEqual([ORPHAN_A, ORPHAN_B]);
			// Orphan-A's pid + sock files cleared (its pid was killed).
			expect(vfs.files.has("/repo/.interlinked/harness-a.pid")).toBe(false);
			expect(vfs.files.has("/repo/.interlinked/harness-a.sock")).toBe(false);
			// stderr summary mentions the reaped count.
			expect(stderrChunks.join("")).toMatch(/Reaped 2 orphan harness daemons/);
		} finally {
			killSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it("singular wording when exactly one orphan is reaped", () => {
		setFile(PID_FILE, String(ACTIVE));
		stageScan([{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD }]);
		const dead = new Set<number>();
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((
			pid: number,
			sig?: string | number,
		): true => {
			if (sig === 0) {
				if (dead.has(pid)) {
					const e: NodeJS.ErrnoException = new Error("ESRCH");
					e.code = "ESRCH";
					throw e;
				}
				return true;
			}
			if (sig === "SIGTERM" || sig === "SIGKILL") dead.add(pid);
			return true;
		}));
		const chunks: string[] = [];
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(((chunk: string | Uint8Array): boolean => {
				chunks.push(String(chunk));
				return true;
			}));
		try {
			reapOrphanHarnesses(CWD);
			expect(chunks.join("")).toMatch(/Reaped 1 orphan harness daemon:/);
			expect(chunks.join("")).not.toMatch(/daemons/);
		} finally {
			killSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it("escalates SIGTERM survivors to SIGKILL", () => {
		setFile(PID_FILE, String(ACTIVE));
		stageScan([{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD }]);
		const sent: Array<{ pid: number; sig: string | number }> = [];
		let now = 1000;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((
			pid: number,
			sig?: string | number,
		): true => {
			sent.push({ pid, sig: sig ?? 0 });
			if (sig === 0) {
				// Always still alive → push time past the grace window so the
				// poll loop exits and SIGKILL is issued. After SIGKILL we let it die.
				if (sent.some((s) => s.pid === pid && s.sig === "SIGKILL")) {
					const e: NodeJS.ErrnoException = new Error("ESRCH");
					e.code = "ESRCH";
					throw e;
				}
				now += 5000;
				return true;
			}
			return true;
		}));
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			reapOrphanHarnesses(CWD);
			const sigs = sent.filter((s) => s.pid === ORPHAN_A).map((s) => s.sig);
			expect(sigs).toContain("SIGTERM");
			expect(sigs).toContain("SIGKILL");
		} finally {
			killSpy.mockRestore();
			nowSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it("treats ESRCH at SIGKILL time as reaped (dies between TERM grace and KILL)", () => {
		setFile(PID_FILE, String(ACTIVE));
		stageScan([{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD }]);
		const sent: Array<string | number> = [];
		let now = 1000;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((
			_pid: number,
			sig?: string | number,
		): true => {
			sent.push(sig ?? 0);
			if (sig === 0) {
				// Report alive and push time past the TERM grace so the poll loop
				// gives up and the code escalates to SIGKILL...
				now += 5000;
				return true;
			}
			if (sig === "SIGKILL") {
				// ...but the SIGKILL itself races a natural exit → ESRCH, which
				// counts as reaped (the L266 catch branch).
				const e: NodeJS.ErrnoException = new Error("ESRCH");
				e.code = "ESRCH";
				throw e;
			}
			return true;
		}));
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const result = reapOrphanHarnesses(CWD);
			expect(sent).toContain("SIGKILL");
			expect(result.killed).toEqual([ORPHAN_A]);
		} finally {
			killSpy.mockRestore();
			nowSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it("detects a process that exits exactly as the grace deadline passes", () => {
		// Exercise the post-loop reconciliation sweep in waitForProcessesExit:
		// the while-loop body sees the pid alive (advancing time past the
		// deadline so the loop condition fails), then the trailing for-loop
		// re-polls and finds it gone → marks it exited without a SIGKILL.
		setFile(PID_FILE, String(ACTIVE));
		stageScan([{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD }]);
		const sent: Array<string | number> = [];
		let now = 1000;
		let pollCount = 0;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((
			_pid: number,
			sig?: string | number,
		): true => {
			sent.push(sig ?? 0);
			if (sig === 0) {
				pollCount += 1;
				if (pollCount === 1) {
					// First in-loop poll: alive, but jump time past the deadline so
					// the while condition is false on the next check.
					now += 10_000;
					return true;
				}
				// Trailing post-loop poll: process is now gone.
				const e: NodeJS.ErrnoException = new Error("ESRCH");
				e.code = "ESRCH";
				throw e;
			}
			return true;
		}));
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const result = reapOrphanHarnesses(CWD);
			// Killed via the deadline-sweep, never escalated to SIGKILL.
			expect(result.killed).toEqual([ORPHAN_A]);
			expect(sent).not.toContain("SIGKILL");
		} finally {
			killSpy.mockRestore();
			nowSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it("does not mark a non-ESRCH (EPERM) SIGTERM failure as reaped", () => {
		// A permission error at SIGTERM time is NOT 'already gone' → the pid is
		// neither added to termSent nor counted as killed (L247 if-false branch).
		setFile(PID_FILE, String(ACTIVE));
		stageScan([{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD }]);
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((
			_pid: number,
			sig?: string | number,
		): true => {
			if (sig === "SIGTERM") {
				const e: NodeJS.ErrnoException = new Error("EPERM");
				e.code = "EPERM";
				throw e;
			}
			return true;
		}));
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const result = reapOrphanHarnesses(CWD);
			expect(result.killed).toEqual([]);
		} finally {
			killSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it("does not mark a non-ESRCH (EPERM) SIGKILL failure as reaped", () => {
		// TERM lands, the daemon survives the grace window, SIGKILL then fails
		// with EPERM (not ESRCH) → the L266 if-false branch: not counted killed.
		setFile(PID_FILE, String(ACTIVE));
		stageScan([{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD }]);
		let now = 1000;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((
			_pid: number,
			sig?: string | number,
		): true => {
			if (sig === 0) {
				// Always alive; jump past the grace window to force SIGKILL.
				now += 5000;
				return true;
			}
			if (sig === "SIGKILL") {
				const e: NodeJS.ErrnoException = new Error("EPERM");
				e.code = "EPERM";
				throw e;
			}
			return true; // SIGTERM ok
		}));
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const result = reapOrphanHarnesses(CWD);
			expect(result.killed).toEqual([]);
		} finally {
			killSpy.mockRestore();
			nowSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it("de-duplicates a pid that the ps table lists twice (both already gone)", () => {
		// Two ps rows share one pid; SIGTERM throws ESRCH for both → markKilled is
		// invoked twice for the same pid, exercising the dedup guard so `killed`
		// still reports the pid exactly once.
		setFile(PID_FILE, String(ACTIVE));
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) return "";
			return psPayload([
				{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD },
				{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD },
			]);
		});
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((
			_pid: number,
			sig?: string | number,
		): true => {
			if (sig === "SIGTERM") {
				const e: NodeJS.ErrnoException = new Error("ESRCH");
				e.code = "ESRCH";
				throw e;
			}
			return true;
		}));
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const result = reapOrphanHarnesses(CWD);
			expect(result.killed).toEqual([ORPHAN_A]);
		} finally {
			killSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it("treats ESRCH at SIGTERM time as already-reaped (no kill needed)", () => {
		setFile(PID_FILE, String(ACTIVE));
		stageScan([{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD }]);
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((
			_pid: number,
			sig?: string | number,
		): true => {
			if (sig === "SIGTERM") {
				const e: NodeJS.ErrnoException = new Error("ESRCH");
				e.code = "ESRCH";
				throw e;
			}
			return true;
		}));
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const result = reapOrphanHarnesses(CWD);
			expect(result.killed).toEqual([ORPHAN_A]);
		} finally {
			killSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it("does not mark EPERM-at-SIGTERM as killed and writes no summary", () => {
		setFile(PID_FILE, String(ACTIVE));
		stageScan([{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD }]);
		let now = 1000;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((
			_pid: number,
			sig?: string | number,
		): true => {
			if (sig === 0) {
				now += 5000;
				const e: NodeJS.ErrnoException = new Error("EPERM");
				e.code = "EPERM";
				throw e;
			}
			// SIGTERM/SIGKILL succeed but the process never dies (EPERM on poll).
			return true;
		}));
		const chunks: string[] = [];
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(((chunk: string | Uint8Array): boolean => {
				chunks.push(String(chunk));
				return true;
			}));
		try {
			const result = reapOrphanHarnesses(CWD);
			expect(result.killed).toEqual([]);
			expect(chunks.join("")).not.toMatch(/Reaped/);
		} finally {
			killSpy.mockRestore();
			nowSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it("killAll mode includes the active daemon as a candidate", () => {
		setFile(PID_FILE, String(ACTIVE));
		stageScan([
			{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD },
			{ pid: ACTIVE, ppid: 1, cmd: HARNESS_CMD },
		]);
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		try {
			const result = reapOrphanHarnesses(CWD, { dryRun: true, killAll: true });
			expect(result.candidates.map((c) => c.pid)).toContain(ACTIVE);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("skips the current process pid", () => {
		stageScan([{ pid: process.pid, ppid: 1, cmd: HARNESS_CMD }]);
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		try {
			const result = reapOrphanHarnesses(CWD, { dryRun: true });
			expect(result.candidates.map((c) => c.pid)).not.toContain(process.pid);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("ignores non-harness rows, header residue, and NaN pids", () => {
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) return "";
			return [
				"PID PPID COMMAND", // header residue → parsePsRow returns null
				"", // blank
				"90000 1 node /tmp/other-server.js", // not a harness path
				"90001 1 python script.py", // no node/bun
				"90002 1 bun /x/interlinked-cli/dist/harness/server.js", // bun + harness but no --cwd
				psPayload([{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD }]),
			].join("\n");
		});
		const result = reapOrphanHarnesses(CWD, { dryRun: true });
		expect(result.candidates.map((c) => c.pid)).toEqual([ORPHAN_A]);
	});

	it("scopes by --cwd: a daemon in another workspace is left alone", () => {
		const OTHER = 80000;
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) return "";
			return psPayload([
				{
					pid: OTHER,
					ppid: 1,
					cmd: "node /h/interlinked-cli/dist/harness/server.js --cwd /other-repo",
				},
				{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD },
			]);
		});
		const result = reapOrphanHarnesses(CWD, { dryRun: true });
		const pids = result.candidates.map((c) => c.pid);
		expect(pids).not.toContain(OTHER);
		expect(pids).toContain(ORPHAN_A);
	});

	it("accepts the --cwd=<path> equals form as the last token", () => {
		const EQ = 80010;
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) return "";
			return psPayload([
				{
					pid: EQ,
					ppid: 1,
					cmd: `node /h/interlinked-cli/dist/harness/server.js --cwd=${CWD}`,
				},
			]);
		});
		const result = reapOrphanHarnesses(CWD, { dryRun: true });
		expect(result.candidates.map((c) => c.pid)).toEqual([EQ]);
	});

	it("skips legacy daemons whose cmdline lacks --cwd", () => {
		const LEGACY = 80001;
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) return "";
			return psPayload([
				{ pid: LEGACY, ppid: 1, cmd: "node /h/interlinked-cli/dist/harness/server.js --verbose" },
				{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD },
			]);
		});
		const result = reapOrphanHarnesses(CWD, { dryRun: true });
		expect(result.candidates.map((c) => c.pid)).toEqual([ORPHAN_A]);
	});

	it("skips a daemon whose --cwd flag has no following value", () => {
		// `--cwd` is the LAST token → tokens[i + 1] is undefined → `?? null` →
		// extractCwdArg returns null → candidate skipped (the valueless-flag branch).
		const DANGLING = 80002;
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) return "";
			return psPayload([
				{ pid: DANGLING, ppid: 1, cmd: "node /h/interlinked-cli/dist/harness/server.js --cwd" },
				{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD },
			]);
		});
		const result = reapOrphanHarnesses(CWD, { dryRun: true });
		const pids = result.candidates.map((c) => c.pid);
		expect(pids).not.toContain(DANGLING);
		expect(pids).toContain(ORPHAN_A);
	});

	it("excludes ancestor pids even when they match the harness pattern", () => {
		const realPpid = process.ppid || 999;
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) return `${realPpid} 1\n`;
			return psPayload([
				{ pid: realPpid, ppid: 1, cmd: HARNESS_CMD },
				{ pid: ORPHAN_A, ppid: 1, cmd: HARNESS_CMD },
			]);
		});
		const result = reapOrphanHarnesses(CWD, { dryRun: true });
		const pids = result.candidates.map((c) => c.pid);
		expect(pids).not.toContain(realPpid);
		expect(pids).toContain(ORPHAN_A);
	});
});

// =============================================================================
// clearOrphanedPidFiles (exercised via live reap) edge cases
// =============================================================================
describe("harness-process — pid-file cleanup edge cases", () => {
	const ORPHAN = 51000;
	const ACTIVE = 61000;

	function liveReapOneOrphan(): void {
		mocks.execSync.mockImplementation((cmd: string) => {
			if (cmd.includes("pid=,ppid= -ax")) return "";
			return psPayload([{ pid: ORPHAN, ppid: 1, cmd: HARNESS_CMD }]);
		});
	}

	function deadOnSigtermKill(): ReturnType<typeof vi.spyOn> {
		const dead = new Set<number>();
		return vi.spyOn(process, "kill").mockImplementation(((
			pid: number,
			sig?: string | number,
		): true => {
			if (sig === 0) {
				if (dead.has(pid)) {
					const e: NodeJS.ErrnoException = new Error("ESRCH");
					e.code = "ESRCH";
					throw e;
				}
				return true;
			}
			if (sig === "SIGTERM" || sig === "SIGKILL") dead.add(pid);
			return true;
		}));
	}

	it("skips pid files whose content does not match a killed pid", () => {
		setFile(PID_FILE, String(ACTIVE));
		setFile("/repo/.interlinked/harness-other.pid", "999999"); // not killed
		liveReapOneOrphan();
		const killSpy = deadOnSigtermKill();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			reapOrphanHarnesses(CWD);
			// Unrelated pid file untouched.
			expect(vfs.files.has("/repo/.interlinked/harness-other.pid")).toBe(true);
		} finally {
			killSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it("skips pid files with non-numeric content", () => {
		setFile(PID_FILE, String(ACTIVE));
		setFile("/repo/.interlinked/harness-junk.pid", "not-a-pid");
		liveReapOneOrphan();
		const killSpy = deadOnSigtermKill();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			reapOrphanHarnesses(CWD);
			expect(vfs.files.has("/repo/.interlinked/harness-junk.pid")).toBe(true);
		} finally {
			killSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it("cleans a matching harness-<id>.pid even when no sibling sock exists", () => {
		setFile(PID_FILE, String(ACTIVE));
		setFile("/repo/.interlinked/harness-x.pid", String(ORPHAN));
		// No harness-x.sock present → existsSync(sock) false branch.
		liveReapOneOrphan();
		const killSpy = deadOnSigtermKill();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			reapOrphanHarnesses(CWD);
			expect(vfs.files.has("/repo/.interlinked/harness-x.pid")).toBe(false);
		} finally {
			killSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it("returns gracefully when the .interlinked directory cannot be read", async () => {
		setFile(PID_FILE, String(ACTIVE));
		liveReapOneOrphan();
		const killSpy = deadOnSigtermKill();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const fs = await import("node:fs");
		const readdirSpy = vi.spyOn(fs, "readdirSync").mockImplementation(() => {
			throw new Error("ENOTDIR");
		});
		try {
			const result = reapOrphanHarnesses(CWD);
			// Kill still succeeded; cleanup just no-ops.
			expect(result.killed).toEqual([ORPHAN]);
		} finally {
			killSpy.mockRestore();
			stderrSpy.mockRestore();
			readdirSpy.mockRestore();
		}
	});

	it("skips a candidate pid file that cannot be read", async () => {
		setFile(PID_FILE, String(ACTIVE));
		setFile("/repo/.interlinked/harness-unreadable.pid", String(ORPHAN));
		liveReapOneOrphan();
		const killSpy = deadOnSigtermKill();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const fs = await import("node:fs");
		const origRead = fs.readFileSync;
		const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
			const [p] = args;
			if (String(p) === "/repo/.interlinked/harness-unreadable.pid") {
				throw new Error("EACCES");
			}
			return origRead(...args);
		});
		try {
			reapOrphanHarnesses(CWD);
			// Unreadable file left in place (the read-failure continue branch).
			expect(vfs.files.has("/repo/.interlinked/harness-unreadable.pid")).toBe(true);
		} finally {
			killSpy.mockRestore();
			stderrSpy.mockRestore();
			readSpy.mockRestore();
		}
	});

	it("swallows rmSync failure when clearing a matched pid file", async () => {
		setFile(PID_FILE, String(ACTIVE));
		setFile("/repo/.interlinked/harness-y.pid", String(ORPHAN));
		setFile("/repo/.interlinked/harness-y.sock", "");
		liveReapOneOrphan();
		const killSpy = deadOnSigtermKill();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const fs = await import("node:fs");
		const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => {
			throw new Error("EBUSY");
		});
		try {
			// Both the pid rm and the sock rm throw; both catch branches taken.
			const result = reapOrphanHarnesses(CWD);
			expect(result.killed).toEqual([ORPHAN]);
		} finally {
			killSpy.mockRestore();
			stderrSpy.mockRestore();
			rmSpy.mockRestore();
		}
	});
});

// =============================================================================
// Daemon stderr log helpers
// =============================================================================
describe("harness-process — daemon stderr log", () => {
	const LOG_PATH = "/repo/.interlinked/logs/daemon.log";

	it("openDaemonStderrLog creates the dir and returns a zero offset for a fresh log", () => {
		const log = openDaemonStderrLog(CWD);
		expect(log).not.toBeNull();
		expect(log?.path).toBe(LOG_PATH);
		expect(log?.startOffset).toBe(0);
		expect(log?.fd).toBe(4242);
		// Directory was created.
		expect(vfs.files.has("/repo/.interlinked/logs")).toBe(true);
	});

	it("openDaemonStderrLog records the existing size as the start offset", () => {
		setFile("/repo/.interlinked/logs", ""); // dir already present
		setFile(LOG_PATH, "previous contents\n");
		const log = openDaemonStderrLog(CWD);
		expect(log?.startOffset).toBe(Buffer.byteLength("previous contents\n", "utf-8"));
	});

	it("openDaemonStderrLog returns null when openSync throws", async () => {
		const fs = await import("node:fs");
		const openSpy = vi.spyOn(fs, "openSync").mockImplementation(() => {
			throw new Error("EMFILE");
		});
		try {
			expect(openDaemonStderrLog(CWD)).toBeNull();
		} finally {
			openSpy.mockRestore();
		}
	});

	it("readDaemonStderrLog returns only the bytes appended after the start offset", () => {
		const before = "header line\n";
		setFile(LOG_PATH, before);
		const log: DaemonStderrLog = {
			fd: 1,
			path: LOG_PATH,
			startOffset: Buffer.byteLength(before, "utf-8"),
		};
		setFile(LOG_PATH, `${before}new tail line\n`);
		expect(readDaemonStderrLog(log)).toBe("new tail line\n");
	});

	it("readDaemonStderrLog returns empty string for a null log", () => {
		expect(readDaemonStderrLog(null)).toBe("");
	});

	it("readDaemonStderrLog returns empty string when the read throws", () => {
		const log: DaemonStderrLog = {
			fd: 1,
			path: "/repo/.interlinked/logs/missing.log",
			startOffset: 0,
		};
		// File absent → readFileSync throws ENOENT → caught → "".
		expect(readDaemonStderrLog(log)).toBe("");
	});

	it("closeDaemonStderrLog no-ops for a null log", async () => {
		const fs = await import("node:fs");
		const closeSpy = vi.spyOn(fs, "closeSync");
		try {
			expect(() => closeDaemonStderrLog(null)).not.toThrow();
			expect(closeSpy).not.toHaveBeenCalled();
		} finally {
			closeSpy.mockRestore();
		}
	});

	it("closeDaemonStderrLog closes a real fd", async () => {
		const fs = await import("node:fs");
		const closeSpy = vi.spyOn(fs, "closeSync");
		try {
			closeDaemonStderrLog({ fd: 99, path: LOG_PATH, startOffset: 0 });
			expect(closeSpy).toHaveBeenCalledWith(99);
		} finally {
			closeSpy.mockRestore();
		}
	});

	it("closeDaemonStderrLog swallows a closeSync error", async () => {
		const fs = await import("node:fs");
		const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation(() => {
			throw new Error("EBADF");
		});
		try {
			expect(() => closeDaemonStderrLog({ fd: 7, path: LOG_PATH, startOffset: 0 })).not.toThrow();
			expect(closeSpy).toHaveBeenCalledWith(7);
		} finally {
			closeSpy.mockRestore();
		}
	});
});

// =============================================================================
// getHarnessServerPath
// =============================================================================
describe("harness-process — getHarnessServerPath", () => {
	it("returns the first existing candidate", () => {
		// Candidate #4 is cwd-relative dist/harness/server.js — stage only that.
		setFile("/repo/dist/harness/server.js", "compiled");
		const p = getHarnessServerPath();
		expect(p).toBe("/repo/dist/harness/server.js");
	});

	it("resolves the cli/dist candidate when only it exists", () => {
		setFile("/repo/cli/dist/harness/server.js", "compiled");
		const p = getHarnessServerPath();
		expect(p).toBe("/repo/cli/dist/harness/server.js");
	});

	it("falls back to the precompiled binary candidate", () => {
		setFile("/repo/.interlinked/harness-server", "binary");
		const p = getHarnessServerPath();
		expect(p).toBe("/repo/.interlinked/harness-server");
	});

	it("returns empty string when no candidate exists", () => {
		// vfs is empty → none of the candidates resolve.
		expect(getHarnessServerPath()).toBe("");
	});
});

// =============================================================================
// ensureDistFresh
// =============================================================================
describe("harness-process — ensureDistFresh", () => {
	// Layout: cwd-relative dist candidate (#4) is the easiest to control because
	// it is rooted at process.cwd() (= /repo) rather than import.meta.dirname.
	const DIST = "/repo/dist/harness/server.js";
	const STALE = { stale: true, newestSrcMs: 9_000, buildMs: 1_000 };
	const FRESH = { stale: false, newestSrcMs: 1_000, buildMs: 9_000 };

	it("no-ops when no dist server can be resolved", () => {
		// Nothing staged → getHarnessServerPath() === "" → early return.
		expect(() => ensureDistFresh()).not.toThrow();
		expect(mocks.execSync).not.toHaveBeenCalled();
	});

	it("no-ops when the matching source tree is absent", () => {
		setFile(DIST, "compiled", 1000);
		ensureDistFresh({ readStaleness: () => null });
		expect(mocks.execSync).not.toHaveBeenCalled();
	});

	it("does not rebuild when the recursive detector reports fresh", () => {
		setFile(DIST, "compiled", 5000);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		try {
			ensureDistFresh({ readStaleness: () => FRESH });
			expect(mocks.execSync).not.toHaveBeenCalled();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("rebuilds when recursive source inspection reports stale", () => {
		setFile(DIST, "compiled", 1000);
		const logs: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
		mocks.execSync.mockReturnValue("");
		try {
			ensureDistFresh({
				readStaleness: vi.fn().mockReturnValueOnce(STALE).mockReturnValueOnce(FRESH),
			});
			const buildCall = mocks.execSync.mock.calls.find((args) =>
				String(args[0]).includes("npm run build"),
			);
			expect(buildCall).toBeDefined();
			expect(logs.join("\n")).toMatch(/Rebuilt dist/);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("suppresses rebuild progress in quiet mode", () => {
		setFile(DIST, "compiled", 1000);
		const logs: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
		mocks.execSync.mockReturnValue("");
		try {
			ensureDistFresh({
				quiet: true,
				readStaleness: vi.fn().mockReturnValueOnce(STALE).mockReturnValueOnce(FRESH),
			});
			const buildCall = mocks.execSync.mock.calls.find((args) =>
				String(args[0]).includes("npm run build"),
			);
			expect(buildCall).toBeDefined();
			expect(logs).toEqual([]);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("throws on build failure instead of launching stale dist", () => {
		setFile(DIST, "compiled", 1000);
		mocks.execSync.mockImplementation((cmd: string) => {
			if (String(cmd).includes("npm run build")) throw new Error("tsc failed");
			return "";
		});
		expect(() => ensureDistFresh({ readStaleness: () => STALE })).toThrow("tsc failed");
	});

	it("throws if the build exits cleanly without refreshing dist", () => {
		setFile(DIST, "compiled", 1000);
		mocks.execSync.mockReturnValue("");
		expect(() => ensureDistFresh({ readStaleness: () => STALE })).toThrow("dist is still stale");
	});
});
