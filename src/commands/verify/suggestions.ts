// ===========================================
// Scored regex suggestions
// ===========================================
// Non-deterministic heuristics (SQL injection patterns, perf smells, silent
// catches). Opt-in via `interlinked verify --suggestions`. Findings are
// scored and filtered against inline + file-level suppressions.
//
// PARITY BOOKKEEPING — when adding a new entry below:
//   1. Mirror in `src/harness/server/suggestion-checks.ts` (the live
//      PostToolUse counterpart). See the comment block at the top of
//      that file for the full checklist.
//   2. Update the parity tests if the check ID is new:
//      `src/__tests__/suggestion-registry-parity.test.ts::PARITY_REQUIRED`,
//      `src/harness/__tests__/check-pipeline-parity.test.ts::VERIFY_ONLY_CHECKS`.

import { readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import {
	checkAwaitInLoop,
	checkMixedErrorStrategy,
	checkQueryInLoop,
	checkRecursiveWalkerLstat,
	checkSilentCatch,
	checkSqlInjection,
	checkUnreachableCode,
} from "../../harness/generic-checks.js";
import { type Finding, scoreFindings } from "../../harness/suggestion-scorer.js";
import { loadFileSuppressions, scanInlineSuppressions } from "../../harness/suppressions.js";
// Canonical "is this a test file" predicate (multi-language). Replaces a local
// two-arg copy that recognised only `.test`/`.spec` basenames and `__tests__/`.
// Verified equivalent on this repo's file list before the swap: 1361 of 2559
// JS/TS files fire under both, with zero files gained or lost. See the probe
// scratch/is-test-file-divergence.mts.
import { isTestFile } from "../../harness/taste-checks-shared.js";

const JS_TS_CODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

interface SuggestionCheck {
	check: string;
	source: "security" | "performance" | "quality";
	fn: () => Array<{ line: number; text: string }>;
}

function buildChecks(content: string, file: string): SuggestionCheck[] {
	return [
		{
			check: "sql-injection",
			source: "security",
			fn: () => checkSqlInjection(content, file),
		},
		{
			check: "perf-query-in-loop",
			source: "performance",
			fn: () => checkQueryInLoop(content, file),
		},
		{
			check: "perf-await-in-loop",
			source: "performance",
			fn: () => checkAwaitInLoop(content, file),
		},
		{
			check: "silent-catch",
			source: "quality",
			fn: () => checkSilentCatch(content, file),
		},
		// `silent-promise-swallow` promoted to the default-warning
		// CHECK_REGISTRY pipeline (entries-warnings.ts → silent_promise_catch).
		// It no longer runs as a scored suggestion to avoid double-firing.
		{
			check: "recursive-walker-lstat",
			source: "security",
			fn: () => checkRecursiveWalkerLstat(content, file),
		},
		{
			check: "unreachable-code",
			source: "quality",
			fn: () => checkUnreachableCode(content, file),
		},
		{
			check: "mixed-error-strategy",
			source: "quality",
			fn: () => checkMixedErrorStrategy(content, file),
		},
	];
}

interface RunSuggestionsArgs {
	files: string[];
	cwd: string;
	limit: number;
	threshold: number;
}

/** Run every registered scored-suggestion detector over one file's content. */
function collectRawFindings(content: string, file: string): Finding[] {
	const findings: Finding[] = [];
	for (const { check, source, fn } of buildChecks(content, file)) {
		for (const m of fn()) {
			findings.push({ check, line: m.line, message: m.text, source });
		}
	}
	return findings;
}

/**
 * Public API — consumed by `verify.ts` (opt-in `--suggestions` flag).
 *
 * Run scored regex suggestions (SQL injection, perf, silent catches, etc.) and
 * return one `Finding[]` per file that had surviving findings after scoring.
 */
export function runSuggestions(args: RunSuggestionsArgs): Map<string, Finding[]> {
	const { files, cwd, limit, threshold } = args;
	const interlinkedDir = join(cwd, ".interlinked");
	const resultsByFile = new Map<string, Finding[]>();

	for (const file of files) {
		let content: string;
		try {
			content = readFileSync(file, "utf-8");
		} catch {
			continue;
		}

		const ext = extname(file).toLowerCase();
		if (!JS_TS_CODE_EXTS.includes(ext)) continue;

		if (isTestFile(file)) continue;

		const relPath = relative(cwd, file);
		const inlineSup = scanInlineSuppressions(content);
		const fileSup = loadFileSuppressions(interlinkedDir, relPath);

		const findings = collectRawFindings(content, file);

		if (findings.length === 0) continue;
		const scored = scoreFindings(findings, {
			filePath: file,
			inlineSuppressions: inlineSup,
			fileSuppressions: fileSup,
			limit,
			threshold,
		});
		if (scored.length > 0) {
			resultsByFile.set(relPath, scored);
		}
	}

	return resultsByFile;
}
