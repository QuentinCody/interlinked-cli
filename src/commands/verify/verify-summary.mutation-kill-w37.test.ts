// ===========================================
// verify-summary — wave-37 survivor-kill suite
// ===========================================
// Targets manifest-listed survived mutants against
// src/commands/verify/verify-summary.ts. Focuses on exact call-argument and
// exact-substring assertions the existing companion suite left loose (e.g.
// asserting only aggregate counts via loose `toContain`, which let arithmetic
// and array/string-literal mutants slip through since a negative number or a
// dropped sort still "contains" the same digit).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { existsSync } from "node:fs";
import { runCaseDivergenceCheck } from "../../harness/case-divergence.js";
import { isSupermodelCliAvailable, runSupermodelDeadCode } from "../../harness/supermodel-analyses.js";
import { runSuggestions } from "./tool-results.js";
import {
	emitVerifyRun,
	streamCaseDivergence,
	streamSuggestionsSummary,
	streamSupermodelDeadCode,
	streamUndocumentedEnvVars,
} from "./verify-summary.js";

// --- stderr capture ----------------------------------------------------------
let stderrChunks: string[];
let origErr: typeof process.stderr.write;
const out = () => stderrChunks.join("");

beforeEach(() => {
	stderrChunks = [];
	origErr = process.stderr.write;
	// SAFETY: process.stderr.write's real signature has overloads (Buffer/encoding/
	// callback variants) the test double doesn't implement; only the single-arg
	// string form is ever invoked by the module under test.
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
describe("emitVerifyRun — exact git invocation args (mutation kill)", () => {
	const baseData = {
		mode: "default",
		files_scanned: 1,
		flagged_files: 0,
		project_findings: 0,
		summary: [],
		duration_ms: 1,
	};

	// test-contract: invariant — the three git subprocess calls must carry the
	// exact command/args/options the JSONL row's branch/head/dirty fields are
	// derived from; a mutated literal must fail this exact-args match even
	// though the mocked return value (and therefore the JSONL row) is unchanged.
	it("invokes git exactly 3 times with the precise commands/args/options", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(execFileSync).mockReturnValue("");
		emitVerifyRun("/repo", baseData);

		const expectedOpts = {
			cwd: "/repo",
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		};
		expect(vi.mocked(execFileSync)).toHaveBeenNthCalledWith(
			1,
			"git",
			["rev-parse", "--abbrev-ref", "HEAD"],
			expectedOpts,
		);
		expect(vi.mocked(execFileSync)).toHaveBeenNthCalledWith(2, "git", ["rev-parse", "HEAD"], expectedOpts);
		expect(vi.mocked(execFileSync)).toHaveBeenNthCalledWith(3, "git", ["status", "--porcelain"], expectedOpts);
	});
});

// =============================================================================
describe("streamCaseDivergence — loc/more branch exactness (mutation kill)", () => {
	// test-contract: boundary — a spelling with zero locs must be skipped
	// silently (falsy `loc`), not crash on `loc.file` — pins the `if (loc)`
	// guard against a `true`-forcing mutant.
	it("skips the location line (and never throws) when a spelling has no locs", () => {
		vi.mocked(runCaseDivergenceCheck).mockReturnValue([
			{
				core: "x",
				role: "value",
				message: "msg-x",
				files: ["a.ts"],
				// SAFETY: only the fields streamCaseDivergence reads (name/style/locs,
				// message, files) are populated; the full CaseDivergenceFinding shape
				// is irrelevant to this branch.
				spellings: [{ name: "onlyGhost", style: "camelCase", locs: [] }],
			},
		]);
		const flagged = new Set<string>();
		expect(() => streamCaseDivergence("/repo", ["a.ts"], flagged)).not.toThrow();
		const o = out();
		expect(o).toContain("msg-x");
		expect(o).not.toContain("onlyGhost —");
	});

	// test-contract: boundary — exactly one loc must render with NO
	// "(+N more)" suffix at all, pinning both the `> 1` operator (not `>= 1`)
	// and the empty-string false-branch literal in the same ternary.
	it("prints the location line with no more-suffix at all when exactly one loc exists", () => {
		vi.mocked(runCaseDivergenceCheck).mockReturnValue([
			{
				core: "y",
				role: "value",
				message: "msg-y",
				files: ["b.ts"],
				spellings: [{ name: "solo", style: "snake_case", locs: [{ file: "b.ts", line: 5, kind: "const" }] }],
			},
		]);
		streamCaseDivergence("/repo", ["b.ts"], new Set());
		const o = out();
		expect(o).toContain("solo — b.ts:5 (snake_case)\x1b[0m\n");
		expect(o).not.toContain("more)");
	});
});

// =============================================================================
describe("streamSupermodelDeadCode — spinner text present (mutation kill)", () => {
	// test-contract: public-api — the in-progress spinner text is part of the
	// observable stderr stream (captured verbatim by the test double, unlike a
	// real TTY where `\r\x1b[K` would erase it), pinning the literal against an
	// empty-string mutant.
	it("writes the running-analysis spinner text before the result", () => {
		vi.mocked(isSupermodelCliAvailable).mockReturnValue(true);
		vi.mocked(runSupermodelDeadCode).mockReturnValue({ candidates: [], totalDeclarations: 1 });
		streamSupermodelDeadCode("/repo", { deadCode: true }, new Set());
		expect(out()).toContain("running cloud analysis...");
	});
});

// =============================================================================
describe("streamUndocumentedEnvVars — sort/boundary/regex exactness (mutation kill)", () => {
	// test-contract: invariant — the listed files must render in sorted order
	// regardless of input order, pinning `.sort()` against a no-op mutant.
	it("sorts the listed files even when the input arrives out of order", () => {
		const flagged = new Set<string>();
		streamUndocumentedEnvVars(
			[
				{ file: "c.ts", message: 'env var "C" is undocumented' },
				{ file: "a.ts", message: 'env var "A" is undocumented' },
				{ file: "b.ts", message: 'env var "B" is undocumented' },
			],
			flagged,
		);
		const o = out();
		expect(o.indexOf("a.ts")).toBeLessThan(o.indexOf("b.ts"));
		expect(o.indexOf("b.ts")).toBeLessThan(o.indexOf("c.ts"));
	});

	// test-contract: boundary — exactly MAX_ENV_FILES (10) files must NOT
	// trigger the overflow line, pinning `>` against a `>=` mutant.
	it("does not print the overflow line when file count exactly equals the cap (10)", () => {
		const records = Array.from({ length: 10 }, (_, i) => ({
			file: `g${i}.ts`,
			message: `env var "G${i}" is undocumented`,
		}));
		streamUndocumentedEnvVars(records, new Set());
		expect(out()).not.toContain("more files");
	});

	// test-contract: invariant — two distinct multi-character quoted names
	// must count as 2 distinct env vars, pinning the capture-group regex (not
	// a single-char or quote-only class) and the map-callback body (not an
	// empty block that collapses every entry to `undefined`).
	it("extracts full multi-character quoted names distinctly, not collapsed to one value", () => {
		const flagged = new Set<string>();
		streamUndocumentedEnvVars(
			[
				{ file: "x.ts", message: 'env var "ALPHA" is undocumented' },
				{ file: "y.ts", message: 'env var "BETA" is undocumented' },
			],
			flagged,
		);
		const o = out();
		const m = o.match(/\x1b\[33m(\d+)\x1b\[0m undocumented env vars/);
		expect(m).not.toBeNull();
		expect(m?.[1]).toBe("2");
	});
});

// =============================================================================
describe("streamSuggestionsSummary — spinner + empty-header literals (mutation kill)", () => {
	// test-contract: public-api — the scoring-in-progress spinner text is part
	// of the observable stderr stream, pinning the literal against an
	// empty-string mutant (same reasoning as the supermodel spinner above).
	it("writes the scoring-suggestions spinner text before the result", () => {
		vi.mocked(runSuggestions).mockReturnValue(new Map());
		streamSuggestionsSummary([], "/repo");
		expect(out()).toContain("scoring suggestions...");
	});

	// test-contract: public-api — the empty-map "suggestions" section header
	// must render as its own line, not collapse to "". A loose
	// `toContain("suggestions")` would still pass on the mutant because the
	// following "no suggestions" line also contains that substring, so this
	// pins the exact multi-line literal instead.
	it("renders the suggestions section header literally for an empty map", () => {
		vi.mocked(runSuggestions).mockReturnValue(new Map());
		streamSuggestionsSummary([], "/repo");
		expect(out()).toContain("\n  \x1b[1msuggestions\x1b[0m\n");
	});
});

// =============================================================================
describe("streamSuggestionsSummary — total accumulation exactness (mutation kill)", () => {
	// test-contract: invariant — the printed total must be the sum (3), not
	// the difference (-3), of per-file suggestion counts; a loose `toContain`
	// on "3" alone would also match "-3", so this asserts the exact captured
	// digit group.
	it("adds (not subtracts) per-file suggestion counts into the total", () => {
		const map = new Map<string, Array<{ id: string }>>([
			["z.ts", [{ id: "1" }]],
			["a.ts", [{ id: "2" }, { id: "3" }]],
		]);
		// SAFETY: runSuggestions' real return type carries richer Suggestion
		// objects; only `.length` of each file's array is read by the SUT.
		vi.mocked(runSuggestions).mockReturnValue(map as never);
		streamSuggestionsSummary(["a.ts", "z.ts"], "/repo");
		const o = out();
		const m = o.match(/\x1b\[36m(-?\d+)\x1b\[0m suggestions in/);
		expect(m).not.toBeNull();
		expect(m?.[1]).toBe("3");
	});
});
