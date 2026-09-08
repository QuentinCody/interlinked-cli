import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
import { parseWire, wireArray, wireString } from "../lib/value-validation.js";
import { nonNull } from "../lib/non-null.js";
// Unit tests for behavioral-diff-checks-reintro.ts — the re-introduces-removed-code
// detector. Every I/O boundary (`node:fs` for findRepoCwd, `node:child_process`
// for the git plumbing behind getStagedDiff/gitLogContainsRemoval) is mocked so
// each branch can be driven precisely without a real repo. `node:path` is left
// real — dirname/resolve are pure and deterministic.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
	existsSync: vi.fn<(p: string) => boolean>(),
	statSync: vi.fn<(p: string) => { isFile: () => boolean }>(),
}));
vi.mock("node:fs", () => fsMock);

const cpMock = vi.hoisted(() => ({
	spawnSync: vi.fn(),
}));
vi.mock("node:child_process", () => cpMock);

import { checkReintroducesRemovedCode } from "./behavioral-diff-checks-reintro.js";
import type { SessionTrajectory } from "./types.js";

type SpawnResult = { status: number; stdout: string };

// Per-test dispatch tables, keyed by the piece of the git command that
// distinguishes calls: diff by file path, log by the `-S<phrase>` phrase,
// show by commit sha.
let diffConfig: Map<string, SpawnResult>;
let logConfig: Map<string, SpawnResult | "throw">;
let showConfig: Map<string, SpawnResult>;

beforeEach(() => {
	diffConfig = new Map();
	logConfig = new Map();
	showConfig = new Map();

	// Default fs behavior: the file exists, is a file, and its own directory
	// is already a git repo root (findRepoCwd returns on the first probe).
	// Individual tests override this to exercise the walk-up-to-root path.
	fsMock.existsSync.mockImplementation(() => true);
	fsMock.statSync.mockImplementation(() => ({ isFile: () => true }));

	cpMock.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
		const sub = args[2];
		if (sub === "diff") {
			const file = nonNull(args[args.length - 1]);
			return diffConfig.get(file) ?? { status: 1, stdout: "" };
		}
		if (sub === "log") {
			const sArg = args.find((a) => a.startsWith("-S"));
			const phrase = sArg ? sArg.slice(2) : "";
			const cfg = logConfig.get(phrase);
			if (cfg === "throw") throw new Error("spawnSync: simulated EMFILE");
			return cfg ?? { status: 0, stdout: "" };
		}
		if (sub === "show") {
			const sha = nonNull(args[args.length - 1]);
			return showConfig.get(sha) ?? { status: 1, stdout: "" };
		}
		return { status: 1, stdout: "" };
	});
});

function makeSession(files: string[]): SessionTrajectory {
	return ({ ...completeSessionFixture(), ...{
		files_written: new Set(files),
	} });
}

function diffAdding(...lines: string[]): string {
	return `diff --git a/x b/x\n@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
}

describe("checkReintroducesRemovedCode — negative (must NOT fire)", () => {
	it("N1: a file with no staged diff is skipped (line99 true) even when another file matches", () => {
		const file = "/repo/src/empty.ts";
		// No diffConfig entry registered => spawnSync default {status:1, stdout:""}
		// => getStagedDiff returns "" for both the primary and fallback call.
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
	});

	it("N2: an added line under 8 chars is skipped (line108 true) and a short extracted phrase short-circuits gitLogContainsRemoval (line33 true) without any git-log call", () => {
		const file = "/repo/src/short.ts";
		diffConfig.set(file, {
			status: 0,
			// "ok" trims to 2 chars (< 8, hits line108 continue).
			// "xit(); pad" trims to >= 8 chars, matches the xit( marker, and
			// extractDistinctivePhrase yields "xit()" (5 chars, < 8) so
			// gitLogContainsRemoval short-circuits at line33 without calling git.
			stdout: diffAdding("ok", "xit(); pad"),
		});
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		// No "log" subcommand call happened — confirms the length<8 short-circuit,
		// not a git-log miss, produced the empty result.
		const logCalls = cpMock.spawnSync.mock.calls.filter(
			(c: unknown[]) => (parseWire(c[1], wireArray(wireString), "test JSON value"))[2] === "log",
		);
		expect(logCalls).toEqual([]);
	});

	it("N3: an added line with no loud-pattern marker is ignored while repo resolution succeeds on the first probe", () => {
		const file = "/repo/src/plain.ts";
		diffConfig.set(file, { status: 0, stdout: diffAdding("const x = 1; // plain change") });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
	});

	it("N4: findRepoCwd walks to the filesystem root without finding .git, so the file is skipped (line101 true)", () => {
		fsMock.existsSync.mockImplementation(() => false);
		const file = "/nogit/deep/path.ts";
		diffConfig.set(file, {
			status: 0,
			stdout: diffAdding('console.log("would need a repo to check");'),
		});
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
	});

	it("N5: gitLogContainsRemoval exhausts every candidate commit without finding a removal (branch65 both sides, line72 return null)", () => {
		const file = "/repo/src/history.ts";
		const phrase = 'console.log("historical debug marker")';
		diffConfig.set(file, {
			status: 0,
			stdout: diffAdding(`console.log("historical debug marker");`),
		});
		logConfig.set(phrase, {
			status: 0,
			stdout: "aaaa000011112222333344445555666677778888 introduce\nbbbb000011112222333344445555666677778888 unrelated\n",
		});
		// First candidate: `git show` itself fails (falsy stdout) -> branch65 true, continue.
		showConfig.set("aaaa000011112222333344445555666677778888", { status: 1, stdout: "" });
		// Second candidate: `git show` succeeds but only ADDS the phrase (no "-" line) ->
		// branch65 false, inner loop finds no match, falls through.
		showConfig.set("bbbb000011112222333344445555666677778888", {
			status: 0,
			stdout: `diff --git a/x b/x\n+console.log("historical debug marker");\n`,
		});
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
	});

	it("N6: a thrown spawnSync error during git log is swallowed by the catch block (line74)", () => {
		const file = "/repo/src/throws.ts";
		const phrase = 'console.log("this will explode")';
		diffConfig.set(file, { status: 0, stdout: diffAdding(`console.log("this will explode");`) });
		logConfig.set(phrase, "throw");
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
	});
});

describe("checkReintroducesRemovedCode — positive (must fire)", () => {
	it("P1: an unbalanced marker (no parens) falls back to a 30-char slice (line160) and still finds its prior removal", () => {
		const file = "/repo/src/breakpoint.ts";
		const rawLine = "debugger; // leftover breakpoint marker for old flow";
		const phrase = rawLine.slice(0, 30);
		const sha = "deadbeef00000000000000000000000000000000";
		diffConfig.set(file, { status: 0, stdout: diffAdding(rawLine) });
		logConfig.set(phrase, { status: 0, stdout: `${sha} removed debug leftover\n` });
		showConfig.set(sha, { status: 0, stdout: `diff --git a/x b/x\n-${phrase}\n` });

		const results = checkReintroducesRemovedCode(makeSession([file]));

		expect(results).toEqual([
			{
				source: "structural",
				name: "reintroduces_removed_code",
				severity: "warning",
				message: `Re-introduces \`${phrase}\` — a prior commit removed this (last removal: ${sha} removed debug leftover). Verify the cleanup wasn't intentional before re-adding.`,
				file,
				determinism: "fully_deterministic",
			},
		]);
	});

	it("P2: per-file cap, duplicate-phrase dedup, and the total cap all bound the result set (lines 97, 105, 106, 115)", () => {
		function found(phrase: string, sha: string): void {
			logConfig.set(phrase, { status: 0, stdout: `${sha} removed it\n` });
			showConfig.set(sha, { status: 0, stdout: `diff --git a/x b/x\n-${phrase}\n` });
		}

		const p1 = 'console.log("p1 marker padded long enough")';
		const p2 = 'console.log("p2 marker padded long enough")';
		const p3 = 'console.log("p3 marker padded long enough")';
		const p4 = 'console.log("p4 marker padded long enough")';
		const p5 = 'console.log("p5 marker padded long enough")';
		const p6 = 'console.log("p6 marker padded long enough")';
		const p7 = 'console.log("p7 marker padded long enough")';
		found(p1, "s1000000000000000000000000000000000000001");
		found(p2, "s2000000000000000000000000000000000000002");
		found(p3, "s3000000000000000000000000000000000000003");
		found(p4, "s4000000000000000000000000000000000000004");
		found(p5, "s5000000000000000000000000000000000000005");
		found(p6, "s6000000000000000000000000000000000000006");
		found(p7, "s7000000000000000000000000000000000000007");

		const file1 = "/repo/src/f1.ts";
		const file2 = "/repo/src/f2.ts";
		const file3 = "/repo/src/f3.ts";
		const file4 = "/repo/src/f4.ts";

		// file1: p1 pushed, a DUPLICATE p1 line skipped (dedup, line115 true),
		// p2 pushed (perFile now 2), p3 blocked by the per-file cap (line105 true).
		diffConfig.set(file1, {
			status: 0,
			stdout: diffAdding(
				`console.log("p1 marker padded long enough");`,
				`console.log("p1 marker padded long enough");`,
				`console.log("p2 marker padded long enough");`,
				`console.log("p3 marker padded long enough");`,
			),
		});

		// file2: p4 and p5 both pushed (total reaches 4).
		diffConfig.set(file2, {
			status: 0,
			stdout: diffAdding(
				`console.log("p4 marker padded long enough");`,
				`console.log("p5 marker padded long enough");`,
			),
		});

		// file3: p6 pushed (total reaches 5, MAX_TOTAL) then p7 blocked by the
		// total cap (line106 true) before its own perFile cap would matter.
		diffConfig.set(file3, {
			status: 0,
			stdout: diffAdding(
				`console.log("p6 marker padded long enough");`,
				`console.log("p7 marker padded long enough");`,
			),
		});

		// file4: never reached — the outer loop's top-of-iteration check
		// (line97 true) breaks before getStagedDiff is even called for it.
		const results = checkReintroducesRemovedCode(
			makeSession([file1, file2, file3, file4]),
		);

		expect(results.length).toBe(5);
		expect(results.map((r) => ({ file: r.file, name: r.name }))).toEqual([
			{ file: file1, name: "reintroduces_removed_code" },
			{ file: file1, name: "reintroduces_removed_code" },
			{ file: file2, name: "reintroduces_removed_code" },
			{ file: file2, name: "reintroduces_removed_code" },
			{ file: file3, name: "reintroduces_removed_code" },
		]);
		expect(results.every((r) => r.determinism === "fully_deterministic")).toBe(true);
		expect(results[0]?.message).toContain(p1);
		expect(results[1]?.message).toContain(p2);
		expect(results[2]?.message).toContain(p4);
		expect(results[3]?.message).toContain(p5);
		expect(results[4]?.message).toContain(p6);
		// No call ever resolved p7's diff-suppression path into a 6th finding.
		expect(results.some((r) => r.message.includes(p7))).toBe(false);
		// file4 was never even asked for its diff.
		const diffCalls = cpMock.spawnSync.mock.calls.filter(
			(c: unknown[]) => (parseWire(c[1], wireArray(wireString), "test JSON value"))[2] === "diff",
		);
		expect(diffCalls.some((c: unknown[]) => (parseWire(c[1], wireArray(wireString), "test JSON value")).includes(file4))).toBe(false);
	});
});
