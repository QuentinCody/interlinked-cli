// Supplementary branch-coverage companion for src/harness/pre-checks.ts.
//
// The pre-existing __tests__/pre-checks.test.ts exhaustively covers
// `checkLargeFileLineCountWrite`; this file targets the OTHER exported checks
// and their uncovered branches: getProtectedPids / checkSelfKill,
// checkEnvLeakToGit, checkStaleBranch, checkDirtyWorkingTree,
// checkLargeFileWrite, checkConcurrentEdit, detectBashCodeFileWrite, plus the
// fail-open / fallback paths of checkLargeFileLineCountWrite not hit there.
//
// `execSync` is mocked so the git/ps subprocess branches are deterministic and
// hermetic; node:fs stays REAL (tmp dirs) so the line-cap delta and the harness
// pid-file read run their genuine logic.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process BEFORE importing the module under test — getProtectedPids()
// calls execSync the first time checkSelfKill runs, and that result is cached for
// the process lifetime, so the mock must be installed at import time.
vi.mock("node:child_process", () => ({
	execSync: vi.fn(() => ""),
}));

import { execSync as mockedExecSync } from "node:child_process";

import { resetLargeFileBaselineCache } from "./large-file-policy.js";
import {
	checkConcurrentEdit,
	checkDirtyWorkingTree,
	checkEnvLeakToGit,
	checkLargeFileLineCountWrite,
	checkLargeFileWrite,
	checkSelfKill,
	checkStaleBranch,
	detectBashCodeFileWrite,
} from "./pre-checks.js";
import type { SessionTrajectory } from "./types.js";

const execSyncMock = vi.mocked(mockedExecSync);

/** Build a string of exactly `n` lines. */
function lines(n: number): string {
	return Array.from({ length: n }, () => "const x = 1;").join("\n");
}

/**
 * Minimal SessionTrajectory fixture. checkConcurrentEdit only reads
 * session_id / files_written / file_write_times / agent_name, so the cast keeps
 * the fixture readable without wiring the full (~50-field) interface.
 */
function makeSession(over: {
	id: string;
	agentName?: string;
	written?: string[];
	writeTimes?: Array<[string, string]>;
}): SessionTrajectory {
	const base = {
		session_id: over.id,
		agent_name: over.agentName ?? "",
		files_written: new Set<string>(over.written ?? []),
		file_write_times: new Map<string, string>(over.writeTimes ?? []),
	};
	return { ...completeSessionFixture(), ...base };
}

beforeEach(() => {
	// Default: every execSync returns "" (a benign empty string). Individual
	// tests override per-call via mockImplementation.
	execSyncMock.mockReset();
	execSyncMock.mockReturnValue("");
});

// =====================================================================
// getProtectedPids() + checkSelfKill()
// =====================================================================
// getProtectedPids caches at module scope, populated by the first checkSelfKill
// call. This block runs first so the very first invocation exercises the ps
// ancestor-walk and the harness-pid-file read; later cases reuse the cache.

describe("checkSelfKill + getProtectedPids", () => {
	// A pid we plant as an ancestor of process.ppid so the protected set is
	// non-trivial and the ancestor-walk loop body executes.
	const PLANTED_ANCESTOR = 424242;
	let pidDir: string;
	// SPY, not process.chdir(): chdir THROWS in a worker thread
	// ("process.chdir() is not supported in workers"), and Stryker's vitest
	// runner pins its own pool, so a real chdir here fails the mutation dry run
	// for any file whose graph-selected test scope includes this one.
	// getProtectedPids resolves the pid file via `join(process.cwd(), ...)`, so
	// the spy exercises the same path.
	let cwdSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		pidDir = mkdtempSync(join(tmpdir(), "pre-checks-pid-"));
		mkdirSync(join(pidDir, ".interlinked"), { recursive: true });
		// A readable, numeric harness.pid → exercises the parse + add branch.
		writeFileSync(join(pidDir, ".interlinked", "harness.pid"), "777777\n");
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(pidDir);

		// `ps -ax` listing: map process.ppid -> PLANTED_ANCESTOR -> 1 (init),
		// so the ancestor walk adds ppid then PLANTED_ANCESTOR then stops at init.
		// A junk line and a self->1 line exercise the regex filter.
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("ps -o pid=,ppid= -ax")) {
				return [
					"garbage line that does not match",
					`${process.ppid} ${PLANTED_ANCESTOR}`,
					`${PLANTED_ANCESTOR} 1`,
					"1 0",
				].join("\n");
			}
			return "";
		});
	});

	afterEach(() => {
		cwdSpy.mockRestore();
		rmSync(pidDir, { recursive: true, force: true });
	});

	it("returns null for a command that is not a plain `kill <pid>`", () => {
		expect(checkSelfKill("ls -la")).toBeNull();
		expect(checkSelfKill("kill -9 1234")).toBeNull(); // signal form not matched
		expect(checkSelfKill("killall node")).toBeNull();
	});

	it("blocks killing the current process (self) — primes the protected-pid cache", () => {
		// First checkSelfKill call in the module: builds + caches the protected
		// set, walking the planted ancestor chain and reading harness.pid.
		const result = checkSelfKill(`  kill ${process.pid}  `);
		expect(result?.block).toContain(`PID ${process.pid}`);
		expect(result?.block).toContain("terminate this session");
		// The ps ancestor-walk ran during cache build.
		expect(execSyncMock).toHaveBeenCalled();
	});

	it("blocks killing a planted ancestor PID (ancestor-walk populated the set)", () => {
		// Cache is already warm from the previous test; the planted ancestor is
		// in the set even though we changed cwd this test.
		const result = checkSelfKill(`kill ${PLANTED_ANCESTOR}`);
		expect(result?.block).toContain(`PID ${PLANTED_ANCESTOR}`);
	});

	it("blocks killing the harness pid read from harness.pid", () => {
		const result = checkSelfKill("kill 777777");
		expect(result?.block).toBeDefined();
	});

	it("warns when target resolves to a live (non-orphan) Claude/Interlinked process", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 555")) {
				// ppid 999 (>1, non-orphan) + a node interlinked harness arg line.
				return "  999 node    node /x/interlinked/harness/server.js";
			}
			return "";
		});
		const result = checkSelfKill("kill 555");
		expect(result?.warning).toContain("PID 555");
		expect(result?.warning).toContain("another session");
	});

	it("allows killing an ORPHAN harness daemon (ppid <= 1) silently", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 556")) {
				// ppid 1 = orphan → isOrphan true → not blocked, not warned.
				return "  1 node    node /x/interlinked/harness/server.js";
			}
			return "";
		});
		expect(checkSelfKill("kill 556")).toBeNull();
	});

	it("returns null when target is an unrelated process (not claude/interlinked)", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 557")) return "  999 bash    /bin/bash -l";
			return "";
		});
		expect(checkSelfKill("kill 557")).toBeNull();
	});

	it("warns when the process arg matches the `harness/server` operand (live)", () => {
		// node + harness/server (no 'claude'/'interlinked' word) → exercises the
		// third operand of the isClaudeOrInterlinked OR.
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 560")) return "  999 node    node /opt/x/harness/server.js";
			return "";
		});
		expect(checkSelfKill("kill 560")?.warning).toBeDefined();
	});

	it("returns null when an interpreter runs but the command is unrelated (no claude/interlinked)", () => {
		// node present but none of claude/interlinked/harness-server → second OR
		// clause is false → isClaudeOrInterlinked false → no warning.
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 561")) return "  999 node    node /tmp/build-script.js";
			return "";
		});
		expect(checkSelfKill("kill 561")).toBeNull();
	});

	it("returns null when the ps lookup for the target throws (catch path)", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 558")) throw new Error("no such process");
			return "";
		});
		expect(checkSelfKill("kill 558")).toBeNull();
	});

	it("returns null when the target ps output has no parseable ppid", () => {
		// Empty/garbage info → ppidMatch null → targetPpid 0 → isOrphan true.
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 559")) return "node interlinked harness/server no-leading-pid";
			return "";
		});
		expect(checkSelfKill("kill 559")).toBeNull();
	});
});

// =====================================================================
// getProtectedPids fail-open branches — fresh module via vi.resetModules()
// =====================================================================
// The block above warms the cache with a happy-path ps result. To hit the
// getProtectedPids catch blocks (ps throws; harness.pid unreadable/NaN) we need
// a COLD module so getProtectedPids runs again with hostile execSync/fs state.

describe("getProtectedPids fail-open paths (cold module)", () => {
	let coldDir: string;
	// SPY, not process.chdir(): chdir THROWS in a worker thread
	// ("process.chdir() is not supported in workers"), and Stryker's vitest
	// runner pins its own pool, so a real chdir here fails the mutation dry run
	// for any file whose graph-selected test scope includes this one.
	// getProtectedPids resolves the pid file via `join(process.cwd(), ...)`, so
	// the spy exercises the same path.
	let cwdSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		coldDir = mkdtempSync(join(tmpdir(), "pre-checks-cold-"));
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(coldDir);
		vi.resetModules();
	});

	afterEach(() => {
		cwdSpy.mockRestore();
		rmSync(coldDir, { recursive: true, force: true });
	});

	it("survives ps throwing AND a non-numeric harness.pid (both catch/NaN paths)", async () => {
		mkdirSync(join(coldDir, ".interlinked"), { recursive: true });
		// Non-numeric pid → Number.parseInt NaN → the !Number.isNaN guard skips add.
		writeFileSync(join(coldDir, ".interlinked", "harness.pid"), "not-a-number");

		vi.doMock("node:child_process", () => ({
			execSync: vi.fn(() => {
				throw new Error("ps unavailable");
			}),
		}));
		const mod = await import("./pre-checks.js");
		// Self-kill still blocks (process.pid added before the ps walk), proving
		// getProtectedPids returned a usable set despite both failures.
		const result = mod.checkSelfKill(`kill ${process.pid}`);
		expect(result?.block).toBeDefined();
	});

	it("survives when reading harness.pid itself throws (fs catch path)", async () => {
		// harness.pid exists as a DIRECTORY → existsSync true but readFileSync
		// throws (EISDIR) → exercises the inner try/catch around the pid-file
		// read; and ps throws too.
		mkdirSync(join(coldDir, ".interlinked", "harness.pid"), { recursive: true });
		vi.doMock("node:child_process", () => ({
			execSync: vi.fn(() => {
				throw new Error("ps boom");
			}),
		}));
		const mod = await import("./pre-checks.js");
		expect(mod.checkSelfKill(`kill ${process.pid}`)?.block).toBeDefined();
	});

	it("works when no harness.pid file exists (existsSync false branch, ps OK)", async () => {
		// No .interlinked/harness.pid (the common case) → the existsSync guard's
		// false branch is taken and the pid-file read is skipped. ps returns a
		// clean ancestor chain so the walk runs normally.
		vi.doMock("node:child_process", () => ({
			execSync: vi.fn((cmd: string) => {
				if (typeof cmd === "string" && cmd.includes("ps -o pid=,ppid= -ax")) {
					return `${process.ppid} 1\n1 0`;
				}
				return "";
			}),
		}));
		const mod = await import("./pre-checks.js");
		expect(mod.checkSelfKill(`kill ${process.pid}`)?.block).toBeDefined();
	});

	afterAll(() => {
		vi.resetModules();
		vi.doUnmock("node:child_process");
	});
});

// =====================================================================
// checkEnvLeakToGit()
// =====================================================================

describe("checkEnvLeakToGit", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pre-checks-env-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns null for non-.env files", () => {
		expect(checkEnvLeakToGit("/p/config.json", "SECRET=abc", dir)).toBeNull();
	});

	it("returns null for .env.example / .env.sample / .env.template", () => {
		expect(checkEnvLeakToGit(".env.example", "API_KEY=x", dir)).toBeNull();
		expect(checkEnvLeakToGit(".env.sample", "API_KEY=x", dir)).toBeNull();
		expect(checkEnvLeakToGit(".env.template", "API_KEY=x", dir)).toBeNull();
	});

	it("matches a suffix .env name (production.env)", () => {
		// git check-ignore exits non-zero (mock throws) → not ignored → secrets → block.
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});
		const result = checkEnvLeakToGit("production.env", "DATABASE_URL=postgres://x", dir);
		expect(result?.block).toContain("production.env");
	});

	it("returns null when the file IS gitignored (check-ignore exits 0)", () => {
		// execSync returning normally == exit 0 == file is ignored == safe.
		execSyncMock.mockReturnValue("");
		expect(checkEnvLeakToGit(".env", "API_KEY=supersecret", dir)).toBeNull();
	});

	it("blocks when not gitignored and content has secret-like patterns", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});
		const result = checkEnvLeakToGit(".env.local", "TOKEN=abc123", dir);
		expect(result?.block).toContain(".env.local");
		expect(result?.block).toContain(".gitignore");
	});

	it("warns (not block) when not gitignored but content has no secrets", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});
		const result = checkEnvLeakToGit(".env", "JUST_A_FLAG=true", dir);
		expect(result?.warning).toContain("env-leak");
	});

	it("warns when content is undefined (empty-text path, no secrets)", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});
		expect(checkEnvLeakToGit(".env", undefined, dir)?.warning).toContain("env-leak");
	});

	it("resolves a relative path against cwd before check-ignore", () => {
		// Relative path → resolve(cwd, filePath); mock throws → not ignored → block.
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});
		expect(checkEnvLeakToGit(".env", "PRIVATE_KEY=----", dir)?.block).toBeDefined();
	});

	it("uses an absolute path as-is (isAbsolute true branch)", () => {
		// Absolute path → the ternary's true branch (filePath used directly).
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});
		const abs = join(dir, ".env");
		expect(checkEnvLeakToGit(abs, "SECRET=zzz", dir)?.block).toBeDefined();
	});
});

// =====================================================================
// checkStaleBranch()
// =====================================================================

describe("checkStaleBranch", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pre-checks-stale-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns null (and caches) when not in a git repo — no .git dir", () => {
		// No .git → early cache + null, no execSync.
		expect(checkStaleBranch(dir, "sess-nogit")).toBeNull();
		expect(execSyncMock).not.toHaveBeenCalled();
		// Second call hits the cache branch (still null, still no execSync).
		expect(checkStaleBranch(dir, "sess-nogit")).toBeNull();
		expect(execSyncMock).not.toHaveBeenCalled();
	});

	it("warns when the branch is far behind the main branch", () => {
		mkdirSync(join(dir, ".git"), { recursive: true });
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse")) return "main";
			if (cmd.includes("rev-list")) return "120"; // > threshold 50
			return "";
		});
		const result = checkStaleBranch(dir, "sess-behind");
		expect(result?.warning).toContain("120 commits behind main");
	});

	it("returns null when behind count is within the threshold", () => {
		mkdirSync(join(dir, ".git"), { recursive: true });
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse")) return "main";
			if (cmd.includes("rev-list")) return "3";
			return "";
		});
		expect(checkStaleBranch(dir, "sess-fresh")).toBeNull();
	});

	it("returns the cached result on a second call inside the interval", () => {
		mkdirSync(join(dir, ".git"), { recursive: true });
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse")) return "main";
			if (cmd.includes("rev-list")) return "200";
			return "";
		});
		const first = checkStaleBranch(dir, "sess-cache");
		expect(first?.warning).toBeDefined();
		const callsAfterFirst = execSyncMock.mock.calls.length;
		const second = checkStaleBranch(dir, "sess-cache");
		// Cache hit: identical result, no further execSync calls.
		expect(second).toBe(first);
		expect(execSyncMock.mock.calls.length).toBe(callsAfterFirst);
	});

	it("returns null (catch path) when git rev-parse throws", () => {
		mkdirSync(join(dir, ".git"), { recursive: true });
		execSyncMock.mockImplementation(() => {
			throw new Error("git missing");
		});
		expect(checkStaleBranch(dir, "sess-throw")).toBeNull();
	});

	it("returns null when behind count is non-numeric (NaN guard)", () => {
		mkdirSync(join(dir, ".git"), { recursive: true });
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse")) return "main";
			if (cmd.includes("rev-list")) return "not-a-number";
			return "";
		});
		expect(checkStaleBranch(dir, "sess-nan")).toBeNull();
	});
});

// =====================================================================
// checkDirtyWorkingTree()
// =====================================================================

describe("checkDirtyWorkingTree", () => {
	const cwd = "/some/repo";

	it("returns null for git commands that cannot discard changes", () => {
		expect(checkDirtyWorkingTree("git status", cwd)).toBeNull();
		expect(checkDirtyWorkingTree("ls -la", cwd)).toBeNull();
		expect(execSyncMock).not.toHaveBeenCalled();
	});

	it("warns when checkout runs with uncommitted changes", () => {
		execSyncMock.mockReturnValue(" M src/a.ts\n?? src/b.ts");
		const result = checkDirtyWorkingTree("git checkout main", cwd);
		expect(result?.warning).toContain("2 uncommitted change");
	});

	it("matches switch / rebase / reset verbs too", () => {
		execSyncMock.mockReturnValue(" M one.ts");
		expect(checkDirtyWorkingTree("git switch other", cwd)?.warning).toBeDefined();
		expect(checkDirtyWorkingTree("git rebase main", cwd)?.warning).toBeDefined();
		expect(checkDirtyWorkingTree("git reset --hard", cwd)?.warning).toBeDefined();
	});

	it("returns null when the working tree is clean", () => {
		execSyncMock.mockReturnValue("");
		expect(checkDirtyWorkingTree("git checkout main", cwd)).toBeNull();
	});

	it("returns null (catch path) when git status throws", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not a git repo");
		});
		expect(checkDirtyWorkingTree("git rebase main", cwd)).toBeNull();
	});
});

// =====================================================================
// checkLargeFileWrite()
// =====================================================================

describe("checkLargeFileWrite", () => {
	it("returns null when content is undefined", () => {
		expect(checkLargeFileWrite(undefined)).toBeNull();
	});

	it("returns null for content under the 50KB threshold", () => {
		expect(checkLargeFileWrite("x".repeat(1024))).toBeNull();
	});

	it("warns for content over the 50KB threshold", () => {
		const result = checkLargeFileWrite("x".repeat(51 * 1024));
		expect(result?.warning).toContain("large-file");
		expect(result?.warning).toContain("KB");
	});
});

// =====================================================================
// checkConcurrentEdit()
// =====================================================================

describe("checkConcurrentEdit", () => {
	const target = "/repo/src/shared.ts";
	const now = Date.now();
	const recentIso = new Date(now - 5_000).toISOString();
	const oldIso = new Date(now - 20 * 60 * 1000).toISOString(); // 20m > 10m window

	it("returns null when no other session has touched the file", () => {
		const sessions = [makeSession({ id: "me", written: [target] })];
		expect(checkConcurrentEdit(target, "me", sessions)).toBeNull();
	});

	it("skips the current session even if it wrote the file", () => {
		const sessions = [
			makeSession({ id: "me", written: [target], writeTimes: [[target, recentIso]] }),
		];
		expect(checkConcurrentEdit(target, "me", sessions)).toBeNull();
	});

	it("skips a session that did not write THIS file", () => {
		const sessions = [makeSession({ id: "other", written: ["/repo/src/elsewhere.ts"] })];
		expect(checkConcurrentEdit(target, "me", sessions)).toBeNull();
	});

	it("skips a session with no recorded write time for the file", () => {
		const sessions = [makeSession({ id: "other", written: [target] })]; // no writeTimes
		expect(checkConcurrentEdit(target, "me", sessions)).toBeNull();
	});

	it("skips a session whose write time is unparseable (NaN guard)", () => {
		const sessions = [
			makeSession({ id: "other", written: [target], writeTimes: [[target, "not-a-date"]] }),
		];
		expect(checkConcurrentEdit(target, "me", sessions)).toBeNull();
	});

	it("skips a write older than the 10-minute window", () => {
		const sessions = [
			makeSession({ id: "other", written: [target], writeTimes: [[target, oldIso]] }),
		];
		expect(checkConcurrentEdit(target, "me", sessions)).toBeNull();
	});

	it("warns using agent_name when a recent concurrent write exists", () => {
		const sessions = [
			makeSession({
				id: "other-session-id",
				agentName: "Reviewer",
				written: [target],
				writeTimes: [[target, recentIso]],
			}),
		];
		const result = checkConcurrentEdit(target, "me", sessions);
		expect(result?.warning).toContain('"Reviewer"');
		expect(result?.warning).toContain("concurrent-edit");
	});

	it("falls back to a session_id slice when agent_name is empty", () => {
		const sessions = [
			makeSession({
				id: "abcdef1234567890",
				agentName: "",
				written: [target],
				writeTimes: [[target, recentIso]],
			}),
		];
		const result = checkConcurrentEdit(target, "me", sessions);
		expect(result?.warning).toContain('"abcdef12"'); // first 8 chars
	});

	it("resolves a relative target path against cwd before comparison", () => {
		// Relative path → resolve(process.cwd(), filePath). Plant the matching
		// absolute path so the recent-write branch fires.
		const rel = "src/rel-target.ts";
		const abs = join(process.cwd(), rel);
		const sessions = [
			makeSession({
				id: "peer",
				agentName: "Peer",
				written: [abs],
				writeTimes: [[abs, recentIso]],
			}),
		];
		expect(checkConcurrentEdit(rel, "me", sessions)?.warning).toContain('"Peer"');
	});
});

// =====================================================================
// detectBashCodeFileWrite()
// =====================================================================

describe("detectBashCodeFileWrite", () => {
	it("returns null for an empty command", () => {
		expect(detectBashCodeFileWrite("")).toBeNull();
	});

	it("lets `interlinked write` through (self-gates)", () => {
		expect(detectBashCodeFileWrite("interlinked write src/foo.ts < /tmp/x")).toBeNull();
	});

	it("detects `>` redirection into a code file", () => {
		const hit = detectBashCodeFileWrite("echo 'x' > src/foo.ts");
		expect(hit?.target).toBe("src/foo.ts");
		expect(hit?.mechanism).toContain("shell redirect");
	});

	it("detects `>>` append redirection into a code file", () => {
		const hit = detectBashCodeFileWrite("printf 'x' >> lib/a.py");
		expect(hit?.mechanism).toContain(">>");
	});

	it("detects a double-quoted redirect target", () => {
		const hit = detectBashCodeFileWrite('cat tpl > "src/quoted name.ts"');
		expect(hit?.target).toBe("src/quoted name.ts");
	});

	it("does NOT match a redirect operator INSIDE a quoted string", () => {
		// The `>` lives inside the echoed string; the only real write target is
		// out.txt (non-code), so no hit.
		expect(detectBashCodeFileWrite('echo "a > b.ts" > out.txt')).toBeNull();
	});

	it("ignores fd redirection like 2> and &>", () => {
		expect(detectBashCodeFileWrite("run 2> err.log")).toBeNull();
		expect(detectBashCodeFileWrite("run &> all.log")).toBeNull();
	});

	it("returns null when a `>` operator has no target after it (unresolvable redirect)", () => {
		// Trailing `>` → parseRedirectTarget finds neither quoted nor bare → null
		// → the `if (!hit) continue` branch fires; no other write mechanism.
		expect(detectBashCodeFileWrite("echo x >")).toBeNull();
	});

	it("returns null when a redirect target is a non-code file", () => {
		expect(detectBashCodeFileWrite("echo x > notes.txt")).toBeNull();
	});

	it("detects `tee` writing a code file (and tee -a / --append)", () => {
		expect(detectBashCodeFileWrite("echo x | tee src/t.ts")?.mechanism).toBe("tee");
		expect(detectBashCodeFileWrite("echo x | tee -a src/t.ts")?.mechanism).toBe("tee");
		expect(detectBashCodeFileWrite("echo x | tee --append src/t.ts")?.mechanism).toBe("tee");
	});

	it("ignores tee to a non-code file", () => {
		expect(detectBashCodeFileWrite("echo x | tee out.log")).toBeNull();
	});

	it("detects `sed -i` in-place editing a code file", () => {
		const hit = detectBashCodeFileWrite("sed -i 's/a/b/' src/edit.ts");
		expect(hit?.mechanism).toContain("sed -i");
		expect(hit?.target).toBe("src/edit.ts");
	});

	it("detects clustered sed in-place flag (sed -ie suffix form)", () => {
		expect(detectBashCodeFileWrite("sed -i.bak 's/a/b/' src/edit.ts")?.mechanism).toContain(
			"sed -i",
		);
	});

	it("ignores sed without an in-place flag", () => {
		expect(detectBashCodeFileWrite("sed 's/a/b/' src/edit.ts")).toBeNull();
	});

	it("skips a trailing flag token in sed's reverse arg-walk", () => {
		// `-i` placed AFTER the filename: the reverse walk sees `-i` first
		// (startsWith('-') → continue, line 554), then finds the code file.
		const hit = detectBashCodeFileWrite("sed src/edit.ts -i");
		expect(hit?.target).toBe("src/edit.ts");
	});

	it("returns null for sed -i targeting only a non-code file (CODE_FILE_EXT_RE false)", () => {
		// In-place flag present, but the positional is a .txt → the
		// CODE_FILE_EXT_RE.test branch is false for every positional.
		expect(detectBashCodeFileWrite("sed -i 's/a/b/' notes.txt")).toBeNull();
	});

	it("detects an inline node -e script calling writeFileSync on a code file", () => {
		const hit = detectBashCodeFileWrite(
			`node -e "require('fs').writeFileSync('out.ts', 'x')"`,
		);
		expect(hit?.target).toBe("out.ts");
		expect(hit?.mechanism).toContain("inline node");
	});

	it("detects an inline python -c script using open(...,'w') on a code file", () => {
		const hit = detectBashCodeFileWrite(`python3 -c "open('gen.py','w').write('x')"`);
		expect(hit?.target).toBe("gen.py");
		expect(hit?.mechanism).toContain("inline python3");
	});

	it("returns null for an inline script that writes a non-code file", () => {
		expect(
			detectBashCodeFileWrite(`node -e "require('fs').writeFileSync('out.txt','x')"`),
		).toBeNull();
	});

	it("detects an inline script using the fs.writeFile(...) form", () => {
		// `fs.writeFile('x.ts', ...)` — the async fs API. (The first write-arg
		// matcher already covers `writeFile(` substrings, so this asserts the
		// observable behaviour, not which alternand fires.)
		const hit = detectBashCodeFileWrite(`node -e "fs.writeFile('async-out.ts', data, cb)"`);
		expect(hit?.target).toBe("async-out.ts");
	});

	it("detects cp into a code-file destination (last positional)", () => {
		const hit = detectBashCodeFileWrite("cp /tmp/src.txt src/dst.ts");
		expect(hit?.target).toBe("src/dst.ts");
		expect(hit?.mechanism).toContain("cp");
	});

	it("detects mv with a flag that takes a value (-t skips its arg)", () => {
		// `-S .bak` is a value-flag; destination is still the last positional.
		const hit = detectBashCodeFileWrite("cp -S .bak /tmp/a src/keep.ts");
		expect(hit?.target).toBe("src/keep.ts");
	});

	it("detects cp -T into a code file (boolean flag must NOT eat the dest)", () => {
		// Regression: -T is boolean; the destination src/foo.ts must survive parsing.
		const hit = detectBashCodeFileWrite("cp -T /tmp/x src/foo.ts");
		expect(hit?.target).toBe("src/foo.ts");
	});

	it("detects writing a Supermodel .graph shard via cp (protected target)", () => {
		const hit = detectBashCodeFileWrite("cp /tmp/x out.graph.bin");
		expect(hit?.target).toBe("out.graph.bin");
		expect(hit?.mechanism).toContain("write to tracked file");
	});

	it("returns null for a file-move verb with fewer than two positionals", () => {
		expect(detectBashCodeFileWrite("cp src/only.ts")).toBeNull();
	});

	// A remote destination is not a local tracked file, so it cannot bypass this
	// repo's content gates. Before this, rsyncing ONE file to another machine was
	// blocked while rsyncing its whole PARENT DIRECTORY passed — same transfer,
	// opposite verdicts, purely because only the first ended in a code extension.
	it("N: does not flag rsync of a single file to a REMOTE destination", () => {
		expect(detectBashCodeFileWrite("rsync -a src/foo.ts user@host:~/dest/foo.ts")).toBeNull();
	});

	it("N: does not flag scp to a remote destination", () => {
		expect(detectBashCodeFileWrite("scp src/foo.ts host:/srv/app/foo.ts")).toBeNull();
	});

	it("N: does not flag a bare host:path remote spec (no user@)", () => {
		expect(detectBashCodeFileWrite("rsync -a src/a.mjs box:~/b/a.mjs")).toBeNull();
	});

	it("P: STILL flags rsync pulling a remote file INTO a local code path", () => {
		// Direction matters: here the destination is local, so the gate must hold.
		const hit = detectBashCodeFileWrite("rsync -a user@host:~/src/foo.ts src/foo.ts");
		expect(hit?.target).toBe("src/foo.ts");
	});

	it("P: STILL flags a local-to-local copy that merely contains a colon", () => {
		// `./a:b.ts` has a colon AFTER a slash — a local filename, not a remote spec.
		const hit = detectBashCodeFileWrite("cp /tmp/x ./a:b.ts");
		expect(hit?.target).toBe("./a:b.ts");
	});

	it("P: STILL flags a URL-looking destination (:// is not a remote spec)", () => {
		const hit = detectBashCodeFileWrite("cp /tmp/x https://x/foo.ts");
		expect(hit?.target).toBe("https://x/foo.ts");
	});

	it("skips a pipeline segment that has fewer than two words (args.length < 2)", () => {
		// `ls` segment → 1 word → the `args.length < 2 continue` guard fires;
		// the real cp segment is still detected.
		const hit = detectBashCodeFileWrite("ls | cp /tmp/a src/dst.ts");
		expect(hit?.target).toBe("src/dst.ts");
	});

	it("returns null for cp into a non-protected destination", () => {
		expect(detectBashCodeFileWrite("cp /tmp/a /tmp/b.txt")).toBeNull();
	});

	it("detects `dd of=` into a code file", () => {
		const hit = detectBashCodeFileWrite("dd if=/tmp/src of=out.ts bs=1M");
		expect(hit?.mechanism).toContain("dd");
		expect(hit?.target).toBe("out.ts");
	});

	it("returns null for dd of= into a non-code file", () => {
		expect(detectBashCodeFileWrite("dd if=/dev/zero of=disk.img")).toBeNull();
	});

	it("returns null for dd without an of= argument", () => {
		expect(detectBashCodeFileWrite("dd if=/tmp/src bs=1M")).toBeNull();
	});

	it("returns null for a benign command with no write mechanism", () => {
		expect(detectBashCodeFileWrite("grep -r foo src/")).toBeNull();
	});
});

// =====================================================================
// checkLargeFileLineCountWrite() — fail-open / fallback branches only
// (the happy-path block/allow cases live in __tests__/pre-checks.test.ts)
// =====================================================================

describe("checkLargeFileLineCountWrite — fail-open + fallback paths", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pre-checks-cap-cov-"));
		resetLargeFileBaselineCache();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetLargeFileBaselineCache();
	});
	const file = (name: string): string => join(dir, name);

	it("returns null when no file path is present in the tool input", () => {
		expect(checkLargeFileLineCountWrite({ content: lines(2000) }, dir)).toBeNull();
	});

	it("reads the file path from the `path` key when `file_path` is absent", () => {
		// Uses `path` (Codex-style) → still projects + blocks an over-cap Write.
		const result = checkLargeFileLineCountWrite(
			{ path: file("viapath.ts"), content: lines(2000) },
			dir,
		);
		expect(result?.block).toContain("file-size");
	});

	it("fails open for an Edit whose target file does not exist (current lines 0)", () => {
		// No file on disk → readCurrentFile returns 0 lines → Edit branch bails.
		expect(
			checkLargeFileLineCountWrite(
				{ file_path: file("ghost.ts"), old_string: "a", new_string: lines(2000) },
				dir,
			),
		).toBeNull();
	});

	it("fails open for an Edit whose old_string is absent (occurrences 0)", () => {
		const path = file("present.ts");
		writeFileSync(path, lines(10));
		expect(
			checkLargeFileLineCountWrite(
				{ file_path: path, old_string: "NOT_IN_FILE", new_string: lines(5000), replace_all: true },
				dir,
			),
		).toBeNull();
	});

	it("blocks an Edit with replace_all across multiple occurrences (occurrence math)", () => {
		const path = file("repeat.ts");
		// 10 lines, each "const x = 1;" → old_string occurs 10x. Replacing each
		// 1-line match with a 200-line block balloons well past the cap.
		writeFileSync(path, lines(10));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: "const x = 1;", new_string: lines(200), replace_all: true },
			dir,
		);
		expect(result?.block).toContain("file-size");
	});

	it("fails open for a MultiEdit on a non-existent file", () => {
		expect(
			checkLargeFileLineCountWrite(
				{
					file_path: file("ghost2.ts"),
					edits: [{ old_string: "a", new_string: lines(2000) }],
				},
				dir,
			),
		).toBeNull();
	});

	it("ignores malformed entries inside a MultiEdit edits array", () => {
		const path = file("multi-mixed.ts");
		writeFileSync(path, lines(10));
		const result = checkLargeFileLineCountWrite(
			{
				file_path: path,
				edits: [
					null, // skipped (not an object)
					"a string", // skipped (not an object)
					{ old_string: 123, new_string: "x" }, // skipped (non-string fields)
					{ replace_all: true, old_string: "const x = 1;", new_string: lines(300) }, // counts
				],
			},
			dir,
		);
		// Only the valid entry contributes; 10 matches × ~299 net lines → over cap.
		expect(result?.block).toContain("file-size");
	});

	it("fails open for replace_all with an empty old_string (countOccurrences→0)", () => {
		// Empty needle → countOccurrences returns 0 (its length-0 guard) →
		// occurrences 0 → projectLineCount bails → fail open.
		const path = file("empty-needle.ts");
		writeFileSync(path, lines(10));
		expect(
			checkLargeFileLineCountWrite(
				{ file_path: path, old_string: "", new_string: lines(5000), replace_all: true },
				dir,
			),
		).toBeNull();
	});

	it("fails open (returns null) for an unprojectable tool shape", () => {
		// No content / old_string+new_string / edits → projectLineCount null.
		expect(
			checkLargeFileLineCountWrite({ file_path: file("np.ts"), notebook_cell: "x" }, dir),
		).toBeNull();
	});

	it("fails open when the existing file cannot be read (directory in place of file)", () => {
		// A directory at the target path → readFileSync throws → readCurrentFile
		// returns null → projectLineCount returns null → fail open.
		const path = file("isdir.ts");
		mkdirSync(path, { recursive: true });
		expect(
			checkLargeFileLineCountWrite({ file_path: path, content: lines(2000) }, dir),
		).toBeNull();
	});

	it("allows an over-cap Write to a non-cappable (.d.ts) file", () => {
		expect(
			checkLargeFileLineCountWrite({ file_path: file("types.d.ts"), content: lines(2000) }, dir),
		).toBeNull();
	});

	it("emits 'create' wording for a brand-new over-cap file (before === 0)", () => {
		const result = checkLargeFileLineCountWrite(
			{ file_path: file("brand-new.ts"), content: lines(2000) },
			dir,
		);
		expect(result?.block).toContain("create");
		expect(result?.block).not.toContain("already");
	});
});
import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
