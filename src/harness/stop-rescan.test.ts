// Tests for the Stop-event deterministic pattern rescan.
//
// These are BEHAVIORAL tests against the public surface of `stop-rescan.ts`
// (`rescanSessionFiles` + `buildPatternRescanWarnings`). The three module
// boundaries the rescan depends on — `node:fs` (file read), the check
// registry (`buildAgentSafetyChecks`), and `suppressions`
// (`scanInlineDeferrals`) — are mocked so every branch (including the
// best-effort error swallows that real detectors never hit) is reachable
// deterministically.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAgentSafetyChecks } from "./check-registry/index.js";
import type { InlineMatch } from "./check-registry/types.js";
import {
	buildPatternRescanWarnings,
	type PatternRescanFinding,
	rescanSessionFiles,
} from "./stop-rescan.js";
import { scanInlineDeferrals } from "./suppressions.js";
import type { SessionTrajectory } from "./types.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
vi.mock("./check-registry/index.js", () => ({ buildAgentSafetyChecks: vi.fn() }));
vi.mock("./suppressions.js", () => ({ scanInlineDeferrals: vi.fn() }));

const mockReadFileSync = vi.mocked(readFileSync);
const mockBuildChecks = vi.mocked(buildAgentSafetyChecks);
const mockScanDeferrals = vi.mocked(scanInlineDeferrals);

/** Static ISO timestamp — the rescan code never reads `started_at`, so a
 *  fixed value keeps date generation out of determinism entirely. */
const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

function makeSession(filesWritten: string[]): SessionTrajectory {
	// SessionTrajectory has many required fields; build a minimal shape with
	// just `files_written`, the only field the rescan reads.
	return {
		session_id: "test-session",
		agent_source: "claude",
		agent_name: "tester",
		started_at: FIXED_TIMESTAMP,
		tdd_cycles: [],
		assertion_counts: new Map<string, number>(),
		files_written: new Set(filesWritten),
		commands_run: [],
		active_skills: new Map<string, unknown>(),
		verification_observed: new Set<string>(),
		stubs_introduced: [],
		fired_reminders: new Set<string>(),
		non_doc_files_edited_since_commit: new Set<string>(),
		doc_files_edited_since_commit: 0,
		stop_nudge_emitted: false,
	} as unknown as SessionTrajectory;
}

/** A single mocked detector returning a fixed match list. */
function detector(
	name: string,
	matches: InlineMatch[],
): { name: string; severity: "error" | "warning"; fn: () => InlineMatch[] } {
	return { name, severity: "warning", fn: () => matches };
}

/** A detector whose `fn()` throws — exercises the per-check try/catch. */
function throwingDetector(name: string): {
	name: string;
	severity: "error" | "warning";
	fn: () => InlineMatch[];
} {
	return {
		name,
		severity: "warning",
		fn: () => {
			throw new Error(`detector ${name} exploded`);
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// Default happy path: file reads succeed, no deferrals, no detectors.
	// Individual tests override per-case.
	mockReadFileSync.mockReturnValue("file body\n");
	mockScanDeferrals.mockReturnValue(new Map());
	mockBuildChecks.mockReturnValue([]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("rescanSessionFiles", () => {
	it("returns an empty array when no files were written", () => {
		const out = rescanSessionFiles(makeSession([]), "/repo");
		expect(out).toEqual([]);
		expect(mockReadFileSync).not.toHaveBeenCalled();
	});

	it("reads each written file relative to the resolved cwd and runs detectors", () => {
		mockBuildChecks.mockReturnValue([
			detector("ubs_pickle_untrusted_load", [{ line: 2, text: "pickle.load(f)" }]),
		]);
		const findings = rescanSessionFiles(makeSession(["src/a.py"]), "/repo");
		expect(mockReadFileSync).toHaveBeenCalledWith("/repo/src/a.py", "utf-8");
		expect(findings).toEqual<PatternRescanFinding[]>([
			{
				file: "src/a.py",
				checkId: "ubs_pickle_untrusted_load",
				line: 2,
				text: "pickle.load(f)",
				deferred: false,
				deferReason: null,
			},
		]);
	});

	it("keeps an already-absolute path as-is rather than re-resolving it", () => {
		mockBuildChecks.mockReturnValue([detector("c", [{ line: 1, text: "x" }])]);
		const findings = rescanSessionFiles(makeSession(["/abs/elsewhere/file.ts"]), "/repo");
		expect(mockReadFileSync).toHaveBeenCalledWith("/abs/elsewhere/file.ts", "utf-8");
		// `relative("/repo", "/abs/elsewhere/file.ts")` is a non-empty `../`
		// path, so it is used verbatim as the reported `file`.
		expect(findings[0]?.file).toBe("../abs/elsewhere/file.ts");
	});

	it("de-duplicates when the same file appears as both absolute and relative", () => {
		mockBuildChecks.mockReturnValue([detector("c", [{ line: 1, text: "x" }])]);
		const findings = rescanSessionFiles(
			makeSession(["/repo/dup.py", "dup.py"]),
			"/repo",
		);
		expect(mockReadFileSync).toHaveBeenCalledTimes(1);
		expect(findings).toHaveLength(1);
	});

	it("falls back to the absolute path when relative() returns empty (file IS cwd)", () => {
		mockBuildChecks.mockReturnValue([detector("c", [{ line: 1, text: "x" }])]);
		// `relative("/repo", "/repo")` === "" → the `|| absPath` fallback fires.
		const findings = rescanSessionFiles(makeSession(["/repo"]), "/repo");
		expect(findings[0]?.file).toBe("/repo");
	});

	it("silently skips a file whose read throws (deleted / permission denied)", () => {
		mockReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		const findings = rescanSessionFiles(makeSession(["gone.py"]), "/repo");
		expect(findings).toEqual([]);
		// A read failure must not call the detector builder for that file.
		expect(mockBuildChecks).not.toHaveBeenCalled();
	});

	it("continues past a detector whose fn() throws, still collecting other findings", () => {
		mockBuildChecks.mockReturnValue([
			throwingDetector("boom"),
			detector("survivor", [{ line: 5, text: "still here" }]),
		]);
		const findings = rescanSessionFiles(makeSession(["x.ts"]), "/repo");
		expect(findings.map((f) => f.checkId)).toEqual(["survivor"]);
		expect(findings[0]?.line).toBe(5);
	});

	it("annotates a match as deferred with a reason when the line has a marker", () => {
		mockScanDeferrals.mockReturnValue(
			new Map([[2, new Map([["eval_usage", "sandboxed by callers"]])]]),
		);
		mockBuildChecks.mockReturnValue([
			detector("eval_usage", [{ line: 2, text: "eval(code)" }]),
		]);
		const findings = rescanSessionFiles(makeSession(["x.ts"]), "/repo");
		expect(findings[0]).toMatchObject({
			checkId: "eval_usage",
			deferred: true,
			deferReason: "sandboxed by callers",
		});
	});

	it("marks deferred true with a null reason when the marker carries no justification", () => {
		mockScanDeferrals.mockReturnValue(
			new Map<number, Map<string, string | null>>([[3, new Map([["eval_usage", null]])]]),
		);
		mockBuildChecks.mockReturnValue([
			detector("eval_usage", [{ line: 3, text: "eval(code)" }]),
		]);
		const findings = rescanSessionFiles(makeSession(["x.ts"]), "/repo");
		expect(findings[0]?.deferred).toBe(true);
		expect(findings[0]?.deferReason).toBeNull();
	});

	it("leaves deferred=false when the line has deferrals but not for THIS check", () => {
		// Line 2 defers a *different* check id — this check is still live.
		mockScanDeferrals.mockReturnValue(
			new Map([[2, new Map([["some_other_check", "reason"]])]]),
		);
		mockBuildChecks.mockReturnValue([
			detector("eval_usage", [{ line: 2, text: "eval(code)" }]),
		]);
		const findings = rescanSessionFiles(makeSession(["x.ts"]), "/repo");
		expect(findings[0]?.deferred).toBe(false);
		expect(findings[0]?.deferReason).toBeNull();
	});

	it("emits one finding per match across multiple matches and checks", () => {
		mockBuildChecks.mockReturnValue([
			detector("c1", [
				{ line: 1, text: "a" },
				{ line: 2, text: "b" },
			]),
			detector("c2", [{ line: 3, text: "c" }]),
		]);
		const findings = rescanSessionFiles(makeSession(["x.ts"]), "/repo");
		expect(findings).toHaveLength(3);
		expect(findings.map((f) => `${f.checkId}:${f.line}`)).toEqual([
			"c1:1",
			"c1:2",
			"c2:3",
		]);
	});
});

// The rescan SCAN is unchanged; its REPORT now runs through
// `stop-rescan-report.ts` (2026-08-16). Per-file blocks are collapsed into one
// digest warning, findings are filtered to introduced-only, and subagent-owned
// files leave the main list. `dryRun: true` keeps these unit tests off disk;
// the state/spool behavior has its own suite in stop-digest-state.test.ts.
describe("buildPatternRescanWarnings — positive (must fire)", () => {
	function warn(session: SessionTrajectory): string[] {
		return buildPatternRescanWarnings(session, "/repo", {
			dryRun: true,
			interlinkedDir: "/repo/.interlinked",
		});
	}

	it("P1: emits ONE digest block naming the file and each introduced finding", () => {
		mockBuildChecks.mockReturnValue([
			detector("eval_usage", [
				{ line: 4, text: "eval(a)" },
				{ line: 9, text: "eval(b)" },
			]),
		]);
		const warnings = warn(makeSession(["x.ts"]));
		expect(warnings).toHaveLength(1);
		const w = warnings[0] ?? "";
		expect(w).toContain("[interlinked:stop-rescan] 1 file(s) you touched");
		expect(w).toContain("x.ts — 2 introduced finding(s)");
		expect(w).toContain("eval_usage:4 — eval(a)");
		expect(w).toContain("// interlinked: defer <check-id>");
	});

	it("P2: collapses an all-deferred file to a single acknowledged count line", () => {
		mockScanDeferrals.mockReturnValue(
			new Map([[4, new Map([["eval_usage", "intentional"]])]]),
		);
		mockBuildChecks.mockReturnValue([detector("eval_usage", [{ line: 4, text: "eval(a)" }])]);
		const w = warn(makeSession(["x.ts"])).join(String.fromCharCode(10));
		expect(w).toContain("1 acknowledged-deferred finding(s)");
		expect(w).not.toContain("eval_usage:4");
	});

	it("P3: keeps one block per file when two files carry findings", () => {
		mockBuildChecks.mockReturnValue([
			detector("c", [
				{ line: 1, text: "m1" },
				{ line: 2, text: "m2" },
			]),
		]);
		const w = warn(makeSession(["a.ts", "b.ts"])).join(String.fromCharCode(10));
		expect(w).toContain("a.ts — 2 introduced finding(s)");
		expect(w).toContain("b.ts — 2 introduced finding(s)");
	});

	it("P4: lists live findings and counts deferred ones in the same file block", () => {
		mockScanDeferrals.mockReturnValue(new Map([[7, new Map([["eval_usage", "ack"]])]]));
		mockBuildChecks.mockReturnValue([
			detector("eval_usage", [
				{ line: 4, text: "eval(live)" },
				{ line: 7, text: "eval(deferred)" },
			]),
		]);
		const w = warn(makeSession(["x.ts"])).join(String.fromCharCode(10));
		expect(w).toContain("eval_usage:4 — eval(live)");
		expect(w).toContain("(1 acknowledged-deferred, not escalated)");
	});
});

describe("buildPatternRescanWarnings — negative (must not fire)", () => {
	it("N1: returns an empty array when the rescan produces no findings", () => {
		mockBuildChecks.mockReturnValue([]);
		expect(
			buildPatternRescanWarnings(makeSession(["x.ts"]), "/repo", { dryRun: true }),
		).toEqual([]);
	});

	it("N2: drops a finding the git baseline already carried", () => {
		mockBuildChecks.mockReturnValue([detector("eval_usage", [{ line: 4, text: "eval(a)" }])]);
		const session = makeSession(["x.ts"]);
		// The introduced-only filter needs a session-start anchor; without a HEAD
		// sha the detector deliberately has no baseline and everything is new.
		session.git_session_baseline = {
			head_sha: "abc123",
			modified: new Set<string>(),
			staged: new Set<string>(),
			untracked: new Set<string>(),
		};
		const warnings = buildPatternRescanWarnings(
			session,
			"/repo",
			// A session baseline exists AND the baseline file content produces the
			// same finding, so nothing was introduced this session.
			{ dryRun: true, interlinkedDir: "/repo/.interlinked", gitShow: () => "file body" },
		);
		expect(warnings).toEqual([]);
	});

	it("N3: moves a subagent-owned file out of the main list into one summary line", () => {
		mockBuildChecks.mockReturnValue([detector("eval_usage", [{ line: 4, text: "eval(a)" }])]);
		const w = buildPatternRescanWarnings(makeSession(["x.ts"]), "/repo", {
			dryRun: true,
			interlinkedDir: "/repo/.interlinked",
			attribution: { byFile: new Map([["x.ts", ["agentA"]]]), agents: new Set(["agentA"]) },
		}).join(String.fromCharCode(10));
		expect(w).toContain("touched by 1 subagent(s)");
		expect(w).not.toContain("eval_usage:4");
	});
});

// The two cases below deliberately do NOT pass `opts.gitShow` — every other
// test in this file injects a fake reader, which means the module's own
// `gitShowFile` (a real `git show <sha>:<path>` shell-out) was never
// exercised. `node:child_process` is unmocked in this file, so these run a
// real git command against this repo's own history.
describe("buildPatternRescanWarnings — real gitShowFile (no injected reader)", () => {
	const REPO_ROOT = process.cwd();

	function realHeadSha(): string {
		return execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
	}

	it("P5: a successful real `git show` at HEAD drops a finding the committed content already carries", () => {
		mockBuildChecks.mockReturnValue([detector("eval_usage", [{ line: 4, text: "eval(a)" }])]);
		const session = makeSession(["package.json"]);
		session.git_session_baseline = {
			head_sha: realHeadSha(),
			modified: new Set<string>(),
			staged: new Set<string>(),
			untracked: new Set<string>(),
		};
		const warnings = buildPatternRescanWarnings(session, REPO_ROOT, {
			dryRun: true,
			interlinkedDir: join(REPO_ROOT, ".interlinked"),
		});
		// The mocked detector returns the identical fixed match regardless of
		// content, for both the current scan and the baseline scan — so this
		// is empty only because the real `git show` succeeded (non-null) and
		// fed scanContentFindings a baseline that produced the same finding.
		expect(warnings).toEqual([]);
	});

	it("N4: a real `git show` failure (nonexistent ref) degrades to no-baseline — the finding stays introduced", () => {
		mockBuildChecks.mockReturnValue([detector("eval_usage", [{ line: 4, text: "eval(a)" }])]);
		const session = makeSession(["package.json"]);
		session.git_session_baseline = {
			// Syntactically a valid sha, but does not exist in this repo.
			head_sha: "0".repeat(40),
			modified: new Set<string>(),
			staged: new Set<string>(),
			untracked: new Set<string>(),
		};
		const warnings = buildPatternRescanWarnings(session, REPO_ROOT, {
			dryRun: true,
			interlinkedDir: join(REPO_ROOT, ".interlinked"),
		}).join(String.fromCharCode(10));
		expect(warnings).toContain("eval_usage:4 — eval(a)");
	});
});
