import { parseWire, wireArray, wireNumber, wireObject, wireString, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// metrics-coupling unit tests — pure core (parse → pairs → annotate)
// ===========================================
// The pure layer (parse → pairs → annotate) is unit-tested against hand-computed
// oracles. The command entry point is exercised end-to-end against a real
// throwaway git repo built in a tmpdir: real `git log`, real ProjectGraph import
// resolution, real rendered output. Nothing below is mocked except `console.log`
// (to capture what the user would see) and `process.cwd` (to prove the default).
//
// Ambient git state is the one machine dependency that could reach in, so the
// whole `GIT_*` set is stripped from both the fixture's env and `process.env`
// (which the command's own `git log` inherits) and restored after each test —
// see `fixtureGitEnv` / `scrubAmbientGitEnv` and their two tests at the bottom.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProjectGraph } from "../harness/project-graph.js";
import {
	annotateRelations,
	computeCoupling,
	isCompanionPair,
	metricsCouplingCommand,
	parseNameOnlyLog,
} from "./metrics-coupling.js";

const LOG = [
	"aaa\t1700000000",
	"src/a.ts",
	"src/b.ts",
	"",
	"bbb\t1700000100",
	"src/a.ts",
	"src/b.ts",
	"src/c.ts",
	"",
	"ccc\t1700000200",
	"src/a.ts",
	"src/b.ts",
	"",
	"ddd\t1700000300",
	"src/c.ts",
	"",
].join("\n");

describe("parseNameOnlyLog", () => {
	it("parses sha, timestamp, and file list per commit", () => {
		const commits = parseNameOnlyLog(LOG);
		expect(commits).toHaveLength(4);
		expect(commits[0]).toEqual({ sha: "aaa", timestamp: 1700000000, files: ["src/a.ts", "src/b.ts"] });
		expect(commits[3]?.files).toEqual(["src/c.ts"]);
	});

	it("tolerates CRLF and trailing blank lines", () => {
		const commits = parseNameOnlyLog("eee\t1700000400\r\nsrc/x.ts\r\n\r\n\r\n");
		expect(commits).toEqual([{ sha: "eee", timestamp: 1700000400, files: ["src/x.ts"] }]);
	});

	it("returns empty for empty input", () => {
		expect(parseNameOnlyLog("")).toEqual([]);
		expect(parseNameOnlyLog("\n\n")).toEqual([]);
	});

	it("skips malformed header lines rather than throwing", () => {
		const commits = parseNameOnlyLog("not-a-header\nsrc/a.ts\n\nfff\t1700000500\nsrc/b.ts\n");
		expect(commits).toHaveLength(1);
		expect(commits[0]?.sha).toBe("fff");
	});

	// `git log --pretty=format:` emits no trailing newline, so the last commit is
	// only ever flushed by the end-of-input path.
	it("flushes the final commit when the input has no trailing newline", () => {
		expect(parseNameOnlyLog("ggg\t1700000600\nsrc/a.ts")).toEqual([
			{ sha: "ggg", timestamp: 1700000600, files: ["src/a.ts"] },
		]);
	});

	// Real shape for `--allow-empty` commits: git emits header lines back to back
	// with no blank separator, so the header branch must flush the pending commit.
	it("flushes on a back-to-back header (file-less commits) instead of merging them", () => {
		const commits = parseNameOnlyLog(
			["hhh\t1700000700", "iii\t1700000800", "jjj\t1700000900", "src/a.ts"].join("\n"),
		);
		expect(commits).toEqual([
			{ sha: "hhh", timestamp: 1700000700, files: [] },
			{ sha: "iii", timestamp: 1700000800, files: [] },
			{ sha: "jjj", timestamp: 1700000900, files: ["src/a.ts"] },
		]);
	});
});

describe("computeCoupling", () => {
	it("counts pair support and per-file revisions, computing Tornhill strength", () => {
		const pairs = computeCoupling(parseNameOnlyLog(LOG), {
			minSupport: 1,
			maxCommitFiles: 30,
			minStrength: 0,
		});
		const ab = pairs.find((p) => p.a === "src/a.ts" && p.b === "src/b.ts");
		// a: 3 revs, b: 3 revs, together 3 → 3 / ((3+3)/2) = 100%
		expect(ab).toMatchObject({ support: 3, revA: 3, revB: 3, strength: 100 });
		const ac = pairs.find((p) => p.a === "src/a.ts" && p.b === "src/c.ts");
		// a: 3, c: 2, together 1 → 1 / 2.5 = 40%
		expect(ac).toMatchObject({ support: 1, strength: 40 });
	});

	it("applies minSupport and minStrength filters", () => {
		const commits = parseNameOnlyLog(LOG);
		expect(
			computeCoupling(commits, { minSupport: 2, maxCommitFiles: 30, minStrength: 0 }).map(
				(p) => `${p.a}+${p.b}`,
			),
		).toEqual(["src/a.ts+src/b.ts"]);
		expect(
			computeCoupling(commits, { minSupport: 1, maxCommitFiles: 30, minStrength: 50 }).map(
				(p) => `${p.a}+${p.b}`,
			),
		).toEqual(["src/a.ts+src/b.ts"]);
	});

	it("ignores bulk commits over maxCommitFiles entirely", () => {
		const bulk = `big\t1700000600\n${Array.from({ length: 31 }, (_, i) => `src/f${i}.ts`).join("\n")}\n`;
		const pairs = computeCoupling(parseNameOnlyLog(bulk), {
			minSupport: 1,
			maxCommitFiles: 30,
			minStrength: 0,
		});
		expect(pairs).toEqual([]);
	});

	it("sorts by strength desc, then support desc, and orders each pair lexicographically", () => {
		const pairs = computeCoupling(parseNameOnlyLog(LOG), {
			minSupport: 1,
			maxCommitFiles: 30,
			minStrength: 0,
		});
		expect(pairs[0]?.a).toBe("src/a.ts");
		expect(pairs[0]?.strength).toBeGreaterThanOrEqual(pairs[pairs.length - 1]?.strength ?? 0);
		for (const p of pairs) expect(p.a < p.b).toBe(true);
	});

	it("de-duplicates repeated paths inside one commit before counting", () => {
		const dupes = ["kkk\t1700001000", "src/a.ts", "src/a.ts", "src/b.ts", ""].join("\n");
		const pairs = computeCoupling(parseNameOnlyLog(dupes), {
			minSupport: 1,
			maxCommitFiles: 30,
			minStrength: 0,
		});
		expect(pairs).toEqual([
			{ a: "src/a.ts", b: "src/b.ts", support: 1, revA: 1, revB: 1, strength: 100 },
		]);
	});

	it("skips commits whose file list is empty", () => {
		expect(
			computeCoupling([{ sha: "z", timestamp: 1, files: [] }], {
				minSupport: 1,
				maxCommitFiles: 30,
				minStrength: 0,
			}),
		).toEqual([]);
	});

	// Regression for a lossy pair key. The pair used to be keyed as
	// `${a}\x00${b}` and decoded with split("\x00"): a path containing that byte
	// decoded into substrings that were never inputs, and the rev lookup for those
	// phantom names missed and fell back to `support`. git can never emit a NUL in
	// --name-only output, but computeCoupling is exported and takes CommitFiles
	// from any caller, so the input is reachable.
	const NUL = String.fromCharCode(0);

	it("keeps pair identity and rev counts when a path contains the old key delimiter", () => {
		const weird = `a${NUL}b`;
		const pairs = computeCoupling(
			[
				{ sha: "s1", timestamp: 1, files: [weird, "c"] },
				{ sha: "s2", timestamp: 2, files: [weird, "c"] },
				{ sha: "s3", timestamp: 3, files: [weird, "d"] },
			],
			{ minSupport: 2, maxCommitFiles: 30, minStrength: 0 },
		);
		// weird has 3 revs, c has 2, together 2 → 2 / 2.5 = 80%. The old encoding
		// reported a="a", b="b", revA=revB=2 (the fallback) and a bogus 100%.
		expect(pairs).toEqual([
			{ a: weird, b: "c", support: 2, revA: 3, revB: 2, strength: 80 },
		]);
	});

	it("does not merge two distinct pairs that flatten to the same delimiter-joined key", () => {
		const pairs = computeCoupling(
			[
				{ sha: "s1", timestamp: 1, files: [`a${NUL}b`, "c"] },
				{ sha: "s2", timestamp: 2, files: ["a", `b${NUL}c`] },
			],
			{ minSupport: 1, maxCommitFiles: 30, minStrength: 0 },
		);
		// Both pairs flatten to "a\x00b\x00c"; the old map counted them as one pair
		// with support 2. Sorted here by code unit — localeCompare's ordering of a
		// control character is locale-dependent, so the SUT's tie-break is not pinned.
		expect(pairs).toHaveLength(2);
		expect(pairs.map((p) => `${p.a}|${p.b}`).sort()).toEqual(
			[`a${NUL}b|c`, `a|b${NUL}c`].sort(),
		);
		expect(pairs.map((p) => p.support)).toEqual([1, 1]);
	});
});

describe("isCompanionPair", () => {
	it("matches same-dir test/SUT siblings in both extensions", () => {
		expect(isCompanionPair("src/foo.ts", "src/foo.test.ts")).toBe(true);
		expect(isCompanionPair("src/foo.spec.tsx", "src/foo.tsx")).toBe(true);
	});

	it("matches __tests__/ siblings with the same stem", () => {
		expect(isCompanionPair("src/x/__tests__/foo.test.ts", "src/x/foo.ts")).toBe(true);
	});

	it("rejects unrelated files, cross-stem tests, and cross-dir pairs", () => {
		expect(isCompanionPair("src/foo.ts", "src/bar.test.ts")).toBe(false);
		expect(isCompanionPair("src/a/foo.ts", "src/b/foo.test.ts")).toBe(false);
		expect(isCompanionPair("src/foo.ts", "src/bar.ts")).toBe(false);
	});
});

describe("annotateRelations", () => {
	const base = { support: 3, revA: 3, revB: 3, strength: 100 };
	it("labels companions by name before consulting the graph", () => {
		const [p] = annotateRelations(
			[{ a: "src/foo.test.ts", b: "src/foo.ts", ...base }],
			() => false,
		);
		expect(p?.relation).toBe("companion");
	});

	it("labels linked vs hidden from the import lookup", () => {
		const pairs = annotateRelations(
			[
				{ a: "src/a.ts", b: "src/b.ts", ...base },
				{ a: "src/a.ts", b: "src/c.ts", ...base },
			],
			(a, b) => a === "src/a.ts" && b === "src/b.ts",
		);
		expect(pairs[0]?.relation).toBe("linked");
		expect(pairs[1]?.relation).toBe("hidden");
	});

	it("labels unknown when the lookup is unavailable", () => {
		const [p] = annotateRelations([{ a: "src/a.ts", b: "src/b.ts", ...base }], () => null);
		expect(p?.relation).toBe("unknown");
	});
});

// ===========================================
// metricsCouplingCommand — end-to-end against a real throwaway git repo
// ===========================================

/**
 * Env for the fixture's own git invocations. EVERY ambient `GIT_*` variable is
 * dropped, not just the config ones. Both hazards were measured on the pre-fix
 * env shape (`{...process.env, GIT_CONFIG_*}`), which inherited them:
 * - `GIT_DIR` / `GIT_WORK_TREE` point `git init` / `add` / `commit` at whatever
 *   repository the ambient env names, not the tmpdir — the fixture build then
 *   fails outright at `git commit` (or writes into that other repository).
 * - `GIT_COMMITTER_DATE` (exported by `git am`, `git rebase`, `git bisect run`
 *   and some CI images) stamps every fixture commit at that date: with
 *   `2001-01-01` set, `git log --since='90 days ago'` returns 0 commits, which
 *   would zero `commits_scanned` and fail most assertions below.
 */
function fixtureGitEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	// Set after the strip, so these are the only GIT_* the fixture ever sees.
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	env.GIT_CONFIG_SYSTEM = "/dev/null";
	env.GIT_AUTHOR_NAME = "Fixture";
	env.GIT_AUTHOR_EMAIL = "fixture@example.invalid";
	env.GIT_COMMITTER_NAME = "Fixture";
	env.GIT_COMMITTER_EMAIL = "fixture@example.invalid";
	return env;
}

/**
 * The command shells out to git with the *process* environment, which the fixture
 * env above cannot reach — so the ambient `GIT_*` set is stripped from
 * `process.env` for the duration of each end-to-end test and restored afterwards.
 */
const AMBIENT_GIT_ENV: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
	if (key.startsWith("GIT_") && value !== undefined) AMBIENT_GIT_ENV[key] = value;
}

function scrubAmbientGitEnv(): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("GIT_")) delete process.env[key];
	}
}

/** Back to exactly the set captured at module load — including anything a test added. */
function restoreAmbientGitEnv(): void {
	scrubAmbientGitEnv();
	Object.assign(process.env, AMBIENT_GIT_ENV);
}

/** Groups of files that co-change together, one group per relation label. */
const CO_CHANGE_GROUPS: Array<{ files: string[]; seed: (n: number) => string[] }> = [
	{
		// alpha imports beta → the import graph knows about this edge → "linked"
		files: ["src/alpha.ts", "src/beta.ts"],
		seed: (n) => [`import { beta } from "./beta.js";\nexport const alpha = beta + ${n};\n`, `export const beta = ${n};\n`],
	},
	{
		// no import edge either way → "hidden", the signal this command exists for
		files: ["src/gamma.ts", "src/delta.ts"],
		seed: (n) => [`export const gamma = ${n};\n`, `export const delta = ${n};\n`],
	},
	{
		// same-stem test/SUT siblings → "companion"
		files: ["src/epsilon.ts", "src/epsilon.test.ts"],
		seed: (n) => [`export const epsilon = ${n};\n`, `import "./epsilon.js"; // ${n}\n`],
	},
	{
		// a non-code file sorts FIRST in the pair → left side missing from the graph
		files: ["docs/notes.md", "src/zeta.ts"],
		seed: (n) => [`# notes ${n}\n`, `export const zeta = ${n};\n`],
	},
	{
		// a non-code file sorts SECOND in the pair → right side missing from the graph
		files: ["src/eta.ts", "src/zz-notes.txt"],
		seed: (n) => [`export const eta = ${n};\n`, `plain text ${n}\n`],
	},
	{
		// dist/ is excluded before pairing, so this group must yield NO pair at all
		files: ["dist/bundle.js", "src/omega.ts"],
		seed: (n) => [`export const bundled = ${n};\n`, `export const omega = ${n};\n`],
	},
	{
		// theta also changes alone (see SOLO_COMMITS), so this is the one group whose
		// two members have DIFFERENT rev counts — support 5, revs 5 and 10. Without
		// it every pair is support == revA == revB and support/mean, support/revA,
		// support/revB, min and max are all indistinguishable at 100%.
		files: ["src/iota.ts", "src/theta.ts"],
		seed: (n) => [
			`export const iota = ${n};\n`,
			`import { iota } from "./iota.js";\nexport const theta = iota + ${n};\n`,
		],
	},
];

const COMMITS_PER_GROUP = 5;
/** Commits touching only src/theta.ts — they raise its rev count without adding pairs. */
const SOLO_COMMITS = 5;
/** Every group's commits, the solo commits, plus one commit touching only an excluded path. */
const TOTAL_COMMITS = CO_CHANGE_GROUPS.length * COMMITS_PER_GROUP + SOLO_COMMITS + 1;

function buildFixtureRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "metrics-coupling-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8", env: fixtureGitEnv(), stdio: "pipe" });
	git("init", "-q", "-b", "main");
	for (let n = 0; n < COMMITS_PER_GROUP; n++) {
		for (const group of CO_CHANGE_GROUPS) {
			const bodies = group.seed(n);
			group.files.forEach((rel, i) => {
				const abs = join(root, rel);
				mkdirSync(dirname(abs), { recursive: true });
				writeFileSync(abs, bodies[i] ?? "");
			});
			git("add", "-Af");
			git("commit", "-qm", `${group.files[0]} rev ${n}`);
		}
		// theta alone — keeps the import (so the pair still resolves as "linked" from
		// the final tree) but differs from the group body, so git records a change.
		writeFileSync(
			join(root, "src/theta.ts"),
			`import { iota } from "./iota.js";\nexport const theta = iota + ${n}; // solo\n`,
		);
		git("add", "-Af");
		git("commit", "-qm", `theta solo ${n}`);
	}
	// A commit whose entire file list is excluded — must be skipped, not crash.
	writeFileSync(join(root, "dist/bundle.js"), "export const bundled = 99;\n");
	git("add", "-Af");
	git("commit", "-qm", "dist only");
	return root;
}

let repo: string;
let logged: string[];
let stderrText: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
	scrubAmbientGitEnv();
	repo = buildFixtureRepo();
}, 120_000);

afterAll(() => {
	restoreAmbientGitEnv();
	if (repo) rmSync(repo, { recursive: true, force: true });
});

function captureOutput(): void {
	// The command's own `git log` inherits process.env, so scrub here too — this is
	// the only place that can protect it.
	scrubAmbientGitEnv();
	logged = [];
	stderrText = "";
	logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logged.push(args.map(String).join(" "));
	});
	errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		stderrText += String(chunk);
		return true;
	});
}

afterEach(() => {
	logSpy?.mockRestore();
	errSpy?.mockRestore();
	vi.restoreAllMocks();
	restoreAmbientGitEnv();
	process.exitCode = undefined;
});

/** The rendered table body, minus the header/blank/footer scaffolding. */
function tableRows(text: string): string[] {
	return text
		.split("\n")
		.filter((l) => l.includes("↔"))
		.map((l) => l.trimEnd());
}

describe("metricsCouplingCommand — JSON output", () => {
	it("reports every co-changed pair with its relation, revisions, and strength", async () => {
		captureOutput();
		await metricsCouplingCommand({ cwd: repo, json: true });
		expect(process.exitCode).toBeUndefined();
		expect(logged).toHaveLength(1);
		const payload = parseWire(JSON.parse(logged[0] ?? ""), wireObject({ "since": wireString, "commits_scanned": wireNumber, "pairs": wireArray(wireObject({ "a": wireString, "b": wireString, "support": wireNumber, "revA": wireNumber, "revB": wireNumber, "strength": wireNumber, "relation": wireString })) }), "test JSON value");
		expect(payload.since).toBe("90 days ago");
		expect(payload.commits_scanned).toBe(TOTAL_COMMITS);
		// Every group but the last co-changes on all 5 of its own commits and nowhere
		// else → support == revA == revB == 5, a clean 100%. iota/theta is the
		// asymmetric one: theta also changed alone 5 times, so revB is 10 and the
		// strength is 5 / ((5 + 10) / 2) = 67% — a value support/revA (100),
		// support/revB (50), min and max all disagree with.
		expect(payload.pairs).toEqual([
			{
				a: "docs/notes.md",
				b: "src/zeta.ts",
				support: 5,
				revA: 5,
				revB: 5,
				strength: 100,
				relation: "unknown",
			},
			{
				a: "src/alpha.ts",
				b: "src/beta.ts",
				support: 5,
				revA: 5,
				revB: 5,
				strength: 100,
				relation: "linked",
			},
			{
				a: "src/delta.ts",
				b: "src/gamma.ts",
				support: 5,
				revA: 5,
				revB: 5,
				strength: 100,
				relation: "hidden",
			},
			{
				a: "src/epsilon.test.ts",
				b: "src/epsilon.ts",
				support: 5,
				revA: 5,
				revB: 5,
				strength: 100,
				relation: "companion",
			},
			{
				a: "src/eta.ts",
				b: "src/zz-notes.txt",
				support: 5,
				revA: 5,
				revB: 5,
				strength: 100,
				relation: "unknown",
			},
			{
				a: "src/iota.ts",
				b: "src/theta.ts",
				support: 5,
				revA: 5,
				revB: 10,
				strength: 67,
				relation: "linked",
			},
		]);
	}, 60_000);

	it("drops excluded paths before pairing, so dist/ never reaches the report", async () => {
		captureOutput();
		await metricsCouplingCommand({ cwd: repo, json: true, minSupport: "1", minStrength: "1" });
		const payload = parseWire(JSON.parse(logged[0] ?? ""), wireObject({ "pairs": wireArray(wireObject({ "a": wireString, "b": wireString })) }), "test JSON value");
		const paths = payload.pairs.flatMap((p) => [p.a, p.b]);
		expect(paths).not.toContain("dist/bundle.js");
		// src/omega.ts co-changed only with the excluded file, so it is left unpaired
		// even at minSupport 1 — proof the exclusion happened before pairing, not after.
		expect(paths).not.toContain("src/omega.ts");
	}, 60_000);

	it("honours an explicit --since by passing it to git and echoing it back", async () => {
		captureOutput();
		await metricsCouplingCommand({ cwd: repo, json: true, since: "1970-01-01" });
		const payload = parseWire(JSON.parse(logged[0] ?? ""), wireObject({ "since": wireString, "commits_scanned": wireNumber }), "test JSON value");
		expect(payload.since).toBe("1970-01-01");
		expect(payload.commits_scanned).toBe(TOTAL_COMMITS);
	}, 60_000);

	it("scans nothing when --since excludes the whole history", async () => {
		// A year out, not a far-future literal: git's approxidate silently ignores
		// dates it cannot represent, which would quietly return the full history.
		const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);
		captureOutput();
		await metricsCouplingCommand({ cwd: repo, json: true, since: nextYear });
		expect(JSON.parse(logged[0] ?? "")).toEqual({
			since: nextYear,
			commits_scanned: 0,
			pairs: [],
		});
	}, 60_000);
});

describe("metricsCouplingCommand — thresholds and limits", () => {
	const cases: Array<{ name: string; opts: Record<string, string>; expectPairs: number }> = [
		{ name: "default thresholds keep all six groups", opts: {}, expectPairs: 6 },
		{ name: "--limit truncates the ranked list", opts: { limit: "2" }, expectPairs: 2 },
		{ name: "--min-support above actual support drops everything", opts: { minSupport: "6" }, expectPairs: 0 },
		{ name: "--min-strength above 100 drops everything", opts: { minStrength: "101" }, expectPairs: 0 },
		{
			// 5 / mean(5, 10) = 67, so a 60% floor keeps the asymmetric pair. Were the
			// strength support/revB (50) it would be dropped here.
			name: "--min-strength below the asymmetric pair's 67% keeps it",
			opts: { minStrength: "60" },
			expectPairs: 6,
		},
		{
			// …and a 68% floor drops exactly that pair. Were the strength support/revA
			// (100) it would survive.
			name: "--min-strength above the asymmetric pair's 67% drops exactly that pair",
			opts: { minStrength: "68" },
			expectPairs: 5,
		},
		{
			name: "--max-commit-files below the group size skips every commit as bulk",
			opts: { maxCommitFiles: "1" },
			expectPairs: 0,
		},
		{
			name: "non-numeric --min-support falls back to the documented default of 4",
			opts: { minSupport: "not-a-number" },
			expectPairs: 6,
		},
		{
			name: "non-numeric --limit falls back to the documented default of 25",
			opts: { limit: "banana" },
			expectPairs: 6,
		},
		{
			// Blank still means "unset": Number("") is 0, which would skip every commit.
			name: "blank --max-commit-files falls back to the documented default of 30",
			opts: { maxCommitFiles: "" },
			expectPairs: 6,
		},
		{
			// Was a reported wart — `Number(raw) || default` made every explicit zero
			// fall through to the default (30 here, and a 30% floor for
			// --min-strength 0). Fixed in metrics-coupling.ts alongside this test:
			// 0 now means "no commit may touch more than 0 files", so nothing pairs.
			name: "--max-commit-files 0 is honoured, not swallowed by the default",
			opts: { maxCommitFiles: "0" },
			expectPairs: 0,
		},
		{
			name: "--limit 0 is honoured, not swallowed by the default",
			opts: { limit: "0" },
			expectPairs: 0,
		},
	];

	for (const { name, opts, expectPairs } of cases) {
		it(name, async () => {
			captureOutput();
			await metricsCouplingCommand({ cwd: repo, json: true, ...opts });
			const payload = parseWire(JSON.parse(logged[0] ?? ""), wireObject({ "pairs": wireArray(wireUnknown) }), "test JSON value");
			expect(payload.pairs).toHaveLength(expectPairs);
		}, 60_000);
	}

	it("--limit keeps the highest-ranked pairs, not an arbitrary slice", async () => {
		captureOutput();
		await metricsCouplingCommand({ cwd: repo, json: true, limit: "2" });
		const payload = parseWire(JSON.parse(logged[0] ?? ""), wireObject({ "pairs": wireArray(wireObject({ "a": wireString })) }), "test JSON value");
		expect(payload.pairs.map((p) => p.a)).toEqual(["docs/notes.md", "src/alpha.ts"]);
	}, 60_000);

	it("--min-support 5 with a 4-commit floor keeps only groups meeting the floor", async () => {
		captureOutput();
		await metricsCouplingCommand({ cwd: repo, json: true, minSupport: "5" });
		const payload = parseWire(JSON.parse(logged[0] ?? ""), wireObject({ "pairs": wireArray(wireObject({ "support": wireNumber })) }), "test JSON value");
		expect(payload.pairs).toHaveLength(6);
		for (const p of payload.pairs) expect(p.support).toBeGreaterThanOrEqual(5);
	}, 60_000);
});

describe("metricsCouplingCommand — human-readable rendering", () => {
	it("renders a padded table with a scan header and a hidden-pair footer", async () => {
		captureOutput();
		await metricsCouplingCommand({ cwd: repo });
		expect(logged).toHaveLength(1);
		const text = logged[0] ?? "";
		const lines = text.split("\n");
		expect(lines[0]).toBe(`Change coupling — ${TOTAL_COMMITS} commits since 90 days ago`);
		expect(lines[1]).toBe("");
		expect(lines[2]).toBe("  str%  n   revs      relation   pair");
		expect(tableRows(text)).toEqual([
			"   100    5 5/5       unknown    docs/notes.md ↔ src/zeta.ts",
			"   100    5 5/5       linked     src/alpha.ts ↔ src/beta.ts",
			"   100    5 5/5       hidden     src/delta.ts ↔ src/gamma.ts",
			"   100    5 5/5       companion  src/epsilon.test.ts ↔ src/epsilon.ts",
			"   100    5 5/5       unknown    src/eta.ts ↔ src/zz-notes.txt",
			"    67    5 5/10      linked     src/iota.ts ↔ src/theta.ts",
		]);
		expect(lines[lines.length - 1]).toBe(
			"6 pairs (1 hidden — co-change with no import edge either way).",
		);
	}, 60_000);

	it("renders an empty table with a zero footer when nothing clears the thresholds", async () => {
		captureOutput();
		await metricsCouplingCommand({ cwd: repo, minSupport: "99" });
		const text = logged[0] ?? "";
		expect(tableRows(text)).toEqual([]);
		expect(text).toContain(`Change coupling — ${TOTAL_COMMITS} commits since 90 days ago`);
		expect(text.endsWith("0 pairs (0 hidden — co-change with no import edge either way).")).toBe(
			true,
		);
	}, 60_000);

	it("--short collapses to one line counting pairs and hidden pairs", async () => {
		captureOutput();
		await metricsCouplingCommand({ cwd: repo, short: true });
		expect(logged).toEqual(["6 coupled pairs, 1 hidden"]);
	}, 60_000);

	it("--json wins over --short when both are set", async () => {
		captureOutput();
		await metricsCouplingCommand({ cwd: repo, json: true, short: true });
		// The full JSON payload, not merely "it parsed": a mode mix-up that emitted a
		// different-but-valid JSON document would survive a parse-only assertion.
		expect(logged).toHaveLength(1);
		const payload = parseWire(JSON.parse(logged[0] ?? ""), wireObject({ "since": wireString, "commits_scanned": wireNumber, "pairs": wireArray(wireObject({ "a": wireString, "b": wireString, "strength": wireNumber, "relation": wireString })) }), "test JSON value");
		expect(payload.since).toBe("90 days ago");
		expect(payload.commits_scanned).toBe(TOTAL_COMMITS);
		expect(payload.pairs.map((p) => `${p.a} ${p.b} ${p.strength} ${p.relation}`)).toEqual([
			"docs/notes.md src/zeta.ts 100 unknown",
			"src/alpha.ts src/beta.ts 100 linked",
			"src/delta.ts src/gamma.ts 100 hidden",
			"src/epsilon.test.ts src/epsilon.ts 100 companion",
			"src/eta.ts src/zz-notes.txt 100 unknown",
			"src/iota.ts src/theta.ts 67 linked",
		]);
	}, 60_000);
});

describe("metricsCouplingCommand — import-graph fallback", () => {
	it("labels every non-companion pair unknown when the import graph fails to build", async () => {
		// A real dependency (ProjectGraph), not the SUT: forces importLookupFor's
		// internal try/catch down its catch arm without touching product source.
		vi.spyOn(ProjectGraph.prototype, "initialize").mockImplementationOnce(() => {
			throw new Error("scan failed");
		});
		captureOutput();
		await metricsCouplingCommand({ cwd: repo });
		expect(process.exitCode).toBeUndefined();
		const text = logged[0] ?? "";
		// Same six pairs as the healthy-graph render above, but every pair the graph
		// would otherwise have resolved ("linked"/"hidden") now reads "unknown" —
		// isCompanionPair is checked before the lookup, so epsilon stays "companion".
		// If the catch arm were removed, ProjectGraph.initialize's throw would
		// propagate out of importLookupFor and this await would reject instead.
		// If the catch instead returned `() => true`, delta/gamma and eta/zz-notes
		// would read "linked", not "unknown", failing this exact assertion.
		expect(tableRows(text)).toEqual([
			"   100    5 5/5       unknown    docs/notes.md ↔ src/zeta.ts",
			"   100    5 5/5       unknown    src/alpha.ts ↔ src/beta.ts",
			"   100    5 5/5       unknown    src/delta.ts ↔ src/gamma.ts",
			"   100    5 5/5       companion  src/epsilon.test.ts ↔ src/epsilon.ts",
			"   100    5 5/5       unknown    src/eta.ts ↔ src/zz-notes.txt",
			"    67    5 5/10      unknown    src/iota.ts ↔ src/theta.ts",
		]);
		expect(text.endsWith("6 pairs (0 hidden — co-change with no import edge either way).")).toBe(
			true,
		);
	}, 60_000);
});

describe("metricsCouplingCommand — defaults and failure", () => {
	it("falls back to process.cwd() when no --cwd is given", async () => {
		captureOutput();
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repo);
		await metricsCouplingCommand({ json: true });
		cwdSpy.mockRestore();
		const payload = parseWire(JSON.parse(logged[0] ?? ""), wireObject({ "commits_scanned": wireNumber, "pairs": wireArray(wireUnknown) }), "test JSON value");
		expect(payload.commits_scanned).toBe(TOTAL_COMMITS);
		expect(payload.pairs).toHaveLength(6);
	}, 60_000);

	it("ignores an ambient GIT_DIR and still reports on the --cwd repo", async () => {
		// Without the scrub in captureOutput() the command's own `git log` inherits
		// this and dies with "fatal: not a git repository", exit 1, no report.
		process.env.GIT_DIR = join(repo, "not-a-git-dir");
		captureOutput();
		await metricsCouplingCommand({ cwd: repo, json: true });
		expect(process.exitCode).toBeUndefined();
		const payload = parseWire(JSON.parse(logged[0] ?? ""), wireObject({ "commits_scanned": wireNumber, "pairs": wireArray(wireUnknown) }), "test JSON value");
		expect(payload.commits_scanned).toBe(TOTAL_COMMITS);
		expect(payload.pairs).toHaveLength(6);
	}, 60_000);

	it("reports the git failure on stderr, exits 1, and prints no report", async () => {
		captureOutput();
		await metricsCouplingCommand({ cwd: join(repo, "no-such-directory"), json: true });
		expect(process.exitCode).toBe(1);
		expect(logged).toEqual([]);
		expect(stderrText.startsWith("git log failed: ")).toBe(true);
		// Only the first line of the git error is surfaced — the rest is spawn noise.
		expect(stderrText.split("\n").filter((l) => l !== "")).toHaveLength(1);
	}, 60_000);
});

// ===========================================
// fixture hygiene — the fixture must not read or write ambient git state
// ===========================================

describe("fixtureGitEnv", () => {
	it("drops every ambient GIT_* variable and keeps the rest of the environment", () => {
		const env = fixtureGitEnv({
			PATH: "/usr/bin",
			HOME: "/home/nobody",
			GIT_DIR: "/hostile/.git",
			GIT_WORK_TREE: "/hostile",
			GIT_INDEX_FILE: "/hostile/.git/index",
			GIT_OBJECT_DIRECTORY: "/hostile/.git/objects",
			GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z",
			GIT_AUTHOR_NAME: "Ambient",
		});
		expect(env.PATH).toBe("/usr/bin");
		expect(env.HOME).toBe("/home/nobody");
		// Exact set, so re-introducing a `...process.env` spread fails here.
		expect(Object.keys(env).filter((k) => k.startsWith("GIT_")).sort()).toEqual([
			"GIT_AUTHOR_EMAIL",
			"GIT_AUTHOR_NAME",
			"GIT_COMMITTER_EMAIL",
			"GIT_COMMITTER_NAME",
			"GIT_CONFIG_GLOBAL",
			"GIT_CONFIG_SYSTEM",
		]);
		expect(env.GIT_AUTHOR_NAME).toBe("Fixture");
		expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
	});

	it("keeps fixture commits inside their own repo and off the ambient clock", () => {
		const outer = mkdtempSync(join(tmpdir(), "metrics-coupling-outer-"));
		const inner = mkdtempSync(join(tmpdir(), "metrics-coupling-inner-"));
		const run = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
			execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });
		try {
			// A second repository, named by the hostile env below. Under the pre-fix
			// env shape (ambient GIT_* inherited) the fixture's git calls target THIS
			// repo rather than `inner` — measured: the build then dies at `git commit`.
			run(outer, fixtureGitEnv(), "init", "-q", "-b", "main");
			writeFileSync(join(outer, "seed.txt"), "seed\n");
			run(outer, fixtureGitEnv(), "add", "-A");
			run(outer, fixtureGitEnv(), "commit", "-qm", "seed");

			const hostile: NodeJS.ProcessEnv = {
				...process.env,
				GIT_DIR: join(outer, ".git"),
				GIT_WORK_TREE: outer,
				GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z",
				GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
			};
			const git = (...args: string[]) => run(inner, fixtureGitEnv(hostile), ...args);
			git("init", "-q", "-b", "main");
			writeFileSync(join(inner, "a.txt"), "a\n");
			git("add", "-A");
			git("commit", "-qm", "fixture");

			expect(git("log", "--pretty=format:%s").trim()).toBe("fixture");
			// The enclosing repo is untouched — one commit, still its own.
			expect(run(outer, fixtureGitEnv(), "log", "--pretty=format:%s").trim()).toBe("seed");
			// And the commit is stamped now, not back-dated out of a --since window.
			const committedAt = Number(git("log", "-1", "--pretty=format:%ct").trim());
			expect(Math.abs(Date.now() / 1000 - committedAt)).toBeLessThan(600);
		} finally {
			rmSync(outer, { recursive: true, force: true });
			rmSync(inner, { recursive: true, force: true });
		}
	}, 60_000);
});
