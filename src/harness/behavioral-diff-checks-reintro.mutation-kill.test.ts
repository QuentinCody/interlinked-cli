import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
import { nonNull } from "../lib/non-null.js";
// ===========================================================================
// Mutation-kill companion for src/harness/behavioral-diff-checks-reintro.ts.
//
// Every survivor here is only reachable through the exported
// `checkReintroducesRemovedCode` — `gitLogContainsRemoval`, `findRepoCwd`,
// and `extractDistinctivePhrase` are module-private. Same mocking strategy
// as the hand-written companion `behavioral-diff-checks-reintro.test.ts`
// (node:fs + node:child_process fully mocked, node:path left real), kept in
// a separate file so this campaign's edits never collide with that one.
//
// Exact expected substrings (regex matches, extractDistinctivePhrase slices,
// directory-walk paths) were hand-derived by reading the source, then
// cross-checked with a throwaway calculator script that copies the pure
// string logic verbatim (scratch/fleet-r3/reintro-calc.mjs) to eliminate
// arithmetic slips — no test/typecheck/mutation runner was invoked.
// ===========================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
	existsSync: vi.fn<(p: string) => boolean>(),
	statSync: vi.fn<(p: string) => { isFile: () => boolean }>(),
}));
vi.mock("node:fs", () => fsMock);

const cpMock = vi.hoisted(() => ({
	spawnSync: vi.fn<(...args: SpawnArgs) => SpawnResult>(),
}));
vi.mock("node:child_process", () => cpMock);

import { checkReintroducesRemovedCode } from "./behavioral-diff-checks-reintro.js";
import type { SessionTrajectory } from "./types.js";

type SpawnResult = { status: number; stdout: string };
type SpawnArgs = [cmd: string, args: string[], ...rest: unknown[]];

let diffConfig: Map<string, SpawnResult>;
let logConfig: Map<string, SpawnResult | "throw">;
let showConfig: Map<string, SpawnResult>;

beforeEach(() => {
	diffConfig = new Map();
	logConfig = new Map();
	showConfig = new Map();

	// Clear call history left over from the previous test. mockImplementation
	// alone does not reset `.mock.calls`, so callsFor() would otherwise return
	// every spawnSync invocation since the file's mocks were created instead
	// of just this test's — the cause of the growing-count failures this fixes.
	vi.clearAllMocks();

	// Default: file exists, is a file, and its own directory is already a
	// git root — individual tests override existsSync/statSync to drive
	// findRepoCwd's walk-up-to-root branches precisely.
	fsMock.existsSync.mockImplementation(() => true);
	fsMock.statSync.mockImplementation(() => ({ isFile: () => true }));

	cpMock.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
		const sub = args[2];
		if (sub === "diff") {
			// SAFETY: every diff invocation in this file's source ends the args
			// array with the target file path (a string literal built by the
			// caller), never a nested array or object.
			const file = nonNull(args[args.length - 1]);
			return diffConfig.get(file) ?? { status: 1, stdout: "" };
		}
		if (sub === "log") {
			// Defensive typeof guard: the !repoCwd->false mutant drives a
			// literal `null` into this array's "-C" slot, and Array.find's
			// predicate must not throw on a non-string element.
			const sArg = args.find((a) => typeof a === "string" && a.startsWith("-S"));
			const phrase = sArg ? sArg.slice(2) : "";
			const cfg = logConfig.get(phrase);
			if (cfg === "throw") throw new Error("spawnSync: simulated EMFILE");
			return cfg ?? { status: 0, stdout: "" };
		}
		if (sub === "show") {
			// SAFETY: every show invocation in this file's source ends the args
			// array with the commit sha (a string extracted from the log output),
			// never a nested array or object.
			const sha = nonNull(args[args.length - 1]);
			return showConfig.get(sha) ?? { status: 1, stdout: "" };
		}
		return { status: 1, stdout: "" };
	});
});

function makeSession(files: string[]): SessionTrajectory {
	// SAFETY: checkReintroducesRemovedCode reads only `files_written` off the
	// session, so a minimal object carrying just that field is sound for
	// every call site exercised in this file (matches the existing
	// hand-written companion's makeSession).
	return ({ ...completeSessionFixture(), ...{
		files_written: new Set(files),
	} });
}

function diffAdding(...lines: string[]): string {
	return `diff --git a/x b/x\n@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
}

function callsFor(sub: string): SpawnArgs[] {
	return cpMock.spawnSync.mock.calls.filter((c) => c[1][2] === sub);
}

function logPhrase(call: SpawnArgs): string | undefined {
	const sArg = call[1].find((a) => typeof a === "string" && a.startsWith("-S"));
	return sArg?.slice(2);
}

// ===========================================================================
// LOUD_REINTRO_RE (module-level regex literal) — 17 survivors, all Regex
// mutations of a single \s*/\S*/\s+/\S+/\b token within one alternative.
// Killed by proving the loud-marker match itself flips: each crafted line
// carries exactly one whitespace gap tailored so the ORIGINAL regex matches
// and the mutated regex does not (or vice versa is unreachable here — every
// listed mutant strictly narrows the match at its own gap). A dropped match
// means `if (!loud) continue` fires and gitLogContainsRemoval's "log"
// subcommand is never invoked for that line — MAX_PER_FILE/MAX_TOTAL never
// engage here since none of these phrases have a configured "found" commit,
// so every line in a single diff is reachable regardless of count.
// ===========================================================================
describe("checkReintroducesRemovedCode — LOUD_REINTRO_RE regex-position mutants (mutation-kill)", () => {
	// test-contract: boundary — a literal space at any \s* gap inside console.log( still matches; kills 8ba0818b/55c3e46e/d7b35a52.
	it("ALT-A console.log — spaced gaps around dot/word/paren all still match", () => {
		const file = "/repo/src/alt-a.ts";
		const line = 'console . log ("triple gap marker for regex position test");';
		const phrase = 'console . log ("triple gap marker for regex position test")';
		diffConfig.set(file, { status: 0, stdout: diffAdding(line) });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		const logCalls = callsFor("log");
		expect(logCalls.length).toBe(1);
		expect(logPhrase(logCalls[0]!)).toBe(phrase);
	});

	// test-contract: boundary — zero-space and one-space gaps after // both still match TODO; kills d9fb6a22/6a70a3f1.
	it("ALT-B TODO comment — zero-space and one-space gaps after // both match", () => {
		const file = "/repo/src/alt-b.ts";
		const zeroSpace = "//TODO: revisit legacy branch soon";
		const oneSpace = "// TODO: revisit legacy branch again";
		diffConfig.set(file, { status: 0, stdout: diffAdding(zeroSpace, oneSpace) });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		const phrases = callsFor("log").map((c) => logPhrase(c));
		expect(phrases).toEqual(["//TODO: revisit legacy branch ", "// TODO: revisit legacy branch"]);
	});

	// test-contract: boundary — ALT-C `\bas\s+any\b`: two spaces between
	// as/any must match (kills \s+->\s exactly-one, 040ff66b — \s can only
	// consume ONE of the two), and one space must also match (kills
	// \s+->\S+, 037b5398 — \S+ cannot consume a space at all).
	it("ALT-C as-any — two-space and one-space gaps both match", () => {
		const file = "/repo/src/alt-c.ts";
		const twoSpace = "let y = x as  any;";
		const oneSpace = "let w = q as any; keep";
		diffConfig.set(file, { status: 0, stdout: diffAdding(twoSpace, oneSpace) });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		const phrases = callsFor("log").map((c) => logPhrase(c));
		expect(phrases).toEqual(["as  any;", "as any; keep"]);
	});

	// test-contract: boundary — ALT-E `\bxit\s*\(`: zero spaces before the
	// paren must match (kills \s*->\s exactly-one, 7d98c865), and one space
	// must also match (kills \s*->\S*, 56f6fa1c).
	it("ALT-E xit( — zero-space and one-space gaps before the paren both match", () => {
		const file = "/repo/src/alt-e.ts";
		const zeroSpace = 'xit("skip this test case for now");';
		const oneSpace = 'xit ("skip this test case again");';
		diffConfig.set(file, { status: 0, stdout: diffAdding(zeroSpace, oneSpace) });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		const phrases = callsFor("log").map((c) => logPhrase(c));
		expect(phrases).toEqual([
			'xit("skip this test case for now")',
			'xit ("skip this test case again")',
		]);
	});

	// test-contract: boundary — ALT-F `\bxdescribe\s*\(`: zero-space (kills
	// \s*->\s exactly-one, 030dc8e7) and one-space (kills \s*->\S*, 839ed256)
	// gaps before the paren both match.
	it("ALT-F xdescribe( — zero-space and one-space gaps before the paren both match", () => {
		const file = "/repo/src/alt-f.ts";
		const zeroSpace = 'xdescribe("disabled suite block here");';
		const oneSpace = 'xdescribe ("disabled suite again here");';
		diffConfig.set(file, { status: 0, stdout: diffAdding(zeroSpace, oneSpace) });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		const phrases = callsFor("log").map((c) => logPhrase(c));
		expect(phrases).toEqual([
			'xdescribe("disabled suite block here")',
			'xdescribe ("disabled suite again here")',
		]);
	});

	// test-contract: boundary — zero/zero, space/zero, zero/space gaps in .skip( all match; kills 2671083e/89be3bb3/116339a2/5e83c11a.
	it("ALT-G .skip( — zero/zero, space/zero, and zero/space gap combinations all match", () => {
		const file = "/repo/src/alt-g.ts";
		const zeroZero = 'thing.skip("old integration test path");';
		const spaceZero = 'thing. skip("first gap space test case");';
		const zeroSpace = 'thing.skip ("second gap space test case");';
		diffConfig.set(file, { status: 0, stdout: diffAdding(zeroZero, spaceZero, zeroSpace) });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		const phrases = callsFor("log").map((c) => logPhrase(c));
		expect(phrases).toEqual([
			'.skip("old integration test path")',
			'. skip("first gap space test case")',
			'.skip ("second gap space test case")',
		]);
	});

	// test-contract: boundary — ALT-H `\/\/\s*@ts-(?:ignore|expect-error)\b`:
	// zero-space (kills \s*->\s exactly-one, 17797c24) and one-space (kills
	// \s*->\S*, f9751980) gaps after // both match.
	it("ALT-H @ts-ignore — zero-space and one-space gaps after // both match", () => {
		const file = "/repo/src/alt-h.ts";
		const zeroSpace = "//@ts-ignore revisit this suppression soon";
		const oneSpace = "// @ts-ignore revisit suppression again";
		diffConfig.set(file, { status: 0, stdout: diffAdding(zeroSpace, oneSpace) });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		const phrases = callsFor("log").map((c) => logPhrase(c));
		expect(phrases).toEqual(["//@ts-ignore revisit this supp", "// @ts-ignore revisit suppress"]);
	});
});

// ===========================================================================
// checkReintroducesRemovedCode — top-level per-file/per-line guards
// ===========================================================================
describe("checkReintroducesRemovedCode — top-level guard mutants (mutation-kill)", () => {
	// test-contract: boundary — kills `!diff` -> `false` (1a083075cc8a671a).
	// With no staged diff, findRepoCwd(file) must never even be invoked; its
	// first statement is `existsSync(file)`, so the RAW file path never
	// appearing in existsSync's call list proves the `continue` fired.
	it("empty diff short-circuits before findRepoCwd is ever consulted", () => {
		const file = "/repo/src/emptydiff-marker.ts";
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		const existsCalls = fsMock.existsSync.mock.calls.map((c) => c[0]);
		expect(existsCalls).not.toContain(file);
	});

	// test-contract: boundary — kills `!repoCwd` -> `false` (1013684b9c356711).
	// A non-empty diff whose file resolves to no git root (existsSync always
	// false) must skip the per-line loop entirely: zero "log" subcommand
	// calls, even though the added line carries a valid loud marker.
	it("unresolvable repo root short-circuits before any git-log call", () => {
		const file = "/repo/src/norepo-marker.ts";
		fsMock.existsSync.mockImplementation(() => false);
		diffConfig.set(file, {
			status: 0,
			stdout: diffAdding("debugger; needs a repo to check removal history"),
		});
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		expect(callsFor("log")).toEqual([]);
	});

	// test-contract: boundary — the 8-char floor must apply to the TRIMMED line, not the raw one; kills a0aa8bb2.
	it("an added line under 8 chars ONLY once trimmed is skipped, not regex-matched", () => {
		const file = "/repo/src/untrimmed-padding.ts";
		diffConfig.set(file, { status: 0, stdout: diffAdding("as any   ") });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		expect(callsFor("log")).toEqual([]);
	});

	// test-contract: boundary — an exactly-8-char line and its exactly-8-char phrase both clear the <8 floor; kills fa649b6d/e4f2d3eb.
	it("an exactly-8-char line and its exactly-8-char phrase both clear the floor", () => {
		const file = "/repo/src/exactly-eight.ts";
		diffConfig.set(file, { status: 0, stdout: diffAdding("debugger") });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		const logCalls = callsFor("log");
		expect(logCalls.length).toBe(1);
		expect(logPhrase(logCalls[0]!)).toBe("debugger");
	});

	// test-contract: boundary — a long phrase and a long commit subject are both truncated in the message; kills 493a117b/8a028e21.
	it("a long phrase and a long commit subject are both truncated in the message", () => {
		const file = "/repo/src/longslice.ts";
		const longLine =
			'console.log("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");';
		const phrase =
			'console.log("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX")';
		const sha = "cafe000011112222333344445555666677778888";
		const longMessage =
			"this is an intentionally long commit subject line that exceeds seventy characters for slice testing";
		const commitLine = `${sha} ${longMessage}`;
		diffConfig.set(file, { status: 0, stdout: diffAdding(longLine) });
		logConfig.set(phrase, { status: 0, stdout: `${commitLine}\n` });
		showConfig.set(sha, { status: 0, stdout: `diff --git a/x b/x\n-${phrase}\n` });

		const results = checkReintroducesRemovedCode(makeSession([file]));

		expect(results).toEqual([
			{
				source: "structural",
				name: "reintroduces_removed_code",
				severity: "warning",
				message: `Re-introduces \`${phrase.slice(0, 80)}\` — a prior commit removed this (last removal: ${commitLine.slice(0, 70)}). Verify the cleanup wasn't intentional before re-adding.`,
				file,
				determinism: "fully_deterministic",
			},
		]);
	});
});

// ===========================================================================
// extractDistinctivePhrase — paren-balance walk (private; exercised only
// through checkReintroducesRemovedCode's git-log call argument)
// ===========================================================================
describe("extractDistinctivePhrase — paren-balance mutants (mutation-kill)", () => {
	// test-contract: boundary — a stray close-paren with no preceding open-paren must not truncate the phrase; kills c344a2c0.
	it("a stray close-paren with no preceding open-paren does not truncate the phrase", () => {
		const file = "/repo/src/strayparen.ts";
		const line = "debugger; oops) trailing content after the stray close paren marker";
		diffConfig.set(file, { status: 0, stdout: diffAdding(line) });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		const logCalls = callsFor("log");
		expect(logCalls.length).toBe(1);
		expect(logPhrase(logCalls[0]!)).toBe("debugger; oops) trailing conte");
	});

	// test-contract: boundary — a nested paren pair must not end the balance walk early; kills 1ae150a1/a1cc6723.
	it("a nested paren pair inside the call does not end the walk early", () => {
		const file = "/repo/src/nested.ts";
		const line = 'console.log((a) + "text padding to exceed slice boundaries nicely");';
		diffConfig.set(file, { status: 0, stdout: diffAdding(line) });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		const logCalls = callsFor("log");
		expect(logCalls.length).toBe(1);
		expect(logPhrase(logCalls[0]!)).toBe(
			'console.log((a) + "text padding to exceed slice boundaries nicely")',
		);
	});
});

// ===========================================================================
// findRepoCwd — walk-up-to-root loop (private; exercised only through
// whether checkReintroducesRemovedCode reaches a "log" call for the file)
// ===========================================================================
describe("findRepoCwd — walk-up-to-root mutants (mutation-kill)", () => {
	// test-contract: boundary — dirname(file) start reaches a 10-hop-deep .git exactly within budget; kills a79ff09d.
	it("dirname(file) start reaches a 10-hop-deep .git exactly within budget", () => {
		const file = "/D1/D2/D3/D4/D5/D6/D7/D8/D9/D10/deepA.ts";
		fsMock.existsSync.mockImplementation((p: string) => p === file || p === "/D1/.git");
		fsMock.statSync.mockImplementation(() => ({ isFile: () => true }));
		diffConfig.set(file, { status: 0, stdout: diffAdding("debugger; deepA repo walk marker text") });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		expect(callsFor("log").length).toBe(1);
	});

	// test-contract: boundary — file-as-directory start needs an 11th hop the 10-check budget refuses; kills 767ca23a/4d52a52b/177df52d/00276c6b.
	it("file-as-directory start needs an 11th hop that the 10-check budget refuses", () => {
		const file = "/E1/E2/E3/E4/E5/E6/E7/E8/E9/E10/deepB.ts";
		fsMock.existsSync.mockImplementation((p: string) => p === "/E1/.git");
		diffConfig.set(file, { status: 0, stdout: diffAdding("debugger; deepB repo walk marker text") });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		expect(callsFor("log")).toEqual([]);
	});

	// test-contract: boundary — a .git one level up must be found, not short-circuited by the root-reached check; kills 9ded0049/ac4d01dc.
	it("a .git one level above the file's directory is still found, not short-circuited", () => {
		const file = "/A/B/deep2.ts";
		fsMock.existsSync.mockImplementation((p: string) => p === file || p === "/A/.git");
		diffConfig.set(file, { status: 0, stdout: diffAdding("debugger; second level repo marker") });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		expect(callsFor("log").length).toBe(1);
	});

	// test-contract: boundary — with no real .git anywhere the walk must exhaust to the root and find nothing; kills f1d5d5f3/21942876.
	it("with no real .git anywhere, the walk exhausts to the root and finds nothing", () => {
		const file = "/repo3/src/x.ts";
		fsMock.existsSync.mockImplementation((p: string) => !p.endsWith(".git"));
		fsMock.statSync.mockImplementation(() => ({ isFile: () => true }));
		diffConfig.set(file, { status: 0, stdout: diffAdding("debugger; no real git anywhere marker") });
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		expect(callsFor("log")).toEqual([]);
	});
});

// ===========================================================================
// gitLogContainsRemoval — git log/show plumbing (private; exercised only
// through checkReintroducesRemovedCode's pushed result / spawnSync calls)
// ===========================================================================
describe("gitLogContainsRemoval — git log/show plumbing mutants (mutation-kill)", () => {
	// test-contract: boundary — a non-zero log status with populated stdout must be rejected before any show call; kills f1d74e0c/ff339406/ebc4583e.
	it("a non-zero log status with populated stdout is rejected before any show call", () => {
		const file = "/repo/src/badstatus.ts";
		const phrase = 'console.log("bad status marker padded long enough")';
		const line = 'console.log("bad status marker padded long enough");';
		diffConfig.set(file, { status: 0, stdout: diffAdding(line) });
		logConfig.set(phrase, {
			status: 1,
			stdout: "shouldnotbeused00000000000000000000000000 pretend commit\n",
		});
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
		expect(callsFor("show")).toEqual([]);
	});

	// test-contract: boundary — a bad-status show with matching content must lose to the next good candidate; kills e18721cd/e819c789/94a08e9c.
	it("a bad-status show with matching content loses to the next good candidate", () => {
		const file = "/repo/src/twocandidate.ts";
		const phrase = 'console.log("two candidate marker padded long enough")';
		const line = 'console.log("two candidate marker padded long enough");';
		const shaBad = "bad00000111122223333444455556666777788880";
		const shaGood = "good0000111122223333444455556666777788880";
		const badMessage = "bad candidate should be skipped";
		const goodMessage = "good candidate should win";
		diffConfig.set(file, { status: 0, stdout: diffAdding(line) });
		logConfig.set(phrase, {
			status: 0,
			stdout: `${shaBad} ${badMessage}\n${shaGood} ${goodMessage}\n`,
		});
		showConfig.set(shaBad, { status: 1, stdout: `diff --git a/x b/x\n-${phrase}\n` });
		showConfig.set(shaGood, { status: 0, stdout: `diff --git a/x b/x\n-${phrase}\n` });

		const results = checkReintroducesRemovedCode(makeSession([file]));

		const goodCommitLine = `${shaGood} ${goodMessage}`;
		expect(results).toEqual([
			{
				source: "structural",
				name: "reintroduces_removed_code",
				severity: "warning",
				message: `Re-introduces \`${phrase.slice(0, 80)}\` — a prior commit removed this (last removal: ${goodCommitLine.slice(0, 70)}). Verify the cleanup wasn't intentional before re-adding.`,
				file,
				determinism: "fully_deterministic",
			},
		]);
	});

	// test-contract: boundary — a diff file-header --- line must be excluded even though it contains the phrase; kills aaba75db.
	it("a diff file-header --- line is excluded even though it contains the phrase", () => {
		const file = "/repo/src/headerline.ts";
		const phrase = 'console.log("HEADERMARKERTEXTLONGENOUGH")';
		const line = 'console.log("HEADERMARKERTEXTLONGENOUGH");';
		const sha = "head0000111122223333444455556666777788880";
		diffConfig.set(file, { status: 0, stdout: diffAdding(line) });
		logConfig.set(phrase, { status: 0, stdout: `${sha} header line only candidate\n` });
		showConfig.set(sha, {
			status: 0,
			stdout: `diff --git a/x b/x\n--- ${phrase}\n+++ b/x\n`,
		});
		const results = checkReintroducesRemovedCode(makeSession([file]));
		expect(results).toEqual([]);
	});

	// test-contract: boundary — a log line with leading whitespace must still resolve its sha, not get dropped by the !sha guard; kills 006a8184.
	it("a log line with leading whitespace still resolves its sha correctly", () => {
		const file = "/repo/src/leadingspace.ts";
		const phrase = "debugger; leading space repro ";
		const line = "debugger; leading space repro marker text here";
		const sha = "cafeleadingspace000000000000000000000000000";
		const subject = "subject text here";
		diffConfig.set(file, { status: 0, stdout: diffAdding(line) });
		logConfig.set(phrase, { status: 0, stdout: ` ${sha} ${subject}\n` });
		showConfig.set(sha, { status: 0, stdout: `diff --git a/x b/x\n-${phrase}\n` });

		const results = checkReintroducesRemovedCode(makeSession([file]));

		const commitLine = `${sha} ${subject}`;
		expect(results).toEqual([
			{
				source: "structural",
				name: "reintroduces_removed_code",
				severity: "warning",
				message: `Re-introduces \`${phrase.slice(0, 80)}\` — a prior commit removed this (last removal: ${commitLine.slice(0, 70)}). Verify the cleanup wasn't intentional before re-adding.`,
				file,
				determinism: "fully_deterministic",
			},
		]);
	});
});
