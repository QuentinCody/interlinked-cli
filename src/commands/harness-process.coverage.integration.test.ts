import { parseWire, wireObject, wireString } from "../lib/value-validation.js";
// ===========================================
// harness-process — behavioral branch coverage
// ===========================================
// The sibling `harness-process.test.ts` only asserts the exported identities
// plus a few absent-state returns (it runs against the real, un-mocked fs so it
// can't reach the spawn/kill/rebuild arms). This companion mocks every external
// boundary the module touches and drives the branches that file leaves cold:
//   - reapOrphanHarnesses: the full ps-scan → candidate filter (pid==self,
//     non-node, non-harness, cross-cwd, --cwd= form, ancestor/active-pid
//     protections, killAll) → SIGTERM batch → ESRCH-as-reaped → SIGKILL
//     escalation of survivors → stale pid/sock sweep + reaped-count nudge.
//   - waitForProcessesExit / hasProcess / isNoSuchProcessError via reap.
//   - clearOrphanedPidFiles: pid-file enumeration, non-killed skip, NaN skip,
//     readdir failure, rm failure, paired socket removal.
//   - collectAncestorPids: the ps-walk parent chain + the execSync-throws arm.
//   - openDaemonStderrLog (mkdir / pre-existing offset / failure) +
//     close/read (happy + failure + null).
//   - ensureDistFresh: no-server / installed-package short-circuits, recursive
//     fresh vs stale verdicts, exact build invocation, quiet JSON progress,
//     build failure, and post-build freshness verification.
//   - getHarnessServerPath: first-candidate hit + empty-string fallthrough.
//   - isHarnessRunning: no-pid-file, NaN pid, alive, stale-cleanup (kill
//     throws → unlink) + unlink-also-throws.
//
// `node:fs`, `node:child_process`, `../lib/config.js`,
// `../harness/session-paths.js`, and `../lib/formatter.js` are all mocked so
// every branch is scripted with zero real fs / process / signal I/O. To keep
// the synchronous `Atomics.wait` poll loops inside waitForProcessesExit from
// sleeping, the scripted `process.kill(pid, 0)` liveness probe reports the
// target gone (throws ESRCH) on the first poll, so each loop exits immediately.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	// node:child_process
	execSync: vi.fn(),
	spawn: vi.fn(),
	// node:fs
	closeSync: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	openSync: vi.fn(),
	readdirSync: vi.fn(),
	readFileSync: vi.fn(),
	rmSync: vi.fn(),
	statSync: vi.fn(),
	unlinkSync: vi.fn(),
	// deps
	daemonPathsFor: vi.fn(),
	getConfigDir: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execSync: mocks.execSync,
	spawn: mocks.spawn,
}));

vi.mock("../harness/daemon-process-identity.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../harness/daemon-process-identity.js")>();
	return { ...actual, readHarnessProcessIdentity: vi.fn((_cwd: string, pid: number) => `id:${pid}`) };
});

vi.mock("node:fs", () => ({
	closeSync: mocks.closeSync,
	existsSync: mocks.existsSync,
	mkdirSync: mocks.mkdirSync,
	openSync: mocks.openSync,
	readdirSync: mocks.readdirSync,
	readFileSync: mocks.readFileSync,
	rmSync: mocks.rmSync,
	statSync: mocks.statSync,
	unlinkSync: mocks.unlinkSync,
}));

vi.mock("../harness/session-paths.js", () => ({
	daemonPathsFor: mocks.daemonPathsFor,
}));

vi.mock("../lib/config.js", () => ({
	getConfigDir: mocks.getConfigDir,
}));

vi.mock("../lib/formatter.js", () => ({
	c: {
		red: (s: string) => s,
		green: (s: string) => s,
		yellow: (s: string) => s,
	},
}));

import {
	closeDaemonStderrLog,
	collectAncestorPids,
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

// ---- ESRCH helper: an Error carrying the "no such process" code ------------
function esrch(): NodeJS.ErrnoException {
	const e: NodeJS.ErrnoException = new Error("no such process");
	e.code = "ESRCH";
	return e;
}

// ---- output capture --------------------------------------------------------
let logs: string[];
let stderrChunks: string[];

beforeEach(() => {
	for (const m of Object.values(mocks)) m.mockReset();
	logs = [];
	stderrChunks = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
	});
	vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
		stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
		return true;
	}));
	vi.spyOn(process, "cwd").mockReturnValue("/repo");
	// Default config-dir resolver: <cwd>/.interlinked
	mocks.getConfigDir.mockImplementation((cwd?: string) => `${cwd ?? "/repo"}/.interlinked`);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function logText(): string {
	return logs.join("\n");
}
function stderrText(): string {
	return stderrChunks.join("");
}

// ===========================================================================
// path helpers
// ===========================================================================

describe("path helpers", () => {
	it("getSocketPath joins the config dir with harness.sock", () => {
		expect(getSocketPath("/repo")).toBe("/repo/.interlinked/harness.sock");
		expect(mocks.getConfigDir).toHaveBeenCalledWith("/repo");
	});

	it("getSocketPath defaults cwd to process.cwd()", () => {
		expect(getSocketPath()).toBe("/repo/.interlinked/harness.sock");
	});

	it("getPidPath joins the config dir with harness.pid", () => {
		expect(getPidPath("/repo")).toBe("/repo/.interlinked/harness.pid");
	});

	it("getFramedSocketPath delegates to daemonPathsFor with the session id", () => {
		mocks.daemonPathsFor.mockReturnValue({
			socket: "/repo/.interlinked/harness-alpha.sock",
			pid: "/x.pid",
			log: "/x.log",
		});
		expect(getFramedSocketPath("/repo", "alpha")).toBe("/repo/.interlinked/harness-alpha.sock");
		expect(mocks.daemonPathsFor).toHaveBeenCalledWith("/repo", "alpha");
	});

	it("getFramedSocketPath falls back to the default session id when undefined", () => {
		mocks.daemonPathsFor.mockReturnValue({
			socket: "/repo/.interlinked/harness.sock",
			pid: "/x.pid",
			log: "/x.log",
		});
		expect(getFramedSocketPath("/repo", undefined)).toBe("/repo/.interlinked/harness.sock");
		expect(mocks.daemonPathsFor).toHaveBeenCalledWith("/repo", "default");
	});
});

// ===========================================================================
// readActiveHarnessPid (mocked-fs arms not reached by the sibling)
// ===========================================================================

describe("readActiveHarnessPid", () => {
	it("returns the parsed pid when the file holds a number", () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.readFileSync.mockReturnValue(" 4242 \n");
		expect(readActiveHarnessPid("/repo")).toBe(4242);
	});

	it("returns null when the pid file is missing", () => {
		mocks.existsSync.mockReturnValue(false);
		expect(readActiveHarnessPid("/repo")).toBeNull();
	});

	it("returns null when reading throws", () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.readFileSync.mockImplementation(() => {
			throw new Error("EACCES");
		});
		expect(readActiveHarnessPid("/repo")).toBeNull();
	});
});

// ===========================================================================
// reapOrphanHarnesses
// ===========================================================================

// A ps line for the orphan-selection regex: "<pid> <ppid> <command>".
function psLine(pid: number, ppid: number, command: string): string {
	return `${pid} ${ppid} ${command}`;
}
const HARNESS = "node /x/interlinked-cli/dist/harness/server.js";

describe("reapOrphanHarnesses — ps failure + dry-run", () => {
	it("returns an empty result when execSync throws", () => {
		mocks.execSync.mockImplementation(() => {
			throw new Error("ps not found");
		});
		const r = reapOrphanHarnesses("/repo");
		expect(r.candidates).toEqual([]);
		expect(r.killed).toEqual([]);
	});

	it("returns an empty result when execSync yields a non-string", () => {
		mocks.execSync.mockReturnValue(Buffer.from("ignored"));
		// collectAncestorPids also calls execSync — keep it a Buffer-safe noop string
		// on the second call so the ancestor walk doesn't throw.
		mocks.execSync.mockReturnValueOnce(123);
		const r = reapOrphanHarnesses("/repo");
		expect(r.candidates).toEqual([]);
	});

	it("dry-run lists matching candidates without signalling", () => {
		// First execSync call (reap) returns the ps table; second (ancestor walk)
		// returns an empty-ish table.
		mocks.execSync
			.mockReturnValueOnce(`${psLine(5000, 1, `${HARNESS} --cwd /repo`)}\n`)
			.mockReturnValue("");
		mocks.existsSync.mockReturnValue(false); // no active pid file
		const killSpy = vi.spyOn(process, "kill");
		const r = reapOrphanHarnesses("/repo", { dryRun: true });
		expect(r.dryRun).toBe(true);
		expect(r.candidates.map((c) => c.pid)).toEqual([5000]);
		expect(r.killed).toEqual([]);
		expect(killSpy).not.toHaveBeenCalled();
	});
});

// A reaper that kills a working daemon opens the guard gap that makes the next
// blocked caller start another one — the 2026-08-15 restart storm. `protectPids`
// carries the socket-verified serving set into the sweep.
describe("reapOrphanHarnesses — protectPids (liveness-verified reaping)", () => {
	beforeEach(() => {
		mocks.existsSync.mockReturnValue(false);
		mocks.readdirSync.mockReturnValue([]);
	});

	it("N: a protected (serving) pid is neither a candidate nor signalled", () => {
		mocks.execSync
			.mockReturnValueOnce(`${psLine(5100, 1, `${HARNESS} --cwd /repo`)}\n`)
			.mockReturnValue("");
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		const r = reapOrphanHarnesses("/repo", { protectPids: new Set([5100]) });
		expect(r.candidates).toEqual([]);
		expect(r.killed).toEqual([]);
		expect(killSpy).not.toHaveBeenCalledWith(5100, "SIGTERM");
		killSpy.mockRestore();
	});

	it("P: an unprotected orphan is still reaped alongside a protected one", () => {
		mocks.execSync
			.mockReturnValueOnce(
				`${psLine(5100, 1, `${HARNESS} --cwd /repo`)}\n${psLine(5200, 1, `${HARNESS} --cwd /repo`)}\n`,
			)
			.mockReturnValue("");
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		const r = reapOrphanHarnesses("/repo", { protectPids: new Set([5100]) });
		expect(r.candidates.map((c) => c.pid)).toEqual([5200]);
		killSpy.mockRestore();
	});
});

describe("reapOrphanHarnesses — candidate filtering", () => {
	beforeEach(() => {
		mocks.existsSync.mockReturnValue(false); // no active-pid file by default
		mocks.readdirSync.mockReturnValue([]);
	});

	it("skips self, non-node, non-harness, cross-cwd, and --cwd-less rows; keeps the match", () => {
		const self = process.pid;
		const table = [
			psLine(self, 1, `${HARNESS} --cwd /repo`), // own pid → skip
			psLine(6001, 1, "python /some/other --cwd /repo"), // not node/bun → skip
			psLine(6002, 1, "node /unrelated/server.js --cwd /repo"), // not harness → skip
			psLine(6003, 1, `${HARNESS} --cwd /other-repo`), // different cwd → skip
			psLine(6004, 1, HARNESS), // no --cwd at all → skip
			psLine(6005, 1, `${HARNESS} --cwd /repo`), // bun-or-node + harness + cwd → KEEP
			"   not a ps line   ", // regex miss → skip
		].join("\n");
		mocks.execSync.mockReturnValueOnce(table).mockReturnValue("");
		const r = reapOrphanHarnesses("/repo", { dryRun: true });
		expect(r.candidates.map((c) => c.pid)).toEqual([6005]);
	});

	it("accepts the --cwd=<path> equals form and a bun command line", () => {
		const table = psLine(6100, 1, `bun /x/interlinked-cli/dist/harness/server.js --cwd=/repo`);
		mocks.execSync.mockReturnValueOnce(`${table}\n`).mockReturnValue("");
		const r = reapOrphanHarnesses("/repo", { dryRun: true });
		expect(r.candidates.map((c) => c.pid)).toEqual([6100]);
	});

	it("default mode protects the active daemon pid and the ancestor chain", () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.readFileSync.mockReturnValue("7000"); // active pid = 7000
		const ancestor = process.ppid || 1;
		const table = [
			psLine(7000, 1, `${HARNESS} --cwd /repo`), // active → skip
			psLine(ancestor, 1, `${HARNESS} --cwd /repo`), // ancestor → skip
			psLine(7002, 1, `${HARNESS} --cwd /repo`), // KEEP
		].join("\n");
		// reap ps, then ancestor-walk ps (give it a table that yields the chain).
		mocks.execSync.mockReturnValueOnce(table).mockReturnValue(`${ancestor} 1\n`);
		const r = reapOrphanHarnesses("/repo", { dryRun: true });
		expect(r.candidates.map((c) => c.pid)).toEqual([7002]);
	});

	it("killAll mode still protects the ancestor chain but not the active daemon", () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.readFileSync.mockReturnValue("8000"); // active pid
		const ancestor = process.ppid || 1;
		const table = [
			psLine(8000, 1, `${HARNESS} --cwd /repo`), // active → kept under killAll
			psLine(ancestor, 1, `${HARNESS} --cwd /repo`), // ancestor → still skipped
		].join("\n");
		mocks.execSync.mockReturnValueOnce(table).mockReturnValue(`${ancestor} 1\n`);
		const r = reapOrphanHarnesses("/repo", { dryRun: true, killAll: true });
		// active pid is fair game; ancestor is not.
		expect(r.candidates.map((c) => c.pid)).toEqual([8000]);
	});
});

describe("reapOrphanHarnesses — signalling + escalation", () => {
	beforeEach(() => {
		mocks.existsSync.mockReturnValue(false);
		mocks.readdirSync.mockReturnValue([]);
	});

	it("SIGTERMs candidates, treats ESRCH as reaped, sweeps files, and nudges", () => {
		const table = [
			psLine(9001, 1, `${HARNESS} --cwd /repo`),
			psLine(9002, 1, `${HARNESS} --cwd /repo`),
		].join("\n");
		mocks.execSync.mockReturnValueOnce(table).mockReturnValue("");
		// pid-file sweep: a harness.pid referencing 9001 should be removed.
		mocks.readdirSync.mockReturnValue(["harness.pid", "harness-x.pid", "unrelated.txt"]);
		mocks.readFileSync.mockImplementation((p: unknown) => {
			const s = String(p);
			if (s.endsWith("harness.pid")) return "9001";
			if (s.endsWith("harness-x.pid")) return "9002";
			return "";
		});
		mocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith(".sock"));

		const termAccepted = new Set<number>();
		const gone = new Set<number>();
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
			// 9001 vanishes on SIGTERM (ESRCH → reaped). 9002 takes the SIGTERM but
			// is gone by the liveness poll (signal 0 throws ESRCH → exits the loop).
			if (sig === "SIGTERM" && pid === 9001) {
				gone.add(pid);
				throw esrch();
			}
			if (sig === "SIGTERM") termAccepted.add(pid);
			if (sig === 0 && (gone.has(pid) || termAccepted.has(pid))) throw esrch();
			return true;
		}));

		const r = reapOrphanHarnesses("/repo");
		expect(r.dryRun).toBe(false);
		expect(new Set(r.killed)).toEqual(new Set([9001, 9002]));
		expect(killSpy).toHaveBeenCalledWith(9002, "SIGTERM");
		// pid + paired socket removed for both reaped pids.
		expect(mocks.rmSync).toHaveBeenCalledWith("/repo/.interlinked/harness.pid", { force: true });
		expect(mocks.rmSync).toHaveBeenCalledWith("/repo/.interlinked/harness.sock", { force: true });
		expect(mocks.rmSync).toHaveBeenCalledWith("/repo/.interlinked/harness-x.pid", { force: true });
		expect(stderrText()).toContain("Reaped 2 orphan harness daemons: 9001, 9002");
	});

	it("uses the singular nudge wording for a single reaped daemon", () => {
		mocks.execSync.mockReturnValueOnce(`${psLine(9100, 1, `${HARNESS} --cwd /repo`)}\n`).mockReturnValue("");
		mocks.readdirSync.mockReturnValue([]);
		vi.spyOn(process, "kill").mockImplementation(((_pid: number, sig?: string | number) => {
			if (sig === 0) throw esrch(); // dies immediately after SIGTERM
			return true;
		}));
		const r = reapOrphanHarnesses("/repo");
		expect(r.killed).toEqual([9100]);
		expect(stderrText()).toContain("Reaped 1 orphan harness daemon:");
		expect(stderrText()).not.toContain("daemons:");
	});

	it("escalates a SIGTERM-deaf survivor to SIGKILL", () => {
		mocks.execSync.mockReturnValueOnce(`${psLine(9200, 1, `${HARNESS} --cwd /repo`)}\n`).mockReturnValue("");
		mocks.readdirSync.mockReturnValue([]);
		let killSignalSeen = false;
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((_pid: number, sig?: string | number) => {
			if (sig === "SIGKILL") {
				killSignalSeen = true;
				return true;
			}
			// After SIGKILL has been sent, the liveness poll reports gone; before
			// that (the SIGTERM grace window) it reports alive so we escalate.
			if (sig === 0) {
				if (killSignalSeen) throw esrch();
				return true;
			}
			return true; // SIGTERM accepted
		}));
		const r = reapOrphanHarnesses("/repo");
		expect(killSpy).toHaveBeenCalledWith(9200, "SIGTERM");
		expect(killSpy).toHaveBeenCalledWith(9200, "SIGKILL");
		expect(r.killed).toEqual([9200]);
	});

	it("a permission error on SIGTERM does not count as reaped (no nudge)", () => {
		mocks.execSync.mockReturnValueOnce(`${psLine(9300, 1, `${HARNESS} --cwd /repo`)}\n`).mockReturnValue("");
		mocks.readdirSync.mockReturnValue([]);
		vi.spyOn(process, "kill").mockImplementation(((_pid: number, sig?: string | number) => {
			if (sig === "SIGTERM") {
				const e: NodeJS.ErrnoException = new Error("EPERM");
				e.code = "EPERM";
				throw e; // not ESRCH → not reaped, and not added to termSent
			}
			return true;
		}));
		const r = reapOrphanHarnesses("/repo");
		expect(r.candidates.map((c) => c.pid)).toEqual([9300]);
		expect(r.killed).toEqual([]);
		expect(stderrText()).toBe("");
	});

	it("an ESRCH on SIGKILL during escalation still marks the survivor reaped", () => {
		mocks.execSync.mockReturnValueOnce(`${psLine(9400, 1, `${HARNESS} --cwd /repo`)}\n`).mockReturnValue("");
		mocks.readdirSync.mockReturnValue([]);
		let killAttempted = false;
		vi.spyOn(process, "kill").mockImplementation(((_pid: number, sig?: string | number) => {
			if (sig === "SIGKILL") {
				killAttempted = true;
				throw esrch(); // died right as we escalated → reaped via catch
			}
			if (sig === 0) {
				// alive during the SIGTERM grace (forces escalation); after the
				// SIGKILL attempt the post-kill wait poll reports gone.
				if (killAttempted) throw esrch();
				return true;
			}
			return true; // SIGTERM
		}));
		const r = reapOrphanHarnesses("/repo");
		expect(r.killed).toEqual([9400]);
	});
});

describe("clearOrphanedPidFiles (via reap) — defensive arms", () => {
	beforeEach(() => {
		mocks.existsSync.mockReturnValue(false);
	});

	it("skips when readdir throws, skips non-matching pids and NaN files", () => {
		mocks.execSync.mockReturnValueOnce(`${psLine(9500, 1, `${HARNESS} --cwd /repo`)}\n`).mockReturnValue("");
		// readdir throws → clearOrphanedPidFiles returns early; reap still completes.
		mocks.readdirSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		vi.spyOn(process, "kill").mockImplementation(((_pid: number, sig?: string | number) => {
			if (sig === 0) throw esrch();
			return true;
		}));
		const r = reapOrphanHarnesses("/repo");
		expect(r.killed).toEqual([9500]);
		expect(mocks.rmSync).not.toHaveBeenCalled();
	});

	it("skips a pid file whose contents do not match a killed pid, and a NaN file", () => {
		mocks.execSync.mockReturnValueOnce(`${psLine(9600, 1, `${HARNESS} --cwd /repo`)}\n`).mockReturnValue("");
		mocks.readdirSync.mockReturnValue(["harness.pid", "harness-other.pid"]);
		mocks.readFileSync.mockImplementation((p: unknown) => {
			const s = String(p);
			if (s.endsWith("harness.pid")) return "not-a-number"; // NaN → skip
			if (s.endsWith("harness-other.pid")) return "12345"; // not killed → skip
			return "";
		});
		vi.spyOn(process, "kill").mockImplementation(((_pid: number, sig?: string | number) => {
			if (sig === 0) throw esrch();
			return true;
		}));
		const r = reapOrphanHarnesses("/repo");
		expect(r.killed).toEqual([9600]);
		// Neither file matched the killed pid → no removal.
		expect(mocks.rmSync).not.toHaveBeenCalled();
	});

	it("skips a pid file that cannot be read", () => {
		mocks.execSync.mockReturnValueOnce(`${psLine(9700, 1, `${HARNESS} --cwd /repo`)}\n`).mockReturnValue("");
		mocks.readdirSync.mockReturnValue(["harness.pid"]);
		mocks.readFileSync.mockImplementation(() => {
			throw new Error("EACCES");
		});
		vi.spyOn(process, "kill").mockImplementation(((_pid: number, sig?: string | number) => {
			if (sig === 0) throw esrch();
			return true;
		}));
		const r = reapOrphanHarnesses("/repo");
		expect(r.killed).toEqual([9700]);
		expect(mocks.rmSync).not.toHaveBeenCalled();
	});

	it("swallows rm failures on both the pid file and its paired socket", () => {
		mocks.execSync.mockReturnValueOnce(`${psLine(9800, 1, `${HARNESS} --cwd /repo`)}\n`).mockReturnValue("");
		mocks.readdirSync.mockReturnValue(["harness.pid"]);
		mocks.readFileSync.mockReturnValue("9800");
		// socket exists so the paired-removal branch runs; both rmSync calls throw.
		mocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith(".sock"));
		mocks.rmSync.mockImplementation(() => {
			throw new Error("EBUSY");
		});
		vi.spyOn(process, "kill").mockImplementation(((_pid: number, sig?: string | number) => {
			if (sig === 0) throw esrch();
			return true;
		}));
		// Must not throw despite both rm failures.
		const r = reapOrphanHarnesses("/repo");
		expect(r.killed).toEqual([9800]);
		expect(mocks.rmSync).toHaveBeenCalledWith("/repo/.interlinked/harness.pid", { force: true });
	});

	it("does not enter the paired-socket branch when the socket is absent", () => {
		mocks.execSync.mockReturnValueOnce(`${psLine(9850, 1, `${HARNESS} --cwd /repo`)}\n`).mockReturnValue("");
		mocks.readdirSync.mockReturnValue(["harness.pid"]);
		mocks.readFileSync.mockReturnValue("9850");
		mocks.existsSync.mockReturnValue(false); // no socket
		vi.spyOn(process, "kill").mockImplementation(((_pid: number, sig?: string | number) => {
			if (sig === 0) throw esrch();
			return true;
		}));
		const r = reapOrphanHarnesses("/repo");
		expect(r.killed).toEqual([9850]);
		// pid removed, but the .sock removal was guarded out.
		expect(mocks.rmSync).toHaveBeenCalledWith("/repo/.interlinked/harness.pid", { force: true });
		expect(mocks.rmSync).not.toHaveBeenCalledWith("/repo/.interlinked/harness.sock", { force: true });
	});
});

// ===========================================================================
// collectAncestorPids
// ===========================================================================

describe("collectAncestorPids", () => {
	it("walks the parent chain from a scripted ps table", () => {
		const ppid = process.ppid || 50;
		// chain: ppid -> 40 -> 1 (stop at <=1)
		mocks.execSync.mockReturnValue([`${ppid} 40`, "40 1", "bad line", "1 0"].join("\n"));
		const pids = collectAncestorPids();
		expect(pids.has(process.pid)).toBe(true);
		if (process.ppid) {
			expect(pids.has(process.ppid)).toBe(true);
			expect(pids.has(40)).toBe(true);
		}
	});

	it("returns at least self+ppid when ps throws", () => {
		mocks.execSync.mockImplementation(() => {
			throw new Error("ps blew up");
		});
		const pids = collectAncestorPids();
		expect(pids.has(process.pid)).toBe(true);
		if (process.ppid) expect(pids.has(process.ppid)).toBe(true);
	});
});

// ===========================================================================
// daemon stderr log lifecycle
// ===========================================================================

describe("openDaemonStderrLog / close / read", () => {
	it("creates the log dir, captures the start offset, and opens for append", () => {
		// dir missing → mkdir; file pre-exists → startOffset = size.
		mocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith("daemon.log"));
		mocks.statSync.mockReturnValue({ size: 128 });
		mocks.openSync.mockReturnValue(11);
		const log = openDaemonStderrLog("/repo");
		expect(log).not.toBeNull();
		expect(log?.fd).toBe(11);
		expect(log?.startOffset).toBe(128);
		expect(log?.path).toBe("/repo/.interlinked/logs/daemon.log");
		expect(mocks.mkdirSync).toHaveBeenCalledWith("/repo/.interlinked/logs", { recursive: true });
	});

	it("uses a zero start offset when the log file does not yet exist", () => {
		// dir exists, file does not → no mkdir, offset 0.
		mocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith("logs"));
		mocks.openSync.mockReturnValue(12);
		const log = openDaemonStderrLog("/repo");
		expect(log?.startOffset).toBe(0);
		expect(mocks.mkdirSync).not.toHaveBeenCalled();
		expect(mocks.statSync).not.toHaveBeenCalled();
	});

	it("returns null when opening the log throws", () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.statSync.mockReturnValue({ size: 0 });
		mocks.openSync.mockImplementation(() => {
			throw new Error("EMFILE");
		});
		expect(openDaemonStderrLog("/repo")).toBeNull();
	});

	it("closeDaemonStderrLog closes the fd, tolerates a null log and a close error", () => {
		closeDaemonStderrLog(null); // no-op branch
		closeDaemonStderrLog({ fd: 7, path: "/p", startOffset: 0 });
		expect(mocks.closeSync).toHaveBeenCalledWith(7);
		mocks.closeSync.mockImplementationOnce(() => {
			throw new Error("EBADF");
		});
		// Must not throw despite closeSync failing.
		closeDaemonStderrLog({ fd: 9, path: "/p", startOffset: 0 });
	});

	it("readDaemonStderrLog returns the slice from the start offset", () => {
		mocks.readFileSync.mockReturnValue(Buffer.from("0123456789"));
		const out = readDaemonStderrLog({ fd: 1, path: "/p", startOffset: 4 });
		expect(out).toBe("456789");
	});

	it("readDaemonStderrLog returns empty string for a null log and on read error", () => {
		expect(readDaemonStderrLog(null)).toBe("");
		mocks.readFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(readDaemonStderrLog({ fd: 1, path: "/p", startOffset: 0 })).toBe("");
	});
});

// ===========================================================================
// ensureDistFresh
// ===========================================================================

describe("ensureDistFresh", () => {
	// getHarnessServerPath is the real (in-module) function — it calls existsSync
	// over a candidate list. We point existsSync at exactly the paths we want so
	// the resolved dist server is deterministic.
	const DIST = "/repo/dist/harness/server.js";
	const STALE = { stale: true, newestSrcMs: 9_000, buildMs: 1_000 };
	const FRESH = { stale: false, newestSrcMs: 1_000, buildMs: 9_000 };

	function existsFor(set: Set<string>) {
		mocks.existsSync.mockImplementation((p: unknown) => set.has(String(p)));
	}

	it("short-circuits when no dist server resolves", () => {
		existsFor(new Set()); // nothing exists → getHarnessServerPath() === ""
		ensureDistFresh();
		expect(mocks.execSync).not.toHaveBeenCalled();
	});

	it("short-circuits when an installed package has no source tree", () => {
		// Candidate #4 resolves, but the recursive detector cannot read src/.
		existsFor(new Set([DIST]));
		const readStaleness = vi.fn().mockReturnValue(null);
		ensureDistFresh({ readStaleness });
		expect(readStaleness).toHaveBeenCalledWith("/repo");
		expect(mocks.execSync).not.toHaveBeenCalled();
	});

	it("does not rebuild when the recursive detector reports fresh", () => {
		existsFor(new Set([DIST]));
		ensureDistFresh({ readStaleness: () => FRESH });
		expect(mocks.execSync).not.toHaveBeenCalled();
		expect(logText()).toBe("");
	});

	it("rebuilds a stale checkout and verifies the resulting dist", () => {
		existsFor(new Set([DIST]));
		const readStaleness = vi.fn().mockReturnValueOnce(STALE).mockReturnValueOnce(FRESH);
		mocks.execSync.mockReturnValue("built");
		ensureDistFresh({ readStaleness });
		expect(mocks.execSync).toHaveBeenCalledOnce();
		const opts = parseWire(mocks.execSync.mock.calls[0]?.[1], wireObject({ "cwd": wireString }), "test JSON value");
		expect(opts.cwd).toBe("/repo");
		expect(mocks.execSync).toHaveBeenCalledWith("npm run build", {
			cwd: "/repo",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 120_000,
		});
		expect(readStaleness).toHaveBeenCalledTimes(2);
		expect(logText()).toContain("Source newer than dist — rebuilding...");
		expect(logText()).toContain("Rebuilt dist/");
	});

	it("keeps JSON stdout quiet while rebuilding", () => {
		existsFor(new Set([DIST]));
		mocks.execSync.mockReturnValue("built");
		ensureDistFresh({
			quiet: true,
			readStaleness: vi.fn().mockReturnValueOnce(STALE).mockReturnValueOnce(FRESH),
		});
		expect(mocks.execSync).toHaveBeenCalledOnce();
		expect(logText()).toBe("");
	});

	it("throws when rebuilding stale source fails", () => {
		existsFor(new Set([DIST]));
		mocks.execSync.mockImplementation(() => {
			throw new Error("npm run build failed");
		});
		expect(() => ensureDistFresh({ readStaleness: () => STALE })).toThrow(
			"Build failed; refusing to start the harness with stale code: npm run build failed",
		);
	});

	it("throws when a nominally successful build leaves dist stale", () => {
		existsFor(new Set([DIST]));
		mocks.execSync.mockReturnValue("built");
		expect(() => ensureDistFresh({ readStaleness: () => STALE })).toThrow(
			"Build completed but dist is still stale",
		);
	});

	it("refuses stale code when a supplied build runner throws without an Error message", () => {
		existsFor(new Set([DIST]));
		const readStaleness = vi.fn(() => STALE);
		expect(() => ensureDistFresh({
			readStaleness,
			runBuild: () => { throw "build unavailable"; },
		})).toThrow("Build failed; refusing to start the harness with stale code");
		expect(readStaleness).toHaveBeenCalledOnce();
	});

	it("throws when a nominally successful build removes the verifiable dist shape", () => {
		existsFor(new Set([DIST]));
		mocks.execSync.mockReturnValue("built");
		const readStaleness = vi.fn().mockReturnValueOnce(STALE).mockReturnValueOnce(null);
		expect(() => ensureDistFresh({ readStaleness })).toThrow(
			"dist freshness could not be verified",
		);
	});
});

// ===========================================================================
// getHarnessServerPath
// ===========================================================================

describe("getHarnessServerPath", () => {
	it("returns the first existing candidate", () => {
		// Candidate #4 is `<cwd>/dist/harness/server.js`; force only that to exist.
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === "/repo/dist/harness/server.js");
		expect(getHarnessServerPath()).toBe("/repo/dist/harness/server.js");
	});

	it("returns an empty string when no candidate exists", () => {
		mocks.existsSync.mockReturnValue(false);
		expect(getHarnessServerPath()).toBe("");
	});
});

// ===========================================================================
// isHarnessRunning
// ===========================================================================

describe("isHarnessRunning", () => {
	it("reports not running when the pid file is missing", () => {
		mocks.existsSync.mockReturnValue(false);
		expect(isHarnessRunning("/repo")).toEqual({ running: false });
	});

	it("reports not running for a NaN pid file", () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.readFileSync.mockReturnValue("garbage");
		expect(isHarnessRunning("/repo")).toEqual({ running: false });
	});

	it("reports running when the pid is alive (signal 0 succeeds)", () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.readFileSync.mockReturnValue("4321");
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		expect(isHarnessRunning("/repo")).toEqual({ running: true, pid: 4321 });
		expect(killSpy).toHaveBeenCalledWith(4321, 0);
	});

	it("cleans up a stale pid file when the process is gone", () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.readFileSync.mockReturnValue("4321");
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw esrch();
		});
		expect(isHarnessRunning("/repo")).toEqual({ running: false });
		expect(mocks.unlinkSync).toHaveBeenCalledWith("/repo/.interlinked/harness.pid");
	});

	it("tolerates an unlink failure during stale-pid cleanup", () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.readFileSync.mockReturnValue("4321");
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw esrch();
		});
		mocks.unlinkSync.mockImplementation(() => {
			throw new Error("EPERM");
		});
		// Must not throw despite the unlink failure.
		expect(isHarnessRunning("/repo")).toEqual({ running: false });
	});
});
