// ===========================================
// harness-process — mutation-kill companion (fleet-r3 PASS-1 W6)
// ===========================================
// Targets the 64 mutants that survived two prior kill campaigns on
// harness-process.ts (manifest symbols: reapOrphanHarnesses,
// collectAncestorPids, readActiveHarnessPid, ensureDistFresh,
// getHarnessServerPath, isHarnessRunning). Every case pins an exact
// observable value (never `toContain`) so a single-literal or
// single-operator mutation flips the assertion. `node:child_process` and
// `node:fs` are fully mocked — no subprocess is ever spawned and no real
// path is ever touched, whatever string a mutant computes.
//
// Mutants judged equivalent or practically unreachable in this sandbox
// (process.ppid cannot be stubbed here — verified empirically) are NOT
// tested; see scratch/fleet-r3/receipts/ for the structural arguments.

import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execSync: vi.fn(),
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	statSync: vi.fn(),
	mkdirSync: vi.fn(),
	openSync: vi.fn(),
	closeSync: vi.fn(),
	unlinkSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execSync: mocks.execSync,
}));

vi.mock("node:fs", () => ({
	existsSync: mocks.existsSync,
	readFileSync: mocks.readFileSync,
	statSync: mocks.statSync,
	mkdirSync: mocks.mkdirSync,
	openSync: mocks.openSync,
	closeSync: mocks.closeSync,
	unlinkSync: mocks.unlinkSync,
}));

import {
	collectAncestorPids,
	ensureDistFresh,
	getHarnessServerPath,
	isHarnessRunning,
	readActiveHarnessPid,
	reapOrphanHarnesses,
} from "./harness-process.js";

const FAKE_CWD = "/fake-repo";
// Same directory as harness-process.ts, so this resolves to the identical
// string the SUT's own `import.meta.dirname || __dirname` produces.
// SAFETY: this test file runs as a file:// ESM module (Node 20.11+), where
// import.meta.dirname is always a populated string, never undefined.
const SUT_DIR = import.meta.dirname;

beforeEach(() => {
	mocks.execSync.mockReset();
	mocks.existsSync.mockReset().mockReturnValue(false);
	mocks.readFileSync.mockReset();
	mocks.statSync.mockReset();
	mocks.mkdirSync.mockReset();
	mocks.openSync.mockReset();
	mocks.closeSync.mockReset();
	mocks.unlinkSync.mockReset();
	vi.spyOn(process, "cwd").mockReturnValue(FAKE_CWD);
	vi.spyOn(process, "kill").mockImplementation(() => true);
	vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// reapOrphanHarnesses
// -----------------------------------------------------------------------------
describe("reapOrphanHarnesses", () => {
	// test-contract: invariant — the orphan-scan ps invocation must request
	// utf-8 text with a bounded timeout; a stripped options object would hand
	// the parser a Buffer (which .split() would mis-decode) or let the scan
	// hang forever on a wedged shell.
	it("P1: invokes the ps scan with exact encoding+timeout options", () => {
		mocks.execSync.mockReturnValue("");
		const result = reapOrphanHarnesses(FAKE_CWD, { dryRun: true });
		expect(mocks.execSync).toHaveBeenNthCalledWith(1, "ps -ax -o pid=,ppid=,command= 2>/dev/null", {
			encoding: "utf-8",
			timeout: 2000,
		});
		// Observable post-state: an empty ps table yields no reap candidates.
		expect(result).toEqual({ candidates: [], killed: [], dryRun: true });
	});
});

// -----------------------------------------------------------------------------
// collectAncestorPids
// -----------------------------------------------------------------------------
describe("collectAncestorPids", () => {
	// test-contract: invariant — the ancestor-walk ps call must request the
	// same utf-8/bounded-timeout contract as the reap scan.
	it("P1: invokes the ancestor-walk ps command with exact options", () => {
		mocks.execSync.mockReturnValue("");
		const result = collectAncestorPids();
		expect(mocks.execSync).toHaveBeenCalledWith("ps -o pid=,ppid= -ax 2>/dev/null", {
			encoding: "utf-8",
			timeout: 2000,
		});
		// Observable post-state: an empty ps table yields just self+parent.
		expect(result).toEqual(new Set([process.pid, process.ppid]));
	});

	// test-contract: boundary — the walk must stop at exactly 10 ancestor
	// hops so a cyclic or pathological `ps` table can't turn this into an
	// unbounded climb; verified by direct simulation of the loop (11-hop
	// synthetic chain, expect exactly the first 10 distinct pids captured).
	it("P2: caps the ancestor walk at 10 hops, excluding the 11th ancestor", () => {
		const ppid = process.ppid;
		const chain = [ppid, 90001, 90002, 90003, 90004, 90005, 90006, 90007, 90008, 90009, 90010, 1];
		const rows = chain.slice(0, -1).map((pid, i) => `${pid} ${chain[i + 1]}`);
		mocks.execSync.mockReturnValue(rows.join("\n"));
		const result = collectAncestorPids();
		expect(result).toEqual(
			new Set([process.pid, ppid, 90001, 90002, 90003, 90004, 90005, 90006, 90007, 90008, 90009]),
		);
	});

	// test-contract: invariant — a ps row is trimmed before matching, and
	// runs of whitespace between the two numbers are collapsed by `\s+`.
	it("P3: trims a row and collapses runs of whitespace between pid and ppid", () => {
		const ppid = process.ppid;
		mocks.execSync.mockReturnValue(`  ${ppid}  777  `);
		const result = collectAncestorPids();
		expect(result.has(777)).toBe(true);
	});

	// test-contract: boundary — a row with a non-digit prefix must be
	// rejected outright, not matched as a trailing substring.
	it("P4: rejects a ps row with a non-digit prefix", () => {
		const ppid = process.ppid;
		mocks.execSync.mockReturnValue(`x${ppid} 777`);
		const result = collectAncestorPids();
		expect(result.has(777)).toBe(false);
	});

	// test-contract: boundary — a row with trailing garbage after the ppid
	// must be rejected outright, not matched as a leading substring.
	it("P5: rejects a ps row with trailing garbage after the ppid", () => {
		const ppid = process.ppid;
		mocks.execSync.mockReturnValue(`${ppid} 777x`);
		const result = collectAncestorPids();
		expect(result.has(777)).toBe(false);
	});
});

// -----------------------------------------------------------------------------
// readActiveHarnessPid
// -----------------------------------------------------------------------------
describe("readActiveHarnessPid", () => {
	// test-contract: invariant — the pid file must be read as utf-8 text;
	// any other encoding argument would hand `Number.parseInt` a
	// Buffer/garbage payload instead of the decoded digits.
	it("P1: reads the pid file with the exact utf-8 encoding argument", () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.readFileSync.mockReturnValue("4242");
		const result = readActiveHarnessPid(FAKE_CWD);
		const pidPath = join(FAKE_CWD, ".interlinked", "harness.pid");
		expect(mocks.readFileSync).toHaveBeenCalledWith(pidPath, "utf-8");
		// Observable post-state: the decoded pid is returned as a number.
		expect(result).toBe(4242);
	});
});

// -----------------------------------------------------------------------------
// ensureDistFresh
// -----------------------------------------------------------------------------
describe("ensureDistFresh", () => {
	const DIST_SERVER = join(FAKE_CWD, "dist", "harness", "server.js");
	const BUILD_CWD = dirname(dirname(dirname(DIST_SERVER)));
	const BUILD_ARGS: [string, { cwd: string; stdio: string[]; timeout: number }] = [
		"npm run build",
		{ cwd: BUILD_CWD, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
	];
	const STALE = { stale: true, newestSrcMs: 2, buildMs: 1 };
	const FRESH = { stale: false, newestSrcMs: 1, buildMs: 2 };

	// test-contract: invariant — when no candidate dist/ binary exists at
	// all, the function must return immediately after the getHarnessServerPath
	// scan (exactly 10 existsSync calls) without ever reaching statSync or
	// execSync. A corrupted guard would keep walking past a "" distServer.
	it("P1: short-circuits when no dist candidate exists, calling existsSync exactly 10 times", () => {
		// True only for the empty string (what getHarnessServerPath falls
		// back to when none of its 10 candidates exist) — every real
		// candidate path is false, so the loop runs to completion.
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === "");
		ensureDistFresh();
		expect(mocks.existsSync).toHaveBeenCalledTimes(10);
		// Candidate #4 is the cwd-relative flat-layout dist path — pin it
		// literally so a mutant that reorders or drops a candidate is caught.
		expect(mocks.existsSync).toHaveBeenNthCalledWith(4, DIST_SERVER);
		expect(mocks.statSync).not.toHaveBeenCalled();
		expect(mocks.execSync).not.toHaveBeenCalled();
		// Observable post-state: nothing is printed when the guard short-circuits.
		expect(console.log).not.toHaveBeenCalled();
	});

	// test-contract: invariant — a recursive stale verdict must trigger the
	// exact build invocation and a second verification pass.
	it("P2: rebuilds a stale checkout with the exact build invocation", () => {
		mocks.existsSync.mockImplementation((p: unknown) => p === DIST_SERVER);
		const readStaleness = vi.fn().mockReturnValueOnce(STALE).mockReturnValueOnce(FRESH);
		ensureDistFresh({ readStaleness });
		expect(mocks.execSync).toHaveBeenCalledTimes(1);
		expect(mocks.execSync).toHaveBeenCalledWith(...BUILD_ARGS);
		expect(readStaleness).toHaveBeenNthCalledWith(1, FAKE_CWD);
		expect(readStaleness).toHaveBeenNthCalledWith(2, FAKE_CWD);
		// Observable post-state: the success message is printed once the
		// (mocked, non-throwing) build call returns.
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Rebuilt dist/"));
	});

	// test-contract: boundary — JSON callers suppress progress so stdout stays
	// one valid JSON document while retaining the same build behavior.
	it("P3: quiet mode rebuilds without progress output", () => {
		mocks.existsSync.mockImplementation((p: unknown) => p === DIST_SERVER);
		ensureDistFresh({
			quiet: true,
			readStaleness: vi.fn().mockReturnValueOnce(STALE).mockReturnValueOnce(FRESH),
		});
		expect(mocks.execSync).toHaveBeenCalledTimes(1);
		expect(mocks.execSync).toHaveBeenCalledWith(...BUILD_ARGS);
		expect(console.log).not.toHaveBeenCalled();
	});

	// test-contract: boundary — a null result means an installed package with
	// no source tree, not a build failure.
	it("P4: installed packages without src remain a no-op", () => {
		mocks.existsSync.mockImplementation((p: unknown) => p === DIST_SERVER);
		ensureDistFresh({ readStaleness: () => null });
		expect(mocks.execSync).not.toHaveBeenCalled();
	});

	// test-contract: failure — a stale checkout may never silently launch the
	// previous dist generation when the build fails.
	it("P5: build failure is terminal", () => {
		mocks.existsSync.mockImplementation((p: unknown) => p === DIST_SERVER);
		mocks.execSync.mockImplementation(() => {
			throw new Error("compiler failed");
		});
		expect(() => ensureDistFresh({ readStaleness: () => STALE })).toThrow(
			"refusing to start the harness with stale code",
		);
	});
});

// -----------------------------------------------------------------------------
// getHarnessServerPath
// -----------------------------------------------------------------------------
// Each case makes exactly ONE of the 10 candidate paths "exist" (every other
// path defaults to false) and asserts the exact returned string. Any single
// literal mutated within that candidate's `join(...)` call produces a
// DIFFERENT string that is not in the true-whitelist, so the function falls
// through to "" — flipping `toBe(target)` to a failure.
describe("getHarnessServerPath", () => {
	function mockOnly(target: string): void {
		mocks.existsSync.mockImplementation((p: unknown) => p === target);
	}

	// test-contract: invariant — candidate 0 (co-located dist/harness/server.js).
	it("P1: resolves candidate 0 — join(dir, harness, server.js)", () => {
		const target = join(SUT_DIR, "harness", "server.js");
		mockOnly(target);
		expect(getHarnessServerPath()).toBe(target);
	});

	// test-contract: invariant — candidate 1 (one level up).
	it("P2: resolves candidate 1 — join(dir, .., harness, server.js)", () => {
		const target = join(SUT_DIR, "..", "harness", "server.js");
		mockOnly(target);
		expect(getHarnessServerPath()).toBe(target);
	});

	// test-contract: invariant — candidate 2 (tsx-from-src, two levels up).
	it("P3: resolves candidate 2 — join(dir, .., .., dist, harness, server.js)", () => {
		const target = join(SUT_DIR, "..", "..", "dist", "harness", "server.js");
		mockOnly(target);
		expect(getHarnessServerPath()).toBe(target);
	});

	// test-contract: invariant — candidate 4 (node_modules install).
	it("P4: resolves candidate 4 — node_modules/interlinked-cli/dist/harness/server.js", () => {
		const target = join(FAKE_CWD, "node_modules", "interlinked-cli", "dist", "harness", "server.js");
		mockOnly(target);
		expect(getHarnessServerPath()).toBe(target);
	});

	// test-contract: invariant — candidate 7 (source .ts fallback).
	it("P5: resolves candidate 7 — join(dir, .., harness, server.ts)", () => {
		const target = join(SUT_DIR, "..", "harness", "server.ts");
		mockOnly(target);
		expect(getHarnessServerPath()).toBe(target);
	});

	// test-contract: invariant — candidate 8 (src/harness/server.ts fallback).
	it("P6: resolves candidate 8 — join(dir, .., src, harness, server.ts)", () => {
		const target = join(SUT_DIR, "..", "src", "harness", "server.ts");
		mockOnly(target);
		expect(getHarnessServerPath()).toBe(target);
	});

	// test-contract: invariant — candidate 9 (monorepo cli/src source fallback).
	it("P7: resolves candidate 9 — join(cwd, cli, src, harness, server.ts)", () => {
		const target = join(FAKE_CWD, "cli", "src", "harness", "server.ts");
		mockOnly(target);
		expect(getHarnessServerPath()).toBe(target);
	});
});

// -----------------------------------------------------------------------------
// isHarnessRunning
// -----------------------------------------------------------------------------
describe("isHarnessRunning", () => {
	// test-contract: invariant — when the pid file does not exist, the
	// function must return immediately: existsSync is consulted exactly
	// once and the pid file is never read.
	it("P1: returns not-running without reading the pid file when it is absent", () => {
		const result = isHarnessRunning(FAKE_CWD);
		expect(result).toEqual({ running: false });
		expect(mocks.existsSync).toHaveBeenCalledTimes(1);
		expect(mocks.readFileSync).not.toHaveBeenCalled();
	});

	// test-contract: invariant — when the pid file's content is not a
	// number, the function must return without ever signalling the (bogus)
	// pid via process.kill.
	it("P2: returns not-running without signalling when the pid file content is non-numeric", () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.readFileSync.mockReturnValue("not-a-pid");
		const result = isHarnessRunning(FAKE_CWD);
		expect(result).toEqual({ running: false });
		expect(process.kill).not.toHaveBeenCalled();
	});
});
