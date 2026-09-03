/**
 * Quality-family sequence detectors. Stop-phase (mostly) and pre_warn
 * (two) detectors that surface coverage / doc-drift / refactor-hygiene /
 * plan-adherence shapes the per-file checks can't see. Per the design
 * docs (`trajectory-sequence-detectors.md` §3.16–§3.23), these are
 * dual-use proof — same trajectory primitive, two consumer families
 * (security + quality).
 *
 * Detectors exported from this file (each pairs with a design-doc section):
 *   §3.16 signatureChangeCallersNotUpdated (stop)
 *   §3.17 regressionTestMissingAfterFix (stop)
 *   §3.18 magicLiteralCrossFileProliferation (stop)
 *   §3.19 staleDocSibling (stop, advisory)
 *   §3.20 coverageSilentRegression (stop)
 *   §3.21 addThenRevertLoop (pre_warn)
 *   §3.22 unusedHelperIntroduced (stop)
 *   §3.23 planVsTrajectoryDriftQuality (pre_warn)
 */

import { existsSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import type { TaintProvenance } from "../types.js";
import { planHintsContainTool } from "./candidate-helpers.js";
import { addThenRevertLoop } from "./quality-revert-loop.js";
import type { SequenceDetector, SequenceMatch } from "./types.js";

/** Source-file shape — we only fire test-coverage / doc-drift detectors
 *  on files that look like first-party source code, not config / lockfiles. */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".rb",
	".java",
]);

function isSourceFile(filePath: string): boolean {
	return SOURCE_EXTENSIONS.has(extname(filePath));
}

/** Tool names that produce a file edit on disk. Extracted as a named constant
 *  so the conditional in `staleDocSibling` reads as intent rather than a
 *  string-equality wall. */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit"]);

function isTestFilePath(filePath: string): boolean {
	const name = basename(filePath);
	return (
		/\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|py)$/.test(name) ||
		/(?:^|\/)__tests__\//.test(filePath) ||
		/_test\.(?:py|go)$/.test(name)
	);
}

/** Test-file paths that pair with a source file. For `src/foo.ts` returns
 *  `src/foo.test.ts` / `src/foo.spec.ts` / `src/__tests__/foo.test.ts`. */
function candidateTestPaths(sourceFile: string): string[] {
	const dir = dirname(sourceFile);
	const ext = extname(sourceFile);
	const stem = basename(sourceFile, ext);
	const paths: string[] = [
		join(dir, `${stem}.test${ext}`),
		join(dir, `${stem}.spec${ext}`),
		join(dir, "__tests__", `${stem}.test${ext}`),
		join(dir, "__tests__", `${stem}.spec${ext}`),
	];
	return paths;
}

// ============================================================
// §3.16 signature_change_callers_not_updated
// ============================================================

/**
 * Fires when the session has pending_completions whose `affected_files`
 * have not been visited (read or edited) this session. The session-state
 * tracker populates pending_completions on export-surface changes and
 * resolves entries when affected files are read/written; this detector
 * asks "at end-of-turn, any unresolved entries left?"
 */
export const signatureChangeCallersNotUpdated: SequenceDetector = {
	id: "signature_change_callers_not_updated",
	description:
		"Exported signature changed, but callers were not visited this session",
	family: "quality",
	phase: "stop",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory) => {
		const matches: SequenceMatch[] = [];
		for (const [sourceFile, completion] of trajectory.pending_completions) {
			if (completion.affected_files.length === 0) continue;
			const unresolved = completion.affected_files.filter(
				(f) => !completion.resolved_files.has(f),
			);
			if (unresolved.length === 0) continue;
			matches.push({
				prior_event_count: 1,
				prior_summary: `signature changed in ${sourceFile}`,
				message:
					`${sourceFile} changed its exported signature, but ${unresolved.length} caller file(s) ` +
					`were not read or edited this session: ${unresolved.slice(0, 3).join(", ")}` +
					(unresolved.length > 3 ? ` (+${unresolved.length - 3} more)` : "") +
					". Visit each caller to confirm the change still compiles end-to-end.",
				evidence: unresolved.slice(0, 3),
			});
		}
		return matches;
	},
};

// ============================================================
// §3.17 regression_test_missing_after_fix
// ============================================================

/**
 * Fires when a source file appears in `failed_files` (i.e., some check
 * failed earlier this session) AND the file was subsequently edited AND
 * no sibling test file was edited / created this session.
 */
export const regressionTestMissingAfterFix: SequenceDetector = {
	id: "regression_test_missing_after_fix",
	description:
		"Failure-then-edit pattern with no sibling test file written or edited",
	family: "quality",
	phase: "stop",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory) => {
		const matches: SequenceMatch[] = [];
		for (const [filePath] of trajectory.failed_files) {
			if (!isSourceFile(filePath)) continue;
			if (!trajectory.files_written.has(filePath)) continue;
			const testPaths = candidateTestPaths(filePath);
			const anyTestTouched = testPaths.some(
				(p) => trajectory.files_written.has(p) || trajectory.files_read.has(p),
			);
			if (anyTestTouched) continue;
			matches.push({
				prior_event_count: 2,
				prior_summary: `${filePath} failed checks earlier, then was edited`,
				message:
					`${filePath} had earlier check failures and was edited this session, but no ` +
					`sibling test file (${basename(testPaths[0] ?? "")}) was added or updated. ` +
					"Add a regression test that exercises the fixed code path.",
				evidence: [filePath],
			});
		}
		return matches;
	},
};

// ============================================================
// §3.19 stale_doc_sibling (advisory)
// ============================================================

/**
 * Fires when an edit lands on a source file that has a sibling doc file
 * (docs/<stem>.md, README.md in the same dir, or <stem>.d.ts), and the
 * sibling was neither read nor edited this session.
 */
export const staleDocSibling: SequenceDetector = {
	id: "stale_doc_sibling",
	description: "Source edited but sibling doc not touched",
	family: "quality",
	phase: "stop",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory, candidate) => {
		const toolName = candidate.tool_name || "";
		if (!EDIT_TOOL_NAMES.has(toolName)) {
			return [];
		}
		const filePath = (candidate.tool_input?.file_path as string) || "";
		if (!filePath || !isSourceFile(filePath)) return [];
		const cwd = candidate.cwd || process.cwd();
		const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
		const dir = dirname(abs);
		const ext = extname(abs);
		const stem = basename(abs, ext);
		const candidates = [
			join(dir, "..", "docs", `${stem}.md`),
			join(dirname(dir), "docs", `${stem}.md`),
			join(dir, `${stem}.md`),
			join(dir, "README.md"),
		];
		for (const docPath of candidates) {
			if (!existsSync(docPath)) continue;
			if (trajectory.files_written.has(docPath)) continue;
			if (trajectory.files_read.has(docPath)) continue;
			return [
				{
					prior_event_count: 1,
					prior_summary: `${filePath} edited`,
					message:
						`Source file ${filePath} edited; sibling doc ${docPath} was not opened ` +
						"this session. Consider whether the doc needs an update.",
					evidence: [docPath],
				},
			];
		}
		return [];
	},
};

// ============================================================
// §3.18 magic_literal_cross_file_proliferation
// ============================================================

/** Minimum number of distinct files a literal must appear in this session
 *  before the cross-file proliferation detector fires. Per design doc §3.18 —
 *  "the same magic value spread across files should be a constant." */
const MAGIC_LITERAL_FILE_THRESHOLD = 3;

/**
 * Fires at Stop when the same non-trivial literal was introduced in 3+
 * distinct files this session. Reads `trajectory.literal_occurrences`
 * (populated upstream by session-state on each PostToolUse). This detector
 * does NOT extract literals itself — it only walks the map and checks the
 * `Set.size` threshold.
 */
export const magicLiteralCrossFileProliferation: SequenceDetector = {
	id: "magic_literal_cross_file_proliferation",
	description:
		"Same non-trivial literal introduced across 3+ files this session — extract a constant",
	family: "quality",
	phase: "stop",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory) => {
		const occurrences = trajectory.literal_occurrences;
		if (!occurrences || occurrences.size === 0) return [];
		const matches: SequenceMatch[] = [];
		for (const [literalHash, files] of occurrences) {
			// Test files are exempt: self-contained suites repeat fixture literals
			// BY CONTRACT (no cross-test-file coupling), so counting them made
			// every parallel test-writing wave fire this detector (5x on
			// 2026-08-23 alone). Scratch probes are equally exempt — throwaway
			// analysis scripts under scratch/ repeat fixtures by nature and
			// share no maintained constant surface. Only non-test, non-scratch
			// files count toward the threshold.
			const fileList = Array.from(files).filter(
				(f) => !isTestFilePath(f) && !/(?:^|\/)scratch\//.test(f),
			);
			if (fileList.length < MAGIC_LITERAL_FILE_THRESHOLD) continue;
			matches.push({
				prior_event_count: fileList.length,
				prior_summary: `literal seen in ${fileList.length} files`,
				message:
					`The same literal (${literalHash}) was introduced in ${fileList.length} different files ` +
					`this session: ${fileList.slice(0, 3).join(", ")}` +
					(fileList.length > 3 ? ` (+${fileList.length - 3} more)` : "") +
					". Extract it into a shared constant rather than repeating the value.",
				evidence: fileList.slice(0, 3),
			});
		}
		return matches;
	},
};

// ============================================================
// §3.20 coverage_silent_regression
// ============================================================

/** Source-file edit count above which the silent-coverage check fires
 *  when no test files were touched and all test runs were green. */
const COVERAGE_SOURCE_FILE_THRESHOLD = 5;

/** Pass-state literal for `test_runs` entries. Hoisted to a named constant
 *  so the coverage detector's predicate reads as intent rather than a
 *  bare string equality. */
const TEST_RUN_STATUS_PASS = "pass";

/** Non-test source files from a session's `files_written` list — the
 *  candidate set the silent-coverage detector checks against test activity. */
function collectNonTestSourceFilesWritten(filesWritten: Iterable<string>): string[] {
	const sourceFilesWritten: string[] = [];
	for (const file of filesWritten) {
		if (!isSourceFile(file)) continue;
		if (isTestFilePath(file)) continue;
		sourceFilesWritten.push(file);
	}
	return sourceFilesWritten;
}

/**
 * Fires at Stop when (a) >5 source files were written this session,
 * (b) no test file appears in either `files_written` or `files_read`, and
 * (c) every recorded test run passed. The combination is the textbook
 * "tests green, but new code was never exercised" coverage hole.
 */
export const coverageSilentRegression: SequenceDetector = {
	id: "coverage_silent_regression",
	description:
		"Source files added without test edits while suite stayed green — coverage hole",
	family: "quality",
	phase: "stop",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory) => {
		const sourceFilesWritten = collectNonTestSourceFilesWritten(trajectory.files_written);
		if (sourceFilesWritten.length <= COVERAGE_SOURCE_FILE_THRESHOLD) return [];
		// Any test file touched this session disqualifies the finding.
		for (const file of trajectory.files_written) {
			if (isTestFilePath(file)) return [];
		}
		for (const file of trajectory.files_read) {
			if (isTestFilePath(file)) return [];
		}
		// Need at least one test run AND every run must have passed.
		if (trajectory.test_runs.size === 0) return [];
		for (const [, run] of trajectory.test_runs) {
			if (run.status !== TEST_RUN_STATUS_PASS) return [];
		}
		return [
			{
				prior_event_count: sourceFilesWritten.length,
				prior_summary: `${sourceFilesWritten.length} source files written, 0 test files touched`,
				message:
					`${sourceFilesWritten.length} source files were written this session ` +
					"without any test file being edited or read, but the suite is still green. " +
					"The new code is unverified by the existing tests — add coverage for the new paths.",
				evidence: sourceFilesWritten.slice(0, 3),
			},
		];
	},
};

// ============================================================
// §3.22 unused_helper_introduced
// ============================================================

/**
 * Fires at Stop when a `pending_completion` entry exists whose
 * `affected_files` is empty — i.e., an exported symbol was introduced but
 * the project graph found no callers. Distinct from
 * `signature_change_callers_not_updated` (§3.16), which fires when callers
 * DO exist but were not visited.
 */
export const unusedHelperIntroduced: SequenceDetector = {
	id: "unused_helper_introduced",
	description:
		"Exported helper added this session but no callers exist in the project graph",
	family: "quality",
	phase: "stop",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory) => {
		const matches: SequenceMatch[] = [];
		for (const [sourceFile, completion] of trajectory.pending_completions) {
			if (completion.affected_files.length > 0) continue;
			matches.push({
				prior_event_count: 1,
				prior_summary: `helper added to ${sourceFile} with 0 known callers`,
				message:
					`${sourceFile} added a new exported helper but the project graph found no ` +
					"callers. Either wire the helper in this session or drop it — unused exports " +
					"are a refactor-tail smell.",
				evidence: [sourceFile],
			});
		}
		return matches;
	},
};

// ============================================================
// §3.23 plan_vs_trajectory_drift_quality
// ============================================================

/** Untrusted-provenance set, mirrored from injection.ts. Kept local so the
 *  quality module has no dependency on the injection module. If the set
 *  ever needs to diverge across families this stays simple to fork. */
const UNTRUSTED_PROVENANCE_QUALITY: ReadonlySet<TaintProvenance> =
	new Set<TaintProvenance>([
		"fetched_external",
		"mcp_remote",
		"document_content",
		"user_provided",
	]);

/**
 * Mirror of `planVsTrajectoryDrift` (injection.ts §3.15) — same divergence
 * detection, opposite taint condition. Fires when the candidate diverges
 * from the declared plan AND no untrusted-content source was ingested since
 * the plan was captured. With no `fetched_external` / `mcp_remote` /
 * `document_content` / `user_provided` anchor, the drift is most likely
 * scope creep (a quality issue), not injection-induced (a security issue).
 */
export const planVsTrajectoryDriftQuality: SequenceDetector = {
	id: "plan_vs_trajectory_drift_quality",
	description:
		"Candidate diverges from the declared plan with no untrusted content in flight — scope creep",
	family: "quality",
	phase: "pre_warn",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory, candidate) => {
		const plan = trajectory.declared_plan;
		if (!plan) return [];
		if (planHintsContainTool(candidate.tool_name, plan)) return [];
		const planAtStep = plan.created_at_step;
		const subsequentUntrusted = trajectory.taint_sources.filter(
			(s) =>
				s.at_step >= planAtStep && UNTRUSTED_PROVENANCE_QUALITY.has(s.provenance),
		);
		// Inverse condition vs §3.15: if any untrusted source IS present
		// after the plan was captured, defer to the injection-flavored
		// detector and stay silent here to avoid a duplicate warning.
		if (subsequentUntrusted.length > 0) return [];
		const planHints = plan.steps
			.map((s) => s.tool_hint)
			.filter((h): h is string => typeof h === "string" && h.length > 0);
		return [
			{
				prior_event_count: 1,
				prior_summary:
					`plan declared at step ${planAtStep} with tool hints [${planHints.join(", ")}]`,
				message:
					`Candidate tool (${candidate.tool_name ?? "unknown"}) is not in the declared ` +
					`plan's tool hints (${planHints.join(", ") || "none"}), and no untrusted ` +
					"content has been ingested since the plan was captured. This looks like " +
					"scope creep — either update the plan or refocus on the declared steps.",
				evidence: planHints.slice(0, 3),
			},
		];
	},
};

/** Re-export aliased symbols too so an outside-the-test test pattern (rare)
 *  works against either casing. */
export const QUALITY_DETECTORS: ReadonlyArray<SequenceDetector> = [
	signatureChangeCallersNotUpdated,
	regressionTestMissingAfterFix,
	magicLiteralCrossFileProliferation,
	staleDocSibling,
	coverageSilentRegression,
	addThenRevertLoop,
	unusedHelperIntroduced,
	planVsTrajectoryDriftQuality,
];

// `isTestFilePath` is part of this module's public API — sibling sequence
// detectors that haven't landed yet (registered via the central
// `sequence-checks` index, not direct imports) consume it. Kept exported
// as a forward-compatible hook.
export { addThenRevertLoop, isTestFilePath };
