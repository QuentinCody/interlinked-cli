// Mutation-hardening tests for `./post-tool-file-checks-phases-quality.js`.
// Each test kills a survivor of the single-change mutants run against the
// existing `post-tool-file-checks-phases-quality.test.ts` (Campaign A, 2026-10-21).
// Mock layout mirrors the existing test so collaborators stay deterministic.
//
// Basis for exact-value pins: the existing test file's header states that its
// assertions use exact values (`toEqual` / `toBe` / `toHaveBeenCalledWith`),
// and the module's own doc comments (lines 81-86, 150-155, 205-206, 237-241)
// describe the compact one-line deferral output, the advisory sibling fan-out
// and the determinism fallback order that these tests exercise.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QualityCheckResult } from "../quality-checks/result-types.js";
import type { GuardRulesConfig, HarnessDecision } from "../types.js";
import { makeServerRules, makeServerRuntime } from "./__tests__/fixtures.js";
import { buildTestIndex } from "../__tests__/fixtures/trigram.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import type { ServerRuntime } from "./runtime-context.js";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
}));

vi.mock("../check-metadata.js", () => ({
	QUALITY_CHECK_META: {
		check_a: { name: "t", description: "t", tier: 1, determinism: "fully_deterministic" },
	},
	GENERIC_CHECK_META: {},
}));

vi.mock("../quality-checks.js", () => ({
	classifyDeterminism: vi.fn(() => "proven"),
	formatQualityWarnings: vi.fn(() => []),
	findProjectRoot: vi.fn((_f: string, cwd: string) => cwd),
}));

vi.mock("../session-state.js", () => ({
	isAcknowledged: vi.fn(() => false),
}));

vi.mock("../sibling-expansion.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../sibling-expansion.js")>()),
	expandSiblings: vi.fn(() => []),
}));

vi.mock("../suggestion-scorer.js", () => ({
	formatScoredFindings: vi.fn(() => []),
	scoreFindings: vi.fn(() => []),
	writeTelemetry: vi.fn(),
}));

vi.mock("../suppressions.js", () => ({
	loadFileSuppressions: vi.fn(() => new Set<string>()),
	scanInlineSuppressions: vi.fn(() => []),
}));

vi.mock("./deletion-hygiene-diff.js", () => ({
	collectDeletionHygieneDiffFindings: vi.fn(() => []),
}));

vi.mock("./suggestion-checks.js", () => ({
	collectSuggestionFindings: vi.fn(() => []),
}));

import { classifyDeterminism, findProjectRoot, formatQualityWarnings } from "../quality-checks.js";
import { expandSiblings } from "../sibling-expansion.js";
import {
	applyQualityDecision,
	buildSmartTscOpts,
	collectQualityResultEntries,
	expandQualitySiblings,
	formatQualityDecisionWarnings,
} from "./post-tool-file-checks-phases-quality.js";

const mClassify = vi.mocked(classifyDeterminism);
const mFormatQuality = vi.mocked(formatQualityWarnings);
const mFindProjectRoot = vi.mocked(findProjectRoot);
const mExpandSiblings = vi.mocked(expandSiblings);

const CWD = "/repo";
const FILE = "/repo/src/mod.ts";

function qr(over: Partial<QualityCheckResult> = {}): QualityCheckResult {
	return { name: "check", severity: "warning", message: "m", ...over };
}

function makeCtx(over: NonNullable<Parameters<typeof makeServerRuntime>[0]> = {}): ServerRuntime {
	return makeServerRuntime({
		cwd: CWD,
		interlinkedDir: `${CWD}/.interlinked`,
		rules: makeServerRules(),
		trigramIndex: null,
		log: vi.fn(),
		...over,
	});
}

function deferred(over: Partial<QualityCheckResult> = {}): QualityCheckResult {
	return qr({ name: "external_check_deferred", message: "External check deferred (tsc)", file: FILE, ...over });
}

beforeEach(() => {
	vi.resetAllMocks();
	mClassify.mockReturnValue("proven");
	mFormatQuality.mockImplementation((rs: { name: string }[]) => rs.map((r) => `[q] ${r.name}`));
	mFindProjectRoot.mockImplementation((_f: string, cwd: string) => cwd);
	mExpandSiblings.mockReturnValue([]);
});

describe("formatQualityDecisionWarnings — deferral compaction", () => {
	// m05: the boilerplate prefix is stripped whether or not punctuation follows it.
	it("strips the 'No check verdict was produced' prefix even without trailing punctuation", () => {
		const [line] = formatQualityDecisionWarnings([
			deferred({ detail: "No check verdict was produced busy worker" }),
		]);
		expect(line).toContain("(busy worker)");
		expect(line).not.toContain("verdict was produced");
	});

	// m09: with neither detail nor a parenthesised suffix, the reason is never empty.
	it("never renders an empty reason when the deferral carries no detail or suffix", () => {
		const [line] = formatQualityDecisionWarnings([
			qr({ name: "external_check_deferred", message: "External check deferred", file: FILE }),
		]);
		expect(line).not.toContain("()");
		expect(line).toMatch(/\([^()]+\)\. Retry/);
	});

	// m12: a pre-existing result is reported verbatim once and never also compacted/formatted.
	it("emits a pre-existing deferral only as its plain line, not also as a compact deferral", () => {
		const warnings = formatQualityDecisionWarnings([
			qr({ name: "external_check_deferred", message: "old deferral", file: FILE, novelty: "pre-existing" }),
		]);
		expect(warnings).toEqual(["[interlinked:external_check_deferred] old deferral"]);
	});

	it("emits a pre-existing non-deferral without calling the generic formatter", () => {
		const warnings = formatQualityDecisionWarnings([
			qr({ name: "lint_x", message: "old lint", novelty: "pre-existing" }),
		]);
		expect(warnings).toEqual(["[interlinked:lint_x] old lint"]);
		expect(mFormatQuality).not.toHaveBeenCalled();
	});

	// m16: two deferrals of the same check on one file list that check once.
	it("lists a repeated check label once for one file", () => {
		const [line] = formatQualityDecisionWarnings([
			deferred({ detail: "busy one" }),
			deferred({ detail: "busy two" }),
		]);
		expect(line).toContain("NOT CHECKED: tsc for /repo/src/mod.ts");
		expect(line).not.toContain("tsc, tsc");
	});

	// m19: the reason text is capped at 600 characters (module line 115).
	it("truncates the joined reason text to exactly 600 characters", () => {
		const [line] = formatQualityDecisionWarnings([deferred({ detail: "x".repeat(700) })]);
		const reason = /\((x+)\)\. Retry/.exec(line ?? "")?.[1];
		expect(reason?.length).toBe(600);
	});

	// m21: distinct reasons for one file are joined with "; " (module line 115).
	it("joins distinct reasons of one file with a semicolon and space", () => {
		const [line] = formatQualityDecisionWarnings([
			deferred({ message: "External check deferred (tsc)", detail: "reason-a" }),
			deferred({ message: "External check deferred (biome)", detail: "reason-b" }),
		]);
		expect(line).toContain("(reason-a; reason-b)");
	});
});

describe("buildSmartTscOpts — project root fallback", () => {
	// m26: with no discoverable project root the filter path is relative to ctx.cwd.
	it("falls back to ctx.cwd when no project root is found", () => {
		mFindProjectRoot.mockReturnValue("");
		const ctx = makeCtx({
			rules: makeServerRules({ quality_checks: { typescript: { enabled: true, file_types: [".ts"] } } }),
		});
		const structural: GuardRulesConfig["structural_checks"] = { ...makeServerRules().structural_checks, smart_tsc: true };
		expect(buildSmartTscOpts(ctx, structural, FILE, false)).toEqual({ tscFilterFile: "src/mod.ts" });
	});
});

describe("expandQualitySiblings — trigger file and failures", () => {
	// m29: a trigger result without a file is attributed to the edited file.
	it("attributes a file-less trigger result to the edited file", () => {
		const ctx = makeCtx({ trigramIndex: buildTestIndex({}) });
		expandQualitySiblings(ctx, FILE, [qr({ name: "as_any_ratchet" })]);
		const args = mExpandSiblings.mock.calls[0]?.[0];
		expect(args?.triggers).toEqual([{ name: "as_any_ratchet", file: FILE }]);
	});

	// m32: an Error thrown by fan-out is logged by message, never thrown (module doc: advisory, logged only).
	it("logs the message of an Error thrown by sibling expansion and does not throw", () => {
		mExpandSiblings.mockImplementation(() => {
			throw new Error("boom");
		});
		const ctx = makeCtx({ trigramIndex: buildTestIndex({}) });
		const results = [qr({ name: "as_any_ratchet", file: FILE })];
		expect(() => expandQualitySiblings(ctx, FILE, results)).not.toThrow();
		expect(ctx.log).toHaveBeenCalledWith("Sibling expansion failed: boom");
		expect(results).toHaveLength(1);
	});
});

describe("collectQualityResultEntries — determinism fallback", () => {
	// m34: unregistered ids resolve to the classifier's verdict (module doc lines 227-231).
	it("records heuristic for an unregistered check the classifier calls heuristic", () => {
		mClassify.mockReturnValue("heuristic");
		const out: PerFileCheckCtx["allCheckResults"] = [];
		collectQualityResultEntries([qr({ name: "unregistered_x" })], out);
		expect(out[0]?.determinism).toBe("heuristic");
	});

	it("records fully_deterministic for an unregistered check the classifier does not call heuristic", () => {
		mClassify.mockReturnValue("proven");
		const out: PerFileCheckCtx["allCheckResults"] = [];
		collectQualityResultEntries([qr({ name: "unregistered_y" })], out);
		expect(out[0]?.determinism).toBe("fully_deterministic");
	});
});

describe("applyQualityDecision — preset rule id", () => {
	// m38: a rule_id already on the decision is kept when a blocking result arrives.
	it("keeps a rule_id that the decision already carries", () => {
		const decision: HarnessDecision = { decision: "allow", rule_id: "earlier_rule" };
		applyQualityDecision(makeCtx(), [qr({ name: "check_a", severity: "error" })], decision);
		expect(decision.decision).toBe("block");
		expect(decision.rule_id).toBe("earlier_rule");
	});
});
