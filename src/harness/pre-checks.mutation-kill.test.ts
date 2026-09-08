import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
import { nonNull } from "../lib/non-null.js";
// Mutation-directed public-contract tests for src/harness/pre-checks.ts.
//
// These cases exercise only exported checks and assert the policy outcomes
// exposed to callers.  The subprocess boundary is mocked so the scenarios are
// deterministic without relying on the host process table or git checkout.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(() => ""),
}));

import { execSync as mockedExecSync } from "node:child_process";

import {
	checkConcurrentEdit,
	checkDirtyWorkingTree,
	checkEnvLeakToGit,
	checkLargeFileWrite,
	checkSelfKill,
	checkStaleBranch,
} from "./pre-checks.js";

const execSyncMock = vi.mocked(mockedExecSync);

beforeEach(() => {
	execSyncMock.mockReset();
	execSyncMock.mockReturnValue("");
});

afterEach(() => {
	vi.useRealTimers();
});

describe("checkSelfKill mutation contracts", () => {
	// test-contract: boundary — only a complete plain `kill <pid>` command may enter the self-kill policy
	it("does not interpret embedded or trailing kill syntax as a kill command", () => {
		expect(checkSelfKill(`echo kill ${process.pid}`)).toBeNull();
		expect(checkSelfKill(`kill ${process.pid} extra`)).toBeNull();
	});

	// test-contract: security — padded process-table rows still protect an ancestor PID from termination
	it("parses whitespace-padded ancestor rows and blocks the planted ancestor", () => {
		const plantedAncestor = 424242;
		execSyncMock.mockImplementation((command: string) => {
			if (command.includes("ps -o pid=,ppid= -ax")) {
				return `  ${process.ppid} ${plantedAncestor}  \n  ${plantedAncestor} 1  `;
			}
			return "";
		});

		expect(checkSelfKill(`kill ${plantedAncestor}`)?.block).toContain(
			`PID ${plantedAncestor}`,
		);
	});

	// test-contract: security — live Bun and Deno Interlinked processes in another session receive the same warning policy as Node
	it("warns for live Bun and Deno Interlinked processes", () => {
		execSyncMock.mockImplementation((command: string) => {
			if (command.includes("-p 7101")) return "  999 bun    bun /x/interlinked/server.js";
			if (command.includes("-p 7102")) return "  999 deno    deno /x/interlinked/server.ts";
			return "";
		});

		expect(checkSelfKill("kill 7101")?.warning).toContain("another session");
		expect(checkSelfKill("kill 7102")?.warning).toContain("another session");
	});

	// test-contract: boundary — cross-session process warnings keep a clean bounded context instead of leaking unbounded ps output
	it("trims and bounds the process context in a live-process warning", () => {
		const info = `  999 node    node /x/interlinked/server.js${" ".repeat(60)}TAIL`;
		execSyncMock.mockImplementation((command: string) =>
			command.includes("-p 7110") ? info : "",
		);

		const warning = checkSelfKill("kill 7110")?.warning;
		expect(warning).toContain("server.js). Killing it will terminate that session");
		expect(warning).not.toContain("TAIL");
	});

	// test-contract: security — the parent PID remains protected even when the ancestor-table probe fails closed
	it("protects the parent process during a cold-start ps failure", async () => {
		vi.resetModules();
		vi.doMock("node:child_process", () => ({
			execSync: vi.fn(() => {
				throw new Error("ps unavailable");
			}),
		}));
		const coldModule = await import("./pre-checks.js");
		expect(coldModule.checkSelfKill(`kill ${process.ppid}`)?.block).toContain(
			`PID ${process.ppid}`,
		);
		vi.doUnmock("node:child_process");
	});

	// test-contract: security — the live-process probe must run with the exact command text and the documented piped/encoded/timed options
	it("probes the target PID with the exact ps command and options", () => {
		execSyncMock.mockImplementation((command: string) =>
			command.includes("-p 55501") ? "1 sh /bin/sh" : "",
		);

		// An orphan (ppid<=1) target never warns — this also confirms the probe ran at all.
		expect(checkSelfKill("kill 55501")).toBeNull();
		expect(execSyncMock).toHaveBeenCalledWith("ps -o ppid=,comm=,args= -p 55501 2>/dev/null", {
			encoding: "utf-8",
			timeout: 1000,
		});
	});

	// test-contract: security — a live process must match BOTH a JS-runtime marker (node/bun/deno) AND a Claude/Interlinked marker before it earns the cross-session warning; matching only the Claude half must not warn
	it("does not warn about a Claude-named process running on a non-JS runtime", () => {
		execSyncMock.mockImplementation((command: string) =>
			command.includes("-p 55502") ? "50 python claude-session-helper.py" : "",
		);
		expect(checkSelfKill("kill 55502")).toBeNull();
	});

	// test-contract: boundary — leading whitespace in the raw ps output must not silently shift how many real characters land inside the reported 80-character warning window
	it("does not let leading ps-output padding steal characters from the reported process context", () => {
		const core = "50 node interlinked "; // ppid=50 (not orphan); matches node + interlinked
		const info = " ".repeat(30) + core + "Z".repeat(70);
		execSyncMock.mockImplementation((command: string) =>
			command.includes("-p 55503") ? info : "",
		);

		const warning = checkSelfKill("kill 55503")?.warning;
		expect(warning).toContain(core + "Z".repeat(60));
	});
});

describe("checkEnvLeakToGit mutation contracts", () => {
	// test-contract: security — documented example, sample, and template env files remain exempt even when they contain secret-shaped values
	it("allows every documented env placeholder filename", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});

		for (const fileName of [".env.example", ".env.sample", ".env.template"]) {
			expect(checkEnvLeakToGit(fileName, "TOKEN=placeholder-secret", "/tmp/repo")).toBeNull();
		}
	});

	// test-contract: security — the gitignore probe must run against the exact quoted resolved path with the documented piped, timed options
	it("probes git check-ignore with the exact quoted path and piped options", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});

		const result = checkEnvLeakToGit(".env", "PASSWORD=hunter2", "/work/dir");

		expect(result?.block).toContain(".env");
		expect(execSyncMock).toHaveBeenCalledWith('git check-ignore --quiet "/work/dir/.env"', {
			cwd: "/work/dir",
			timeout: 2000,
			stdio: ["pipe", "pipe", "pipe"],
		});
	});
});

describe("checkStaleBranch mutation contracts", () => {
	// Mirrors the private STALE_BRANCH_INTERVAL_MS in pre-checks.ts (5 minutes).
	const STALE_INTERVAL_MS = 5 * 60 * 1000;

	// test-contract: invariant — a no-git result is cached by session and must not trigger subprocess work after the directory becomes a repository
	it("retains a no-git cache result for the same session", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pre-checks-mutation-stale-"));
		try {
			expect(checkStaleBranch(cwd, "mutation-cache-session")).toBeNull();
			mkdirSync(join(cwd, ".git"));
			expect(checkStaleBranch(cwd, "mutation-cache-session")).toBeNull();
			expect(execSyncMock).not.toHaveBeenCalled();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// test-contract: boundary — the 5-minute cache freshness window is a strict "<"; one ms before it elapses the cache must still hit, and at exactly the interval it must be treated as stale and re-probed
	it("treats an exactly-elapsed cache interval as stale, but not one millisecond earlier", () => {
		vi.useFakeTimers();
		const base = new Date("2026-02-01T00:00:00.000Z").getTime();
		vi.setSystemTime(base);

		const cwd = mkdtempSync(join(tmpdir(), "pre-checks-mutation-freshness-"));
		try {
			mkdirSync(join(cwd, ".git"));
			execSyncMock.mockImplementation((command: string) => {
				if (command.includes("rev-parse --verify main")) return "main\n";
				if (command.includes("rev-list --count")) return "0\n";
				return "";
			});

			checkStaleBranch(cwd, "freshness-session");
			const callsAfterFirst = execSyncMock.mock.calls.length;
			expect(callsAfterFirst).toBe(2);

			vi.setSystemTime(base + STALE_INTERVAL_MS - 1);
			checkStaleBranch(cwd, "freshness-session");
			expect(execSyncMock.mock.calls.length).toBe(callsAfterFirst);

			vi.setSystemTime(base + STALE_INTERVAL_MS);
			checkStaleBranch(cwd, "freshness-session");
			expect(execSyncMock.mock.calls.length).toBe(callsAfterFirst + 2);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// test-contract: security — both git probes (main-branch detection, behind-count) must run with their exact command text and piped/encoded/timed options
	it("invokes both git probes with their exact commands and piped/encoded/timed options", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pre-checks-mutation-callargs-"));
		try {
			mkdirSync(join(cwd, ".git"));
			execSyncMock.mockImplementation((command: string) => {
				if (command.includes("rev-parse --verify main")) return "main\n";
				if (command.includes("rev-list --count")) return "3\n";
				return "";
			});

			// behind=3 is under the 50-commit threshold, so no warning — this also
			// confirms both probes actually ran and were parsed correctly.
			expect(checkStaleBranch(cwd, "callargs-session")).toBeNull();

			expect(execSyncMock).toHaveBeenCalledWith(
				"git rev-parse --verify main 2>/dev/null && echo main || echo master",
				{ cwd, timeout: 2000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
			);
			expect(execSyncMock).toHaveBeenCalledWith("git rev-list --count HEAD..main 2>/dev/null", {
				cwd,
				timeout: 2000,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// test-contract: boundary — the stale-branch warning fires strictly above the 50-commit threshold, not at it
	it("does not warn when exactly at the stale-branch threshold", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pre-checks-mutation-threshold-"));
		try {
			mkdirSync(join(cwd, ".git"));
			execSyncMock.mockImplementation((command: string) => {
				if (command.includes("rev-parse --verify main")) return "main\n";
				if (command.includes("rev-list --count")) return "50\n";
				return "";
			});

			expect(checkStaleBranch(cwd, "threshold-session")).toBeNull();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("checkDirtyWorkingTree mutation contracts", () => {
	// test-contract: boundary — trailing status newlines do not become phantom uncommitted files in the warning count
	it("trims porcelain output before counting changed entries", () => {
		execSyncMock.mockReturnValue(" M one.ts\n");
		const result = checkDirtyWorkingTree("git checkout main", "/repo");
		expect(result?.warning).toContain("1 uncommitted change");
	});

	// test-contract: security — untrimmed and mis-delimited status output must not corrupt the reported change count, and the probe must run with the exact piped, timed options
	it("invokes git status with the exact piped options and counts three real changes, not four or a character count", () => {
		execSyncMock.mockReturnValue(" M one.ts\n?? two.ts\n M three.ts\n");
		const result = checkDirtyWorkingTree("git checkout main", "/repo-cwd");

		expect(result?.warning).toContain("3 uncommitted change(s)");
		expect(execSyncMock).toHaveBeenCalledWith("git status --porcelain 2>/dev/null", {
			cwd: "/repo-cwd",
			timeout: 3000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});
});

describe("checkLargeFileWrite mutation contracts", () => {
	// test-contract: boundary — UTF-8 byte sizing reports the documented KiB warning for multibyte content
	it("measures multibyte content as UTF-8 bytes and reports its size", () => {
		const result = checkLargeFileWrite("é".repeat(26 * 1024));
		expect(result?.warning).toContain("52KB");
	});

	// test-contract: boundary — the large-file warning fires strictly above the 50KB threshold, not at or below it
	it("does not warn when content is exactly at the large-file threshold", () => {
		const content = "a".repeat(50 * 1024); // exactly LARGE_FILE_THRESHOLD bytes (ASCII)
		expect(checkLargeFileWrite(content)).toBeNull();
	});
});

describe("checkConcurrentEdit mutation contracts", () => {
	// test-contract: public-api — the reported staleness age divides milliseconds by MS_PER_SECOND; callers read the exact "<N>s ago" text
	it("reports the concurrent-write age in whole seconds, not a millisecond-scaled number", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
		const filePath = "/repo/src/shared.ts";
		const writeTime = "2026-01-01T00:09:18.000Z"; // exactly 42s before frozen "now"
		const other = ({ ...completeSessionFixture(), ...{
			session_id: "other-session",
			agent_name: "other-agent",
			files_written: new Set([filePath]),
			file_write_times: new Map([[filePath, writeTime]]),
			// SAFETY: checkConcurrentEdit only reads session_id, agent_name,
			// files_written, and file_write_times — the remaining SessionTrajectory
			// fields it never touches are safely omitted from this fixture.
		} });

		const result = checkConcurrentEdit(filePath, "current-session", [other]);
		expect(result?.warning).toBe(
			'[interlinked:concurrent-edit] "other-agent" wrote to this file 42s ago — coordinate to avoid conflicts',
		);
	});
});

describe("getProtectedPids / protectedPids mutation contracts (fresh module per scenario)", () => {
	afterEach(() => {
		vi.doUnmock("node:child_process");
		vi.doUnmock("node:fs");
	});

	/** Fresh, fully-isolated pre-checks.js instance with both subprocess and fs
	 *  probes under test control — required because protectedPids() caches its
	 *  result for the lifetime of the module instance. */
	async function freshPreChecksModule(
		execSyncImpl: (command: string) => string,
		fsImpl: {
			existsSync: (p: string) => boolean;
			readFileSync: (p: string, enc: string) => string;
		},
	) {
		vi.resetModules();
		// Construct the mock fns directly and close over them in the factory
		// (rather than re-importing "node:child_process"/"node:fs" afterward)
		// so the reference this helper returns is provably the exact same
		// object pre-checks.js's internal imports resolve to.
		const execSyncFn = vi.fn(execSyncImpl);
		const existsSyncFn = vi.fn(fsImpl.existsSync);
		const readFileSyncFn = vi.fn(fsImpl.readFileSync);
		vi.doMock("node:child_process", () => ({ execSync: execSyncFn }));
		vi.doMock("node:fs", () => ({ existsSync: existsSyncFn, readFileSync: readFileSyncFn }));
		const sut = await import("./pre-checks.js");
		return {
			checkSelfKill: sut.checkSelfKill,
			execSyncMock: execSyncFn,
		};
	}

	/** process.ppid is a real (non-configurable-via-plain-assignment) data
	 *  property on this Node build — a bare `process.ppid = x` silently no-ops.
	 *  Swapping it for a getter accessor (still configurable:true) does take
	 *  effect, so tests that need a specific parent PID use this instead. */
	function withOverriddenPpid<T>(value: number, fn: () => T): T {
		// SAFETY: "ppid" is always a real own property of the live process object
		// (verified: Object.getOwnPropertyDescriptor(process, "ppid") never
		// returns undefined on any supported Node build), so this is never null.
		const original = nonNull(Object.getOwnPropertyDescriptor(process, "ppid"));
		Object.defineProperty(process, "ppid", { get: () => value, configurable: true });
		try {
			return fn();
		} finally {
			Object.defineProperty(process, "ppid", original);
		}
	}

	// test-contract: security — a falsy real parent PID (0) must not become protected via the unconditional `if (process.ppid)` guard
	it("does not protect a falsy parent PID", async () => {
		const mod = await freshPreChecksModule(
			() => "",
			{ existsSync: () => false, readFileSync: () => "" },
		);
		expect(withOverriddenPpid(0, () => mod.checkSelfKill("kill 0"))).toBeNull();
	});

	// test-contract: security — the 10-hop ancestor cap and per-line trimming must be exact: an unbounded walk or an untrimmed leading-whitespace row would change which ancestors are protected. The ancestor probe must also run with its exact command and options.
	it("walks exactly ten trimmed ancestor rows and stops, protecting the tenth hop but not the eleventh", async () => {
		const rows = [
			"  40001 40002",
			"  40002 40003",
			"  40003 40004",
			"  40004 40005",
			"  40005 40006",
			"  40006 40007",
			"  40007 40008",
			"  40008 40009",
			"  40009 40010",
			"  40010 40011",
			"  40011 40012",
			"  40012 1",
		].join("\n");
		const mod = await freshPreChecksModule(
			(command: string) => (command.includes("pid=,ppid=") ? rows : ""),
			{ existsSync: () => false, readFileSync: () => "" },
		);

		withOverriddenPpid(40001, () => {
			expect(mod.checkSelfKill("kill 40002")?.block).toContain("PID 40002");
			expect(mod.checkSelfKill("kill 40011")).toBeNull();
		});
		expect(mod.execSyncMock).toHaveBeenCalledWith("ps -o pid=,ppid= -ax 2>/dev/null", {
			encoding: "utf-8",
			timeout: 2000,
		});
	});

	// test-contract: security — when the parent PID is itself <=1, the ancestor loop must not execute at all
	it("never walks the ancestor loop when the parent PID is already <=1", async () => {
		const mod = await freshPreChecksModule(
			(command: string) => (command.includes("pid=,ppid=") ? "  1 500" : ""),
			{ existsSync: () => false, readFileSync: () => "" },
		);
		expect(withOverriddenPpid(1, () => mod.checkSelfKill("kill 500"))).toBeNull();
	});

	// test-contract: invariant — protectedPids() computes the ancestor set once per module lifetime and reuses it; it must not re-run the subprocess probe on every checkSelfKill call
	it("caches the protected-PID set across repeated checkSelfKill calls", async () => {
		const mod = await freshPreChecksModule(
			() => "",
			{ existsSync: () => false, readFileSync: () => "" },
		);
		mod.checkSelfKill("kill 1");
		mod.checkSelfKill("kill 2");
		const ancestorCalls = mod.execSyncMock.mock.calls.filter((call) =>
			String(call[0]).includes("pid=,ppid="),
		);
		expect(ancestorCalls).toHaveLength(1);
	});

	// test-contract: security — the harness.pid file must be read from the exact ".interlinked/harness.pid" path with the documented "utf-8" encoding, and a valid PID inside it must become protected
	it("protects the PID recorded in a genuinely present harness.pid file", async () => {
		const expectedPath = join(process.cwd(), ".interlinked", "harness.pid");
		const mod = await freshPreChecksModule(
			() => {
				throw new Error("no ancestor chain");
			},
			{
				existsSync: (p: string) => p === expectedPath,
				readFileSync: (p: string, enc: string) => {
					if (p === expectedPath && enc === "utf-8") return "24680";
					throw new Error(`unexpected readFileSync(${p}, ${enc})`);
				},
			},
		);
		expect(mod.checkSelfKill("kill 24680")?.block).toContain("PID 24680");
	});

	// test-contract: security — forcing the existsSync gate to report present must not fabricate a protected PID when the file genuinely is not there
	it("does not protect a PID when the harness.pid file genuinely does not exist", async () => {
		const mod = await freshPreChecksModule(
			() => {
				throw new Error("no ancestor chain");
			},
			{ existsSync: () => false, readFileSync: () => "13579" },
		);
		expect(mod.checkSelfKill("kill 13579")).toBeNull();
	});
});
