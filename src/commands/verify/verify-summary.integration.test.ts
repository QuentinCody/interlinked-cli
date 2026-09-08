import { parseWire, wireRecord, wireUnknown } from "../../lib/value-validation.js";
// ===========================================
// verify-summary unit tests
// ===========================================
// Two layers:
//   1. `summarizeFlaggedFiles` — the tail "X / Y files flagged" pure helper.
//      Pins: numerator ≤ denominator (regression: v0 produced 68 / 67),
//      synthetic sentinels like "<project>" do not inflate the numerator, and
//      a file flagged outside the discovered sweep (e.g. tsc error in
//      tsconfig.json) expands both sides so the ratio stays meaningful.
//   2. The stderr stream* reporters + the `verify-runs.jsonl` emitter. Sibling
//      modules and node:fs / node:child_process are mocked so every branch
//      (empty/non-empty, plural counts, skip notes, error paths, the
//      cap/overflow lines, git-output ternaries) is asserted against the exact
//      bytes written to stderr / the exact JSONL row appended.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";

// --- sibling mocks -----------------------------------------------------------
vi.mock("./tool-results.js", () => ({
	checkProjectSetup: vi.fn(),
	runSuggestions: vi.fn(),
}));
vi.mock("../../harness/registry-parity.js", () => ({
	runRegistryParityCheck: vi.fn(),
}));
vi.mock("../../harness/case-divergence.js", () => ({
	runCaseDivergenceCheck: vi.fn(),
}));
vi.mock("../../harness/supermodel-analyses.js", () => ({
	isSupermodelCliAvailable: vi.fn(),
	runSupermodelDeadCode: vi.fn(),
	formatDeadCodeFindings: vi.fn(),
}));
vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	appendFileSync: vi.fn(),
}));
vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { runCaseDivergenceCheck } from "../../harness/case-divergence.js";
import type { ProjectSetupIssue } from "../../harness/checks/project-setup.js";
import { runRegistryParityCheck } from "../../harness/registry-parity.js";
import {
	formatDeadCodeFindings,
	isSupermodelCliAvailable,
	runSupermodelDeadCode,
} from "../../harness/supermodel-analyses.js";
import { checkProjectSetup, runSuggestions } from "./tool-results.js";
import {
	emitVerifyRun,
	streamCaseDivergence,
	streamDecisionSurfaceRatchet,
	streamLockfileMultiplicity,
	streamProjectSetup,
	streamRegistryParity,
	streamSuggestionsSummary,
	streamSupermodelDeadCode,
	streamUndocumentedEnvVars,
	summarizeFlaggedFiles,
} from "./verify-summary.js";

// --- stderr capture ----------------------------------------------------------
let stderrChunks: string[];
let origErr: typeof process.stderr.write;
const out = () => stderrChunks.join("");

beforeEach(() => {
	stderrChunks = [];
	origErr = process.stderr.write;
	process.stderr.write = ((chunk: string) => {
		stderrChunks.push(chunk);
		return true;
	});
	vi.clearAllMocks();
});

afterEach(() => {
	process.stderr.write = origErr;
});

// =============================================================================
describe("summarizeFlaggedFiles", () => {
	it("reports numerator ≤ denominator and drops the <project> sentinel", () => {
		const cwd = "/repo";
		const files = [`${cwd}/src/a.ts`, `${cwd}/src/b.ts`, `${cwd}/src/c.ts`];
		// Mirror the real mix in allFlaggedFiles: absolute hit, relative hit,
		// bare-filename hit, the project sentinel.
		const flagged = new Set([
			`${cwd}/src/a.ts`, // absolute — same as discovered[0]
			"src/b.ts", // relative — same as discovered[1]
			"tsconfig.json", // non-source file flagged by tsc
			"<project>", // project-wide LOC-ratio finding
		]);
		const tally = summarizeFlaggedFiles(cwd, files, flagged);
		expect(tally.flaggedFiles).toBe(3); // a.ts, b.ts, tsconfig.json
		expect(tally.totalFiles).toBe(4); // + c.ts from discovered
		expect(tally.projectFindings).toBe(1);
		expect(tally.flaggedFiles).toBeLessThanOrEqual(tally.totalFiles);
	});

	it("never exceeds the denominator even when every path is synthetic or non-discovered", () => {
		const cwd = "/repo";
		const flagged = new Set(["<project>", "<project>", "tsconfig.json", "package.json"]);
		const tally = summarizeFlaggedFiles(cwd, [], flagged);
		// A Set collapses the duplicate "<project>" token, so only one project
		// finding reaches us. Both non-source hits land in the universe.
		expect(tally.flaggedFiles).toBe(2);
		expect(tally.totalFiles).toBe(2);
		expect(tally.projectFindings).toBe(1);
		expect(tally.flaggedFiles).toBeLessThanOrEqual(tally.totalFiles);
	});

	it("returns a zero tally when nothing is flagged", () => {
		const cwd = "/repo";
		const files = [`${cwd}/src/a.ts`, `${cwd}/src/b.ts`];
		const tally = summarizeFlaggedFiles(cwd, files, new Set());
		expect(tally).toEqual({ flaggedFiles: 0, totalFiles: 2, projectFindings: 0 });
	});

	it("leaves a synthetic token unchanged when it reaches path normalization via the discovered set", () => {
		// The discovered `files` are mapped through normalizeFlaggedPath; a
		// synthetic sentinel must pass through by identity (not relativized) so
		// the universe-vs-flagged identity comparison still lines up. This pins
		// the defensive `SYNTHETIC_FILE_TOKENS.has(p)` guard inside
		// normalizeFlaggedPath, which the flagged-loop short-circuit otherwise
		// keeps it from reaching.
		const cwd = "/repo";
		// "<project>" in the discovered universe (identity-preserved) and the
		// same sentinel in flagged (counted as a project finding, not a file).
		const tally = summarizeFlaggedFiles(cwd, ["<project>"], new Set(["<project>"]));
		expect(tally.flaggedFiles).toBe(0); // sentinel is not a real file
		expect(tally.totalFiles).toBe(1); // the identity-preserved sentinel
		expect(tally.projectFindings).toBe(1);
	});
});

// =============================================================================
describe("emitVerifyRun", () => {
	const baseData = {
		mode: "default",
		files_scanned: 12,
		flagged_files: 3,
		project_findings: 1,
		summary: [
			{ label: "errors", count: 2, color: "31" },
			{ label: "warnings", count: 5, color: "33" },
		],
		duration_ms: 432,
	};

	function lastRecord(): Record<string, unknown> {
		expect(vi.mocked(appendFileSync)).toHaveBeenCalledTimes(1);
		const [, payload] = nonNull(vi.mocked(appendFileSync).mock.calls[0]);
		const text = String(payload);
		expect(text.endsWith("\n")).toBe(true);
		return parseWire(JSON.parse(text), wireRecord(wireUnknown), "test JSON value");
	}

	it("appends a full JSONL row with git context, creating the dir when absent", () => {
		vi.mocked(existsSync).mockReturnValue(false); // dir missing -> mkdir branch
		vi.mocked(execFileSync)
			.mockReturnValueOnce("feature/x\n") // rev-parse --abbrev-ref HEAD
			.mockReturnValueOnce("abc123\n") // rev-parse HEAD
			.mockReturnValueOnce(" M src/a.ts\n"); // status --porcelain -> dirty
		const prevExit = process.exitCode;
		process.exitCode = 7;
		try {
			emitVerifyRun("/repo", baseData);
		} finally {
			process.exitCode = prevExit;
		}

		// dir created, exactly one append to the right path
		expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith(
			expect.stringContaining(".interlinked"),
			{ recursive: true },
		);
		const [path] = nonNull(vi.mocked(appendFileSync).mock.calls[0]);
		expect(String(path).endsWith(".interlinked/verify-runs.jsonl")).toBe(true);

		const rec = lastRecord();
		expect(rec.cwd).toBe("/repo");
		expect(rec.branch).toBe("feature/x"); // trimmed
		expect(rec.head).toBe("abc123");
		expect(rec.dirty).toBe(true); // non-empty porcelain
		expect(rec.mode).toBe("default");
		expect(rec.files_scanned).toBe(12);
		expect(rec.flagged_files).toBe(3);
		expect(rec.project_findings).toBe(1);
		expect(rec.duration_ms).toBe(432);
		expect(rec.exit_code).toBe(7); // process.exitCode || 0 -> 7
		// counts strips the color, keeps label+count
		expect(rec.counts).toEqual([
			{ label: "errors", count: 2 },
			{ label: "warnings", count: 5 },
		]);
		expect(typeof rec.ts).toBe("string");
	});

	it("skips mkdir when the dir exists and records clean/null git state with exit_code 0", () => {
		vi.mocked(existsSync).mockReturnValue(true); // dir present -> no mkdir
		// All git calls fail -> safeGitOutput returns "" -> branch/head null, dirty false
		vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error("not a git repo");
		});
		const prevExit = process.exitCode;
		process.exitCode = 0; // falsy -> `|| 0`
		try {
			emitVerifyRun("/repo", baseData);
		} finally {
			process.exitCode = prevExit;
		}

		expect(vi.mocked(mkdirSync)).not.toHaveBeenCalled();
		const rec = lastRecord();
		expect(rec.branch).toBeNull(); // "" || null
		expect(rec.head).toBeNull();
		expect(rec.dirty).toBe(false); // "" -> false
		expect(rec.exit_code).toBe(0);
	});

	it("treats an empty porcelain string as not dirty (false branch)", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(execFileSync)
			.mockReturnValueOnce("main\n")
			.mockReturnValueOnce("deadbeef\n")
			.mockReturnValueOnce("   \n"); // whitespace-only -> trim() -> "" -> dirty false
		emitVerifyRun("/repo", baseData);
		const rec = lastRecord();
		expect(rec.branch).toBe("main");
		expect(rec.dirty).toBe(false);
	});

	it("swallows errors from the filesystem (best-effort observability)", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(execFileSync).mockReturnValue("");
		vi.mocked(appendFileSync).mockImplementation(() => {
			throw new Error("EACCES");
		});
		// Must not throw.
		expect(() => emitVerifyRun("/repo", baseData)).not.toThrow();
		// Prove the swallow happens AFTER the write is attempted, not before —
		// a stub that skips the write entirely would still pass not.toThrow().
		const [writePath, writeContent] = vi.mocked(appendFileSync).mock.calls[0] ?? [];
		expect(writePath).toBe("/repo/.interlinked/verify-runs.jsonl");
		expect(String(writeContent)).toContain('"cwd":"/repo"');
	});
});

// =============================================================================
describe("streamProjectSetup", () => {
	const issue = (over: Partial<ProjectSetupIssue>): ProjectSetupIssue => ({
		check: "project_setup",
		file: "f.ts",
		line: 0,
		message: "m",
		fix: "x",
		...over,
	});

	it("prints the valid-config pass line and flags nothing when there are no issues", () => {
		vi.mocked(checkProjectSetup).mockReturnValue([]);
		const flagged = new Set<string>();
		streamProjectSetup("/repo", flagged);
		const o = out();
		expect(o).toContain("project setup");
		expect(o).toContain("configuration valid");
		expect(flagged.size).toBe(0);
	});

	it("prints each issue's message + fix and flags the offending file", () => {
		vi.mocked(checkProjectSetup).mockReturnValue([
			issue({ file: ".claude/settings.json", message: "bad rule", fix: "remove it" }),
			issue({ file: "package.json", message: "missing field", fix: "add it" }),
		]);
		const flagged = new Set<string>();
		streamProjectSetup("/repo", flagged);
		const o = out();
		expect(o).toContain("bad rule");
		expect(o).toContain("fix: remove it");
		expect(o).toContain("missing field");
		expect(o).toContain("fix: add it");
		expect(o).not.toContain("configuration valid");
		expect(flagged.has(".claude/settings.json")).toBe(true);
		expect(flagged.has("package.json")).toBe(true);
	});
});

// =============================================================================
describe("streamRegistryParity", () => {
	const finding = (id: string, source_file: string) => ({
		pair: "p",
		kind: "missing-from-right" as const,
		id,
		source_file,
		target_file: "t.ts",
		message: `drift: ${id}`,
	});

	it("is silent when there are no findings (no header written)", () => {
		vi.mocked(runRegistryParityCheck).mockReturnValue([]);
		const flagged = new Set<string>();
		streamRegistryParity("/repo", flagged);
		expect(out()).toBe("");
		expect(flagged.size).toBe(0);
	});

	it("prints a header + every finding and flags each source file", () => {
		vi.mocked(runRegistryParityCheck).mockReturnValue([
			finding("a", "left.ts"),
			finding("b", "right.ts"),
		]);
		const flagged = new Set<string>();
		streamRegistryParity("/repo", flagged);
		const o = out();
		expect(o).toContain("registry parity");
		expect(o).toContain("drift: a");
		expect(o).toContain("drift: b");
		expect(flagged.has("left.ts")).toBe(true);
		expect(flagged.has("right.ts")).toBe(true);
	});

	it("reports a config error (Error instance) without throwing", () => {
		vi.mocked(runRegistryParityCheck).mockImplementation(() => {
			throw new Error("bad config json");
		});
		const flagged = new Set<string>();
		streamRegistryParity("/repo", flagged);
		const o = out();
		expect(o).toContain("registry parity");
		expect(o).toContain("config error: bad config json");
		expect(flagged.size).toBe(0);
	});

	it("stringifies a non-Error thrown value in the config-error path", () => {
		vi.mocked(runRegistryParityCheck).mockImplementation(() => {
			// eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the String(e) branch
			throw "raw string failure";
		});
		streamRegistryParity("/repo", new Set<string>());
		expect(out()).toContain("config error: raw string failure");
	});
});

// =============================================================================
describe("streamCaseDivergence", () => {
	const finding = () => ({
		core: "userid",
		role: "value" as const,
		message: '"userId" / "user_id" — same value name in 2 case spellings; reconcile to one',
		files: ["a.ts", "b.ts"],
		spellings: [
			{
				name: "userId",
				style: "camelCase" as const,
				locs: [
					{ file: "a.ts", line: 1, kind: "const" as const },
					{ file: "z.ts", line: 9, kind: "const" as const },
				],
			},
			{
				name: "user_id",
				style: "snake_case" as const,
				locs: [{ file: "b.ts", line: 2, kind: "function" as const }],
			},
		],
	});

	it("is silent when there are no findings (no header written)", () => {
		vi.mocked(runCaseDivergenceCheck).mockReturnValue([]);
		const flagged = new Set<string>();
		streamCaseDivergence("/repo", [], flagged);
		expect(out()).toBe("");
		expect(flagged.size).toBe(0);
	});

	it("prints each finding with a +N-more hint and flags every involved file", () => {
		vi.mocked(runCaseDivergenceCheck).mockReturnValue([finding()]);
		const flagged = new Set<string>();
		streamCaseDivergence("/repo", ["a.ts"], flagged);
		const o = out();
		expect(o).toContain("case divergence");
		expect(o).toContain('"userId" / "user_id"');
		expect(o).toContain("(+1 more)");
		expect(flagged.has("a.ts")).toBe(true);
		expect(flagged.has("b.ts")).toBe(true);
	});

	it("swallows a thrown error and stays silent", () => {
		vi.mocked(runCaseDivergenceCheck).mockImplementation(() => {
			throw new Error("boom");
		});
		const flagged = new Set<string>();
		streamCaseDivergence("/repo", [], flagged);
		expect(out()).toBe("");
		expect(flagged.size).toBe(0);
	});
});

// =============================================================================
describe("streamLockfileMultiplicity", () => {
	it("is silent when multiplicity is false", () => {
		streamLockfileMultiplicity({
			lockfiles: ["package-lock.json"],
			managers: ["npm"],
			multiplicity: false,
		});
		expect(out()).toBe("");
	});

	it("lists the lockfiles and managers when multiple coexist", () => {
		streamLockfileMultiplicity({
			lockfiles: ["package-lock.json", "yarn.lock"],
			managers: ["npm", "yarn"],
			multiplicity: true,
		});
		const o = out();
		expect(o).toContain("lockfile multiplicity");
		expect(o).toContain("package-lock.json + yarn.lock"); // join(" + ")
		expect(o).toContain("npm / yarn"); // join(" / ")
		expect(o).toContain("non-deterministic");
	});
});

// =============================================================================
describe("streamDecisionSurfaceRatchet", () => {
	it("is silent when there are no warnings", () => {
		streamDecisionSurfaceRatchet({
			baselineRef: "origin/main",
			skipped: null,
			growthByCategory: { package_manager: [], test_framework: [], linter: [], formatter: [], bundler: [], http_client: [], date_lib: [] },
			totalGrowth: 0,
			warnings: [],
		});
		expect(out()).toBe("");
	});

	it("prints the baseline ref, total growth, and one line per warning", () => {
		streamDecisionSurfaceRatchet({
			baselineRef: "origin/main",
			skipped: null,
			growthByCategory: { package_manager: [], test_framework: [], linter: [], formatter: [], bundler: [], http_client: [], date_lib: [] },
			totalGrowth: 3,
			warnings: ["pre_warn gained foo", "post gained bar"],
		});
		const o = out();
		expect(o).toContain("decision-surface growth");
		expect(o).toContain("baseline origin/main; +3 entries");
		expect(o).toContain("pre_warn gained foo");
		expect(o).toContain("post gained bar");
	});
});

// =============================================================================
describe("streamSupermodelDeadCode", () => {
	it("does nothing when the --dead-code flag is unset", () => {
		streamSupermodelDeadCode("/repo", {}, new Set<string>());
		expect(out()).toBe("");
		expect(vi.mocked(isSupermodelCliAvailable)).not.toHaveBeenCalled();
	});

	it("prints a skip note when the CLI is absent", () => {
		vi.mocked(isSupermodelCliAvailable).mockReturnValue(false);
		streamSupermodelDeadCode("/repo", { deadCode: true }, new Set<string>());
		const o = out();
		expect(o).toContain("supermodel dead-code");
		expect(o).toContain("`supermodel` CLI not found");
		expect(vi.mocked(runSupermodelDeadCode)).not.toHaveBeenCalled();
	});

	it("prints an errored note when the analysis returns null", () => {
		vi.mocked(isSupermodelCliAvailable).mockReturnValue(true);
		vi.mocked(runSupermodelDeadCode).mockReturnValue(null);
		streamSupermodelDeadCode("/repo", { deadCode: true }, new Set<string>());
		const o = out();
		expect(o).toContain("no result");
		expect(o).toContain("API key, network, or timeout");
	});

	it("prints the clean line with the declaration count when there are no candidates", () => {
		vi.mocked(isSupermodelCliAvailable).mockReturnValue(true);
		vi.mocked(runSupermodelDeadCode).mockReturnValue({
			candidates: [],
			totalDeclarations: 42,
		});
		const flagged = new Set<string>();
		streamSupermodelDeadCode("/repo", { deadCode: true }, flagged);
		const o = out();
		expect(o).toContain("no dead code");
		expect(o).toContain("42 declarations analyzed");
		expect(flagged.size).toBe(0);
		expect(vi.mocked(formatDeadCodeFindings)).not.toHaveBeenCalled();
	});

	it("lists candidates, flags their files, and prints formatted finding lines", () => {
		vi.mocked(isSupermodelCliAvailable).mockReturnValue(true);
		vi.mocked(runSupermodelDeadCode).mockReturnValue({
			candidates: [
				{ file: "a.ts", name: "x", line: 1, confidence: "high", reason: "r1" },
				{ file: "b.ts", name: "y", line: 2, confidence: "low", reason: "r2" },
			],
			totalDeclarations: 100,
		});
		vi.mocked(formatDeadCodeFindings).mockReturnValue(["line one", "line two"]);
		const flagged = new Set<string>();
		streamSupermodelDeadCode("/repo", { deadCode: true }, flagged);
		const o = out();
		expect(o).toContain("2"); // candidate count
		expect(o).toContain("of 100 declarations");
		expect(o).toContain("line one");
		expect(o).toContain("line two");
		expect(flagged.has("a.ts")).toBe(true);
		expect(flagged.has("b.ts")).toBe(true);
		// the spinner overwrite sequence is emitted before the result
		expect(o).toContain("\r\x1b[K");
		expect(vi.mocked(formatDeadCodeFindings)).toHaveBeenCalledWith(
			expect.objectContaining({ totalDeclarations: 100 }),
			{ max: 20 },
		);
	});
});

// =============================================================================
describe("streamUndocumentedEnvVars", () => {
	it("prints the all-documented pass line and flags nothing when empty", () => {
		const flagged = new Set<string>();
		streamUndocumentedEnvVars([], flagged);
		const o = out();
		expect(o).toContain("env/config integrity");
		expect(o).toContain("all env vars documented");
		expect(flagged.size).toBe(0);
	});

	it("counts distinct env-var names and files, flagging each file (under the cap)", () => {
		const flagged = new Set<string>();
		streamUndocumentedEnvVars(
			[
				{ file: "a.ts", message: 'env var "FOO" is undocumented' },
				{ file: "b.ts", message: 'env var "BAR" is undocumented' },
				// duplicate name "FOO" in a third file -> names=2, files=3
				{ file: "c.ts", message: 'env var "FOO" is undocumented' },
			],
			flagged,
		);
		const o = out();
		expect(o).toContain("2"); // 2 distinct names (FOO, BAR)
		expect(o).toContain("undocumented env vars in");
		expect(o).toContain("3"); // 3 distinct files
		// files listed, sorted
		expect(o).toContain("a.ts");
		expect(o).toContain("b.ts");
		expect(o).toContain("c.ts");
		expect(flagged.has("a.ts")).toBe(true);
		expect(flagged.has("b.ts")).toBe(true);
		expect(flagged.has("c.ts")).toBe(true);
		expect(o).not.toContain("more files");
	});

	it("handles a message with no quoted env name (empty-string name branch)", () => {
		const flagged = new Set<string>();
		streamUndocumentedEnvVars([{ file: "a.ts", message: "no quotes here" }], flagged);
		const o = out();
		// envNames set collapses to a single "" entry -> count 1
		expect(o).toContain("1");
		expect(o).toContain("undocumented env vars in");
	});

	it("truncates the file list past the cap and prints the overflow line", () => {
		const records = Array.from({ length: 13 }, (_, i) => ({
			file: `f${String(i).padStart(2, "0")}.ts`,
			message: `env var "V${i}" is undocumented`,
		}));
		const flagged = new Set<string>();
		streamUndocumentedEnvVars(records, flagged);
		const o = out();
		// MAX_ENV_FILES = 10 -> 3 more
		expect(o).toContain("... and 3 more files");
		// first 10 (sorted) listed, the 11th-13th elided from the listing
		expect(o).toContain("f00.ts");
		expect(o).toContain("f09.ts");
		expect(o).not.toContain("f10.ts");
		// every file still flagged regardless of listing cap
		expect(flagged.size).toBe(13);
	});
});

// =============================================================================
describe("streamSuggestionsSummary", () => {
	it("prints the no-suggestions pass line for an empty map", () => {
		vi.mocked(runSuggestions).mockReturnValue(new Map());
		streamSuggestionsSummary([], "/repo");
		const o = out();
		expect(o).toContain("suggestions");
		expect(o).toContain("no suggestions");
		expect(vi.mocked(runSuggestions)).toHaveBeenCalledWith({
			files: [],
			cwd: "/repo",
			limit: 3,
			threshold: 0.5,
		});
	});

	it("totals suggestions across files and lists files sorted", () => {
		// Insert out of order to prove the localeCompare sort in the listing.
		const map: ReturnType<typeof runSuggestions> = new Map([
			["z.ts", [{ check: "silent-catch", line: 1, message: "First finding", source: "quality" }]],
			["a.ts", [{ check: "silent-catch", line: 2, message: "Second finding", source: "quality" }, { check: "silent-catch", line: 3, message: "Third finding", source: "quality" }]],
		]);
		vi.mocked(runSuggestions).mockReturnValue(map);
		streamSuggestionsSummary(["a.ts", "z.ts"], "/repo");
		const o = out();
		expect(o).toContain("scored heuristics");
		expect(o).toContain("3"); // total findings (1 + 2)
		expect(o).toContain("2"); // file count
		expect(o).toContain("a.ts");
		expect(o).toContain("z.ts");
		// a.ts must be listed before z.ts (sorted)
		expect(o.indexOf("a.ts")).toBeLessThan(o.indexOf("z.ts"));
		// the spinner clear sequence ran
		expect(o).toContain("\r\x1b[K");
	});
});
