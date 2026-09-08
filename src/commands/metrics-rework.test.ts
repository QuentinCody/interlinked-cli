import { parseWire, wireArray, wireNumber, wireObject, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// metrics-rework unit tests — pure core (diff hunks → blame ages → classify)
// plus the live command against real throwaway git repos
// ===========================================
// The parsers and the age classification are pure and tested against fixtures.
// `metricsReworkCommand` shells out to git for every number it prints, so it is
// exercised against REAL repositories built in a tmpdir with controlled
// committer dates — mocking child_process for these would prove nothing about
// the `git diff -U0` / `git blame --porcelain` contracts the parsers assume.
//
// ONE test mocks `node:child_process` (the last describe): the `String(err)`
// arm of the git-log catch is defensive and cannot be reached through the real
// subprocess boundary, because node's `execFileSync` only ever throws an Error.
// It mocks a FRESH module instance (`vi.resetModules()` + dynamic import), so
// every other test in this file still runs against real git.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	classifyRework,
	metricsReworkCommand,
	parseBlamePorcelainTimes,
	parseUnifiedZeroHunks,
} from "./metrics-rework.js";

const DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 111..222 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -3,2 +3,3 @@ function f() {",
	"-old line one",
	"-old line two",
	"+new one",
	"+new two",
	"+new three",
	"@@ -10,0 +12,4 @@",
	"+pure addition — no old side",
	"diff --git a/src/gone.ts b/src/gone.ts",
	"--- a/src/gone.ts",
	"+++ /dev/null",
	"@@ -1,5 +0,0 @@",
	"-deleted",
	"diff --git a/src/new.ts b/src/new.ts",
	"--- /dev/null",
	"+++ b/src/new.ts",
	"@@ -0,0 +1,7 @@",
	"+brand new file",
].join("\n");

describe("parseUnifiedZeroHunks", () => {
	// test-contract: invariant — extracts old-side ranges per OLD path, keyed for blame-at-parent
	it("extracts old-side ranges per OLD path, keyed for blame-at-parent", () => {
		const hunks = parseUnifiedZeroHunks(DIFF);
		const a = hunks.find((h) => h.file === "src/a.ts");
		expect(a?.ranges).toEqual([{ start: 3, lines: 2 }]);
	});

	// test-contract: invariant — skips pure additions (old-side length 0)
	it("skips pure additions (old-side length 0)", () => {
		const a = parseUnifiedZeroHunks(DIFF).find((h) => h.file === "src/a.ts");
		expect(a?.ranges).toHaveLength(1);
	});

	// test-contract: invariant — counts deletions against the old path even when the file is removed
	it("counts deletions against the old path even when the file is removed", () => {
		const gone = parseUnifiedZeroHunks(DIFF).find((h) => h.file === "src/gone.ts");
		expect(gone?.ranges).toEqual([{ start: 1, lines: 5 }]);
	});

	// test-contract: invariant — skips new files entirely (old side is /dev/null)
	it("skips new files entirely (old side is /dev/null)", () => {
		expect(parseUnifiedZeroHunks(DIFF).find((h) => h.file === "src/new.ts")).toBeUndefined();
	});

	// test-contract: invariant — defaults a bare @@ -N +M @@ header to 1 old line
	it("defaults a bare @@ -N +M @@ header to 1 old line", () => {
		const hunks = parseUnifiedZeroHunks(
			"--- a/x.ts\n+++ b/x.ts\n@@ -7 +7 @@\n-a\n+b\n",
		);
		expect(hunks[0]?.ranges).toEqual([{ start: 7, lines: 1 }]);
	});
});

describe("parseBlamePorcelainTimes", () => {
	// Two commits: full header on first occurrence, bare sha line after.
	const SHA_A = "a".repeat(40);
	const SHA_B = "b".repeat(40);
	const BLAME = [
		`${SHA_A} 3 3 2`,
		"author X",
		"committer-time 1000",
		"filename src/a.ts",
		"\tline three",
		`${SHA_A} 4 4`,
		"\tline four",
		`${SHA_B} 5 5 1`,
		"author Y",
		"committer-time 2000",
		"filename src/a.ts",
		"\tline five",
	].join("\n");

	// test-contract: invariant — emits one committer-time per content line, resolving repeated shas
	it("emits one committer-time per content line, resolving repeated shas", () => {
		expect(parseBlamePorcelainTimes(BLAME)).toEqual([1000, 1000, 2000]);
	});

	// test-contract: boundary — returns empty for empty input
	it("returns empty for empty input", () => {
		expect(parseBlamePorcelainTimes("")).toEqual([]);
	});

	// Truncated / interrupted porcelain output: a content line arrives before any
	// committer-time was recorded for its sha. The line must be DROPPED, not
	// emitted as NaN/0 — a 0 timestamp would read as "written in 1970" and quietly
	// deflate the rework share. This is the `t !== undefined` guard.
	// test-contract: invariant — drops content lines whose sha never carried a committer-time
	it("drops content lines whose sha never carried a committer-time", () => {
		const truncated = [
			`${SHA_A} 1 1 1`,
			"author X",
			"\tline one", // header cut off before committer-time
			`${SHA_B} 2 2 1`,
			"committer-time 4242",
			"\tline two",
		].join("\n");
		expect(parseBlamePorcelainTimes(truncated)).toEqual([4242]);
	});
});

describe("classifyRework", () => {
	const DAY = 86_400;
	// test-contract: invariant — counts lines younger than the window as rework
	it("counts lines younger than the window as rework", () => {
		const commitTs = 100 * DAY;
		const times = [commitTs - 1 * DAY, commitTs - 13 * DAY, commitTs - 15 * DAY];
		expect(classifyRework(commitTs, times, 14 * DAY)).toEqual({ rework: 2, total: 3 });
	});

	// test-contract: invariant — treats age exactly at the window as NOT rework (strict <)
	it("treats age exactly at the window as NOT rework (strict <)", () => {
		const commitTs = 100 * DAY;
		expect(classifyRework(commitTs, [commitTs - 14 * DAY], 14 * DAY)).toEqual({
			rework: 0,
			total: 1,
		});
	});

	// test-contract: invariant — clamps clock skew: a line 'from the future' is rework
	it("clamps clock skew: a line 'from the future' is rework", () => {
		const commitTs = 100 * DAY;
		expect(classifyRework(commitTs, [commitTs + DAY], 14 * DAY)).toEqual({
			rework: 1,
			total: 1,
		});
	});
});

// ===========================================
// Live command — real git repos in a tmpdir
// ===========================================

const DAY_MS = 86_400_000;
/**
 * Non-ASCII path: git emits it C-quoted in the diff header under the default
 * `core.quotePath=true`, and the command then blames the literal quoted string
 * and loses the file (unfixed defect — see the pin test).
 *
 * It lives in its OWN repo (`unicodeRepo`), never in the main fixture. If it
 * sat in the main fixture, the defect's arithmetic (`skipped_blame_files: 1`,
 * and the totals derived from it) would be baked into a dozen unrelated
 * assertions, so FIXING the defect would read as a wave of arithmetic
 * regressions instead of "the pin fired". Quarantined here, the correction
 * breaks exactly one named test.
 */
const CYRILLIC_FILE = "src/модуль.ts";

let repo = "";
let unicodeRepo = "";
let rootOnlyRepo = "";
let notARepo = "";
let gitConfigDir = "";
let quotePathOffConfig = "";

function git(cwd: string, args: string[], atMs?: number): void {
	const stamp = atMs === undefined ? undefined : new Date(atMs).toISOString();
	execFileSync("git", args, {
		cwd,
		stdio: "ignore",
		env: {
			...process.env,
			// Full isolation from the developer's global/system git config
			// (excludesFile, hooksPath, commit.gpgsign would all perturb the fixture).
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
			...(stamp ? { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } : {}),
		},
	});
}

function put(cwd: string, rel: string, contents: string): void {
	const abs = join(cwd, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, contents);
}

function commitAll(cwd: string, message: string, atMs: number): void {
	git(cwd, ["add", "-A"], atMs);
	git(cwd, ["commit", "-q", "-m", message], atMs);
}

/**
 * One real command run with both streams captured. stderr is intercepted (not
 * merely observed) because `execFileSync` relays a failing child's stderr to the
 * parent — the deliberate `git blame` failures below would otherwise spray
 * `fatal:` lines across the reporter.
 */
async function runRework(
	opts: Parameters<typeof metricsReworkCommand>[0],
	/** Overridden only by the freshly-imported instance in the mocked-throw test. */
	cmd: typeof metricsReworkCommand = metricsReworkCommand,
): Promise<{ out: string; err: string[] }> {
	const err: string[] = [];
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const errSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: string | Uint8Array) => {
			err.push(String(chunk));
			return true;
		});
	try {
		await cmd(opts);
		return { out: log.mock.calls.map((c) => String(c[0])).join("\n"), err };
	} finally {
		log.mockRestore();
		errSpy.mockRestore();
	}
}

async function runReworkJson(
	opts: Parameters<typeof metricsReworkCommand>[0],
): Promise<Record<string, unknown>> {
	const { out } = await runRework({ ...opts, json: true });
	return parseWire(JSON.parse(out), wireRecord(wireUnknown), "test JSON value");
}

/**
 * The SUT runs its OWN git (`log`, `diff -U0`, `blame --porcelain`) through
 * `execFileSync`, which inherits `process.env`. Isolating only the
 * FIXTURE-building git calls therefore leaves the code under test governed by
 * whatever `~/.gitconfig` the developer or CI runner happens to have.
 *
 * That is not theoretical: before this pin, `core.quotePath=false` on its own
 * turned 11 of the file's assertions red with no source change, because the
 * non-ASCII fixture stopped being C-quoted and stopped being dropped. A test
 * whose numbers depend on the host's git config is a CI landmine, not a test.
 *
 * So the SUT's git is pinned to a config-free environment for the whole file,
 * and the one test that NEEDS a non-default setting points GIT_CONFIG_GLOBAL at
 * a config file this suite wrote itself (`quotePathOffConfig`).
 */
const priorGitConfigEnv = {
	global: process.env.GIT_CONFIG_GLOBAL,
	system: process.env.GIT_CONFIG_SYSTEM,
};

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_SYSTEM = "/dev/null";
	const now = Date.now();
	repo = mkdtempSync(join(tmpdir(), "metrics-rework-"));
	git(repo, ["init", "-q"]);

	// C1 @ now-60d — outside the default 30d commit window, but the ANCESTOR of
	// everything below, so its committer-time is what later blames resolve to.
	put(repo, "src/a.ts", "l1\nl2\nl3\nl4\nl5\nl6\n");
	put(repo, "src/b.ts", "b1\nb2\nb3\nb4\n");
	put(repo, "docs/generated/api.md", "gen1\ngen2\n");
	commitAll(repo, "c1 seed", now - 60 * DAY_MS);

	// C2 @ now-5d — rewrites lines last touched 55d ago: NOT rework at window 14d.
	put(repo, "src/a.ts", "l1\nl2-v2\nl3\nl4\nl5\nl6\n");
	put(repo, "src/b.ts", "b1\nb2-v2\nb3\nb4\n");
	commitAll(repo, "c2 two files", now - 5 * DAY_MS);

	// C3 @ now-3d — one line last touched by C2 (2d old → REWORK) and one last
	// touched by C1 (57d old → not rework), in the same file.
	put(repo, "src/a.ts", "l1\nl2-v3\nl3\nl4-v2\nl5\nl6\n");
	commitAll(repo, "c3 mixed ages", now - 3 * DAY_MS);

	// C4 @ now-2d — a brand-new file (no old side) plus an excluded path.
	put(repo, "src/fresh.ts", "brand new\nnothing to blame\n");
	put(repo, "docs/generated/api.md", "gen1-v2\ngen2\n");
	commitAll(repo, "c4 greenfield + generated", now - 2 * DAY_MS);

	// C5 @ now-12h — rewrites a line last touched by C2 (~4.5d old → REWORK).
	put(repo, "src/b.ts", "b1\nb2-v3\nb3\nb4\n");
	commitAll(repo, "c5 recent rework", now - DAY_MS / 2);

	// Separate repo for the non-ASCII defect pin — see CYRILLIC_FILE. Two
	// commits; the second touches an ASCII control file and the non-ASCII file
	// in the SAME commit, so a run that drops one but keeps the other proves the
	// path quoting is the cause and not a broken fixture.
	unicodeRepo = mkdtempSync(join(tmpdir(), "metrics-rework-unicode-"));
	git(unicodeRepo, ["init", "-q"]);
	put(unicodeRepo, "src/ascii.ts", "a1\na2\n");
	put(unicodeRepo, CYRILLIC_FILE, "u1\nu2\n");
	commitAll(unicodeRepo, "u1 seed", now - 10 * DAY_MS);
	put(unicodeRepo, "src/ascii.ts", "a1-v2\na2\n");
	put(unicodeRepo, CYRILLIC_FILE, "u1-v2\nu2\n");
	commitAll(unicodeRepo, "u2 touch both", now - DAY_MS);

	// Our OWN git config file (never the developer's) for the one test that
	// needs `core.quotePath=false` to isolate the defect's mechanism.
	gitConfigDir = mkdtempSync(join(tmpdir(), "metrics-rework-gitcfg-"));
	quotePathOffConfig = join(gitConfigDir, "quotepath-off.gitconfig");
	writeFileSync(quotePathOffConfig, "[core]\n\tquotePath = false\n");

	// A repo whose only commit is the root: `git diff sha^ sha` cannot resolve a
	// parent, so every commit is skipped and the denominator stays 0.
	rootOnlyRepo = mkdtempSync(join(tmpdir(), "metrics-rework-root-"));
	git(rootOnlyRepo, ["init", "-q"]);
	put(rootOnlyRepo, "src/only.ts", "x\ny\n");
	commitAll(rootOnlyRepo, "root", now - DAY_MS);

	// realpath: on macOS tmpdir() sits under the /var → /private/var symlink, and
	// GIT_CEILING_DIRECTORIES (set by the failure tests) only matches resolved paths.
	notARepo = realpathSync(mkdtempSync(join(tmpdir(), "metrics-rework-bare-")));
});

afterAll(() => {
	for (const dir of [repo, unicodeRepo, gitConfigDir, rootOnlyRepo, notARepo]) {
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
	// Restore rather than delete: an undefined prior value must stay undefined,
	// and other suites in this worker share the process.
	if (priorGitConfigEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = priorGitConfigEnv.global;
	if (priorGitConfigEnv.system === undefined) delete process.env.GIT_CONFIG_SYSTEM;
	else process.env.GIT_CONFIG_SYSTEM = priorGitConfigEnv.system;
});

describe("metricsReworkCommand — measured against a real repo", () => {
	// Ground truth for the default window (days 30, window 14) over the fixture.
	// Every number below is a property of the fixture alone — no skipped/dropped
	// file contributes to it, so no known defect is baked into the arithmetic:
	//   C5  src/b.ts L2 (4.5d → rework)                    → 1 rework / 1 line
	//   C4  new file + docs/generated/ only                → nothing
	//   C3  src/a.ts L2 (2d → rework) + L4 (57d)           → 1 rework / 2 lines
	//   C2  src/a.ts L2 (55d old) + src/b.ts L2 (55d old)  → 0 rework / 2 lines
	// ⇒ 2 rework of 5 old-side lines = 40.0%; per file a.ts 1/3, b.ts 1/2.
	// Commits are walked NEWEST FIRST, so src/b.ts (first seen in C5) is the
	// first key in the per-file map and wins the rework=1 tie under the stable sort.

	// test-contract: public-api — reports the rework share and per-file breakdown as JSON
	it("reports the rework share and per-file breakdown as JSON", async () => {
		const res = await runReworkJson({ cwd: repo });
		expect(res).toMatchObject({
			days: 30,
			window_days: 14,
			commits_scanned: 4,
			skipped_bulk_commits: 0,
			skipped_blame_files: 0,
			overall: { rework: 2, total: 5, pct: 40 },
		});
		expect(res.top_files).toEqual([
			{ file: "src/b.ts", rework: 1, total: 2 },
			{ file: "src/a.ts", rework: 1, total: 3 },
		]);
	});

	// test-contract: public-api — renders the human report with counts, skips and right-aligned rows
	it("renders the human report with counts, skips and right-aligned rows", async () => {
		const { out } = await runRework({ cwd: repo });
		expect(out).toContain("Rework — 40.0% of 5 changed old-side lines were <14d old");
		expect(out).toContain("(4 commits over 30d; 0 bulk commits + 0 unblameable files skipped)");
		// Per-file percentage is that file's own rework/total, not a share of the whole.
		// (The `c.total === 0` guard on that line is genuinely dead: `top` filters
		// `rework > 0`, and per-file `total` is a sum of `lineTimes.length` values
		// each ≥ its own rework contribution, so rework > 0 ⇒ total > 0. No test
		// can reach the 0 arm; it is unreachable, not merely untested.)
		expect(out).toContain("      1 rework lines ( 50%)  src/b.ts");
		expect(out).toContain("      1 rework lines ( 33%)  src/a.ts");
	});

	// test-contract: public-api — renders a one-line summary in --short mode
	it("renders a one-line summary in --short mode", async () => {
		const { out } = await runRework({ cwd: repo, short: true });
		expect(out).toBe("rework 40.0% of 5 changed lines (30d, window 14d)");
	});

	// test-contract: invariant — excludes generated paths and greenfield files from the denominator
	it("excludes generated paths and greenfield files from the denominator", async () => {
		const res = await runReworkJson({ cwd: repo });
		const files = (parseWire(res.top_files, wireArray(wireObject({ "file": wireString })), "test JSON value")).map((f) => f.file);
		expect(files).not.toContain("docs/generated/api.md");
		expect(files).not.toContain("src/fresh.ts");
		// 5 = the four blameable old-side lines above; a greenfield file adds none.
		expect(res).toHaveProperty(["overall","total"], 5);
	});

	// test-contract: invariant — widening --window reclassifies older ancestors as rework
	it("widening --window reclassifies older ancestors as rework", async () => {
		// window 60d pulls the 55d/57d ancestors in; days 90 also admits the root
		// commit, whose parentless `git diff` is skipped rather than throwing.
		const res = await runReworkJson({ cwd: repo, days: "90", window: "60" });
		expect(res).toMatchObject({
			days: 90,
			window_days: 60,
			commits_scanned: 5,
			overall: { rework: 5, total: 5, pct: 100 },
		});
		expect(res.top_files).toEqual([
			{ file: "src/a.ts", rework: 3, total: 3 },
			{ file: "src/b.ts", rework: 2, total: 2 },
		]);
	});

	// test-contract: invariant — caps the scan at --max-commits, newest first
	it("caps the scan at --max-commits, newest first", async () => {
		const res = await runReworkJson({ cwd: repo, maxCommits: "1" });
		expect(res).toMatchObject({
			commits_scanned: 1,
			overall: { rework: 1, total: 1, pct: 100 },
		});
		expect(res.top_files).toEqual([{ file: "src/b.ts", rework: 1, total: 1 }]);
	});

	// test-contract: invariant — skips commits touching more than --max-commit-files entirely
	it("skips commits touching more than --max-commit-files entirely", async () => {
		const res = await runReworkJson({ cwd: repo, maxCommitFiles: "1" });
		// Only C2 spans two eligible files, so exactly one commit is dropped and
		// its two lines leave the denominator.
		expect(res).toMatchObject({
			commits_scanned: 4,
			skipped_bulk_commits: 1,
			skipped_blame_files: 0,
			overall: { rework: 2, total: 3, pct: 66.7 },
		});
	});

	const optionDefaults: Array<[string, Record<string, string>]> = [
		["absent", {}],
		["empty string", { days: "", window: "", maxCommits: "", maxCommitFiles: "" }],
		["non-numeric", { days: "lots", window: "wide", maxCommits: "all", maxCommitFiles: "any" }],
		// `Number("0") || 30` — a deliberate zero falls back to the default rather
		// than scanning nothing. Pinned so the fallback operator is not "fixed"
		// into `??` without a decision.
		["zero", { days: "0", window: "0", maxCommits: "0", maxCommitFiles: "0" }],
	];

	// test-contract: boundary — falls back to the day/window defaults for every non-positive-number option shape
	it.each(optionDefaults)(
		"falls back to days=30/window=14 when options are %s",
		async (_label, opts) => {
			const res = await runReworkJson({ cwd: repo, ...opts });
			expect(res).toMatchObject({
				days: 30,
				window_days: 14,
				commits_scanned: 4,
				skipped_bulk_commits: 0,
				overall: { rework: 2, total: 5, pct: 40 },
			});
		},
	);
});

// ===========================================
// Non-ASCII paths — quarantined fixture, one defect pin
// ===========================================
// `unicodeRepo` has exactly two commits; U2 rewrites line 1 of BOTH
// `src/ascii.ts` and `src/модуль.ts`, each last written by U1 nine days
// earlier. A correct implementation reports 2 rework of 2 old-side lines.
describe("metricsReworkCommand — non-ASCII paths", () => {
	// Real defect pin — see the test name. Reported, not fixed. This is the ONLY
	// test in the file whose expectations encode the broken behaviour, so fixing
	// the defect turns exactly this one red.
	// test-contract: invariant — silently drops non-ASCII paths because git C-quotes the diff header
	it("silently drops non-ASCII paths because git C-quotes the diff header", async () => {
		const res = await runReworkJson({ cwd: unicodeRepo });
		// The ASCII control changed in the SAME commit is counted, so the run
		// worked and the fixture is sound …
		expect(res).toMatchObject({
			commits_scanned: 2,
			skipped_bulk_commits: 0,
			overall: { rework: 1, total: 1, pct: 100 },
		});
		expect(res.top_files).toEqual([{ file: "src/ascii.ts", rework: 1, total: 1 }]);
		// … and the sole casualty is the non-ASCII path: `git blame` is handed the
		// literal `"src/\320\274\320\276\320\264\321\203\320\273\321\214.ts"` and
		// answers `fatal: no such path`, which blameTimesFor swallows as a skip.
		expect(res.skipped_blame_files).toBe(1);
		const files = (parseWire(res.top_files, wireArray(wireObject({ "file": wireString })), "test JSON value")).map((f) => f.file);
		expect(files).not.toContain(CYRILLIC_FILE);
		expect(files.some((f) => f.startsWith('"'))).toBe(false);
	});

	// Mechanism proof, not a workaround. The ONLY difference from the pin above
	// is git's path quoting, which attributes the drop to the C-quoted header and
	// nothing else (a broken blame invocation or an unreadable fixture would fail
	// here too). It also states the target behaviour: this test already expects
	// what a fixed implementation must produce under the default config, so it
	// keeps passing through the fix.
	// test-contract: invariant — counts the same non-ASCII path when core.quotePath=false leaves it unquoted
	it("counts the same non-ASCII path when core.quotePath=false leaves it unquoted", async () => {
		const prior = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = quotePathOffConfig;
		try {
			const res = await runReworkJson({ cwd: unicodeRepo });
			expect(res.skipped_blame_files).toBe(0);
			expect(res.top_files).toEqual([
				{ file: "src/ascii.ts", rework: 1, total: 1 },
				{ file: CYRILLIC_FILE, rework: 1, total: 1 },
			]);
			expect(res.overall).toMatchObject({ rework: 2, total: 2, pct: 100 });
		} finally {
			if (prior === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = prior;
		}
	});
});

describe("metricsReworkCommand — degenerate repositories", () => {
	// test-contract: public-api — reports 0% with no rows when every commit is parentless
	it("reports 0% with no rows when every commit is parentless", async () => {
		const res = await runReworkJson({ cwd: rootOnlyRepo });
		expect(res).toMatchObject({
			commits_scanned: 1,
			skipped_bulk_commits: 0,
			skipped_blame_files: 0,
			overall: { rework: 0, total: 0, pct: 0 },
		});
		expect(res.top_files).toEqual([]);
	});

	// test-contract: public-api — renders the zero-denominator report without a per-file section
	it("renders the zero-denominator report without a per-file section", async () => {
		const { out } = await runRework({ cwd: rootOnlyRepo });
		expect(out).toContain("Rework — 0.0% of 0 changed old-side lines were <14d old");
		expect(out).toContain("(1 commits over 30d; 0 bulk commits + 0 unblameable files skipped)");
		expect(out).not.toMatch(/rework lines/);
	});
});

describe("metricsReworkCommand — git failure", () => {
	const priorExitCode = process.exitCode;
	const priorCeiling = process.env.GIT_CEILING_DIRECTORIES;

	beforeEach(() => {
		// Stop git's repo discovery from walking ABOVE the throwaway dir, so the
		// "not a git repository" failure holds even if the temp root ever sits
		// inside someone's checkout. The command inherits process.env.
		process.env.GIT_CEILING_DIRECTORIES = dirname(notARepo);
	});

	afterEach(() => {
		process.exitCode = priorExitCode;
		if (priorCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
		else process.env.GIT_CEILING_DIRECTORIES = priorCeiling;
	});

	// test-contract: boundary — writes a single-line git error to stderr and exits 1
	it("writes a single-line git error to stderr and exits 1", async () => {
		const { err } = await runRework({ cwd: notARepo });
		expect(process.exitCode).toBe(1);
		// The command emits exactly one chunk of its own, condensing execFileSync's
		// multi-line "Command failed: …" message to its first line.
		const own = err.filter((e) => e.startsWith("git log failed:"));
		expect(own).toHaveLength(1);
		expect(own[0]).toMatch(/^git log failed: Command failed: git log .+\n$/);
	});

	// test-contract: boundary — prints nothing on stdout when git log fails
	it("prints nothing on stdout when git log fails", async () => {
		const { out } = await runRework({ cwd: notARepo });
		expect(out).toBe("");
	});
});

/**
 * The `String(err)` arm of the git-log catch is DEFENSIVE, not dead: node's
 * `execFileSync` always throws an Error, so the arm is unreachable through the
 * real subprocess boundary and reachable only by replacing that boundary.
 * Saying "unreachable" full stop would have been an overclaim, so here is the
 * test that reaches it — scoped to a fresh module instance so every other test
 * above keeps exercising real git.
 *
 * Together with "writes a single-line git error to stderr and exits 1" (which
 * pins `Command failed: …` UNPREFIXED, i.e. `err.message`, not `String(err)`
 * = `Error: Command failed: …`), both arms of the ternary are pinned: collapse
 * it either way and one of the two tests goes red.
 */
describe("metricsReworkCommand — git throws a non-Error", () => {
	const priorExitCode = process.exitCode;

	afterEach(() => {
		vi.doUnmock("node:child_process");
		vi.resetModules();
		process.exitCode = priorExitCode;
	});

	// test-contract: boundary — stringifies the thrown value instead of reading .message off it
	it("stringifies the thrown value instead of reading .message off it", async () => {
		vi.resetModules();
		vi.doMock("node:child_process", () => ({
			execFileSync: () => {
				// Not an Error instance — `err.message` would be undefined, so the
				// `.split("\n")` on the Error arm would throw inside the catch.
				throw { toString: () => "spawn EAGAIN (thrown non-Error)" };
			},
		}));
		const mod = await import("./metrics-rework.js");
		const { out, err } = await runRework({ cwd: repo }, mod.metricsReworkCommand);
		expect(process.exitCode).toBe(1);
		expect(err).toEqual(["git log failed: spawn EAGAIN (thrown non-Error)\n"]);
		expect(out).toBe("");
	});
});

// ===========================================
// Mutation-kill wave — survivor-targeted cases (pass1_w30)
// ===========================================
// Pure-function boundary cases below need no repo; the synthetic-git block at
// the end fully replaces `node:child_process` so the observable state (which
// mutants alter) is under direct control without a real repository.

describe("parseUnifiedZeroHunks — header parsing boundary", () => {
	// test-contract: mutation-kill — MethodExpression `.trim()` drop leaves a
	// trailing space baked into the parsed old-side path.
	it("trims trailing whitespace off the old-side header path", () => {
		const hunks = parseUnifiedZeroHunks(
			"--- a/x.ts \n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old1\n-old2\n",
		);
		expect(hunks[0]?.file).toBe("x.ts");
	});

	// test-contract: mutation-kill — ConditionalExpression `=== "/dev/null"` -> `false`
	// would keep a hunk whose old side is the /dev/null sentinel.
	it("drops a hunk whose old side is /dev/null even when it carries old-side lines", () => {
		const hunks = parseUnifiedZeroHunks("--- /dev/null\n+++ b/y.ts\n@@ -1,3 +0,0 @@\n-a\n-b\n-c\n");
		expect(hunks).toEqual([]);
	});

	// test-contract: mutation-kill — StringLiteral `"/dev/null"` -> `""` changes
	// which literal old-side value is treated as "no old side".
	it("treats a genuinely empty old-side path as a real (if odd) file, not the /dev/null sentinel", () => {
		const hunks = parseUnifiedZeroHunks("--- \n+++ b/z.ts\n@@ -1,2 +1,2 @@\n-a\n-b\n");
		expect(hunks).toEqual([{ file: "", ranges: [{ start: 1, lines: 2 }] }]);
	});

	// test-contract: mutation-kill — Regex `/^a\//` -> `/a\//` (anchor dropped)
	// would strip an embedded "a/" instead of only a leading one.
	it("strips only a LEADING 'a/' prefix, never an embedded occurrence", () => {
		const hunks = parseUnifiedZeroHunks(
			"--- xa/deep/file.ts\n+++ b/xa/deep/file.ts\n@@ -1,2 +1,2 @@\n-old1\n-old2\n",
		);
		expect(hunks[0]?.file).toBe("xa/deep/file.ts");
	});

	// test-contract: mutation-kill — ConditionalExpression `!cur` -> `false`
	// removes the guard against a hunk line arriving with no active file
	// context; the mutant then dereferences a null `cur` and throws.
	it("ignores a hunk line encountered before any --- header (no crash, no entry)", () => {
		const hunks = parseUnifiedZeroHunks("@@ -1,2 +1,2 @@\n-a\n-b\n");
		expect(hunks).toEqual([]);
	});

	// test-contract: mutation-kill — three mutants collapse to the same
	// observable: MethodExpression drops `.filter(...)`, ConditionalExpression
	// `f.ranges.length > 0` -> `true`, EqualityOperator `> 0` -> `>= 0`. A file
	// header with a pure-addition hunk (old-side count 0) leaves `ranges: []`,
	// which the correct filter must drop from the result entirely.
	it("drops a file whose only hunk has zero old-side lines", () => {
		const hunks = parseUnifiedZeroHunks(
			"--- a/pure-add.ts\n+++ b/pure-add.ts\n@@ -5,0 +6,2 @@\n+new1\n+new2\n",
		);
		expect(hunks).toEqual([]);
	});
});

describe("parseUnifiedZeroHunks — HUNK_RE regex boundary", () => {
	// test-contract: mutation-kill — Regex `/^@@ .../` -> `@@ .../` (anchor
	// dropped) would recognize a hunk header that does not start the line.
	it("requires the hunk marker to START the line, not merely appear in it", () => {
		const hunks = parseUnifiedZeroHunks(
			"--- a/n.ts\n+++ b/n.ts\nnoise@@ -5,2 +5,2 @@\n-a\n-b\n",
		);
		expect(hunks).toEqual([]);
	});

	// test-contract: mutation-kill — four Regex mutants each restrict one of
	// the header's four numeric fields to a single digit (`(\d+)` -> `(\d)`),
	// which breaks the WHOLE anchored match once that field is 2+ digits. One
	// header with every field multi-digit exercises all four simultaneously.
	it("parses a hunk header whose every numeric field is multi-digit", () => {
		const hunks = parseUnifiedZeroHunks("--- a/big.ts\n+++ b/big.ts\n@@ -123,45 +67,89 @@\n");
		expect(hunks).toEqual([{ file: "big.ts", ranges: [{ start: 123, lines: 45 }] }]);
	});
});

describe("parseBlamePorcelainTimes — sha/committer-time regex boundary", () => {
	const SHA_X = "a".repeat(40);
	const SHA_Y = "b".repeat(40);

	// test-contract: mutation-kill — four mutants collapse to the same
	// observable: `sha?.[1]` -> `false`, the sha-match BlockStatement -> `{}`,
	// BLAME_SHA_RE's `{40}` dropped, and BLAME_SHA_RE's char class negated.
	// Each stops the parser from ever binding `curSha` to a real value, so
	// every committer-time collapses onto one shared "" key instead of being
	// kept separate per sha. A bare-repeat of an EARLIER sha (whose
	// committer-time was NOT just re-declared) exposes the collapse: the
	// correct parser resolves it back to that sha's own stored time, while the
	// collapsed parser resolves it to whichever time was stored LAST.
	it("keeps a bare-repeated sha's committer-time bound to its own identity, not the most recent write", () => {
		const blame = [
			`${SHA_X} 3 3 2`,
			"committer-time 1111",
			"\tline one",
			`${SHA_Y} 2 2`,
			"committer-time 2222",
			"\tline two",
			`${SHA_X} 3 3`, // bare repeat — no committer-time re-declared
			"\tline three",
		].join("\n");
		expect(parseBlamePorcelainTimes(blame)).toEqual([1111, 2222, 1111]);
	});

	// test-contract: mutation-kill — BLAME_SHA_RE's two trailing `\d+` fields
	// (`(\d) `) restricted to a single digit only misbehave once the actual
	// value is 2+ digits; single-digit fixtures elsewhere in this file cannot
	// distinguish them.
	it("matches a blame header whose trailing line numbers are multi-digit", () => {
		const blame = [
			`${SHA_X} 15 25`,
			"committer-time 1111",
			"\tline one",
			`${SHA_Y} 2 2`,
			"committer-time 2222",
			"\tline two",
			`${SHA_X} 30 40`, // bare repeat, still multi-digit
			"\tline three",
		].join("\n");
		expect(parseBlamePorcelainTimes(blame)).toEqual([1111, 2222, 1111]);
	});

	// test-contract: mutation-kill — Regex `/^([0-9a-f]{40}) .../` -> unanchored
	// would recognize a sha embedded mid-line, not only one that starts it.
	it("requires the 40-hex sha to START the line, not merely appear in it", () => {
		const blame = [
			`X${SHA_X} 1 1`, // prefixed — must NOT be recognized as a sha line
			"committer-time 1111",
			"\tline one",
			`${SHA_Y} 2 2`,
			"committer-time 2222",
			"\tline two",
			`X${SHA_X} 3 3`, // prefixed bare repeat — still must not match
			"\tline three",
		].join("\n");
		expect(parseBlamePorcelainTimes(blame)).toEqual([1111, 2222, 2222]);
	});

	// test-contract: mutation-kill — Regex `/^committer-time (\d+)$/` -> drops
	// the leading `^` anchor, which would recognize the token mid-line.
	it("requires 'committer-time' to START the line", () => {
		const blame = [`${SHA_X} 1 1`, "Xcommitter-time 500", "\tline a"].join("\n");
		expect(parseBlamePorcelainTimes(blame)).toEqual([]);
	});

	// test-contract: mutation-kill — Regex `/^committer-time (\d+)$/` -> drops
	// the trailing `$` anchor, which would accept trailing garbage after the
	// digits.
	it("requires the committer-time digits to reach END of line", () => {
		const blame = [`${SHA_X} 1 1`, "committer-time 500 author-tz +0000", "\tline a"].join("\n");
		expect(parseBlamePorcelainTimes(blame)).toEqual([]);
	});
});

// ===========================================
// Synthetic git — fully mocked `node:child_process`, no real repository
// ===========================================
// These target mutants in the unexported `listCommits` helper and in
// `metricsReworkCommand`'s file-ranking logic, none of which are reachable
// through `parseUnifiedZeroHunks`/`parseBlamePorcelainTimes` directly. A real
// repo can't easily produce a malformed `git log` line or 11+ distinct
// touched files without heavy fixture cost, so git itself is replaced.
describe("metricsReworkCommand — synthetic git, full mock", () => {
	const priorExitCode = process.exitCode;

	afterEach(() => {
		vi.doUnmock("node:child_process");
		vi.resetModules();
		process.exitCode = priorExitCode;
	});

	function makeDiff(file: string): string {
		return [
			`diff --git a/${file} b/${file}`,
			`--- a/${file}`,
			`+++ b/${file}`,
			"@@ -1,1 +1,1 @@",
			"-old",
			"+new",
		].join("\n");
	}

	function makeBlame(committerTime: number): string {
		return [`${"a".repeat(40)} 1 1 1`, "author X", `committer-time ${committerTime}`, "filename x", "\told"].join(
			"\n",
		);
	}

	/** Installs a mocked `node:child_process` and returns the freshly-imported command. */
	async function importMockedCommand(
		logText: string,
		diffBySha: Record<string, string>,
		blameHandler: (sha: string, file: string) => string,
	) {
		vi.resetModules();
		vi.doMock("node:child_process", () => ({
			execFileSync: (_cmd: string, args: string[]) => {
				if (args[0] === "log") return logText;
				if (args[0] === "diff") {
					const shaCaret = args[3] ?? "";
					const sha = shaCaret.endsWith("^") ? shaCaret.slice(0, -1) : shaCaret;
					const diff = diffBySha[sha];
					if (diff === undefined) throw new Error(`fatal: bad revision '${sha}'`);
					return diff;
				}
				if (args[0] === "blame") {
					const dashIdx = args.indexOf("--");
					const file = args[dashIdx + 1] ?? "";
					const shaCaret = args[dashIdx - 1] ?? "";
					const sha = shaCaret.endsWith("^") ? shaCaret.slice(0, -1) : shaCaret;
					return blameHandler(sha, file);
				}
				throw new Error(`unexpected git subcommand: ${args[0]}`);
			},
		}));
		const mod = await import("./metrics-rework.js");
		return mod.metricsReworkCommand;
	}

	const nowSec = Math.floor(Date.now() / 1000);
	const recentTime = nowSec - 86_400; // 1 day old — rework at the default 14d window
	const oldTime = nowSec - 86_400 * 100; // 100 days old — NOT rework

	// test-contract: mutation-kill — three mutants collapse to the same
	// observable: MethodExpression drops `.filter((c) => c.rework > 0)`,
	// ConditionalExpression `c.rework > 0` -> `true`, EqualityOperator `> 0`
	// -> `>= 0`. A zero-rework file must be excluded from `top_files`; with any
	// of the three mutants applied it leaks through instead.
	it("excludes a zero-rework file from top_files (filter, not just sort)", async () => {
		const cmd = await importMockedCommand(
			`sha0\t${nowSec}\nsha1\t${nowSec}\nsha2\t${nowSec}\n`,
			{ sha0: makeDiff("file0.ts"), sha1: makeDiff("file1.ts"), sha2: makeDiff("file2.ts") },
			(_sha, file) => makeBlame(file === "file2.ts" ? oldTime : recentTime),
		);
		const { out } = await runRework({ cwd: "/fake", json: true }, cmd);
		const res = parseWire(JSON.parse(out), wireObject({ "top_files": wireArray(wireObject({ "file": wireString })), "overall": wireObject({ "total": wireNumber }) }), "test JSON value");
		expect(res.top_files.map((f) => f.file)).toEqual(["file0.ts", "file1.ts"]);
		expect(res.overall.total).toBe(3);
	});

	// test-contract: mutation-kill — MethodExpression drops the trailing
	// `.slice(0, 10)` from the top_files chain, which would report all
	// rework-carrying files instead of the top 10.
	it("caps top_files at 10 even when more files carry rework", async () => {
		const shas = Array.from({ length: 11 }, (_, i) => `sha${i}`);
		const logText = shas.map((s) => `${s}\t${nowSec}`).join("\n");
		const diffBySha = Object.fromEntries(shas.map((s, i) => [s, makeDiff(`file${i}.ts`)]));
		const cmd = await importMockedCommand(logText, diffBySha, () => makeBlame(recentTime));
		const { out } = await runRework({ cwd: "/fake", json: true }, cmd);
		const res = parseWire(JSON.parse(out), wireObject({ "top_files": wireArray(wireUnknown), "overall": wireObject({ "total": wireNumber }) }), "test JSON value");
		expect(res.top_files).toHaveLength(10);
		expect(res.overall.total).toBe(11);
	});

	// test-contract: mutation-kill — Regex `EXCLUDE_RE` drops its `^` anchor,
	// which would exclude any path with "dist/" (etc.) ANYWHERE in it instead
	// of only at the start.
	it("does not exclude a path that merely CONTAINS an excluded segment name", async () => {
		const cmd = await importMockedCommand(
			`sha0\t${nowSec}\n`,
			{ sha0: makeDiff("srcdist/decoy.ts") },
			() => makeBlame(recentTime),
		);
		const { out } = await runRework({ cwd: "/fake", json: true }, cmd);
		const res = parseWire(JSON.parse(out), wireObject({ "top_files": wireArray(wireObject({ "file": wireString })), "overall": wireObject({ "total": wireNumber }) }), "test JSON value");
		expect(res.top_files).toEqual([{ file: "srcdist/decoy.ts", rework: 1, total: 1 }]);
		expect(res.overall.total).toBe(1);
	});

	// test-contract: mutation-kill — MethodExpression drops `.trim()` in
	// `listCommits`, leaving stray whitespace baked into the parsed sha, which
	// then fails to resolve as a git ref for the subsequent diff.
	it("trims whitespace around a git-log line before splitting sha/timestamp", async () => {
		const cmd = await importMockedCommand(
			`  sha0\t${nowSec}  \n`,
			{ sha0: makeDiff("file0.ts") },
			() => makeBlame(recentTime),
		);
		const { out } = await runRework({ cwd: "/fake", json: true }, cmd);
		const res = parseWire(JSON.parse(out), wireObject({ "overall": wireObject({ "total": wireNumber }) }), "test JSON value");
		expect(res.overall.total).toBe(1);
	});

	// test-contract: mutation-kill — LogicalOperator `sha && ts` -> `sha || ts`
	// in `listCommits` would admit a log line with a sha but no parseable
	// timestamp instead of requiring BOTH fields.
	it("drops a git-log line that has a sha but no parseable timestamp", async () => {
		const cmd = await importMockedCommand("onlysha\n", {}, () => makeBlame(recentTime));
		const { out } = await runRework({ cwd: "/fake", json: true }, cmd);
		const res = parseWire(JSON.parse(out), wireObject({ "commits_scanned": wireNumber }), "test JSON value");
		expect(res.commits_scanned).toBe(0);
	});
});
