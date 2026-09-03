// ===========================================
// Deletion Hygiene — Diff-Aware Zombie Detectors (Layer 2)
// ===========================================
// These checks compare old_string vs new_string from Edit tool calls
// to catch agents in the act of hedging on deletion. They detect:
// - Working code replaced with stubs
// - Tests gutted instead of deleted
// - Deprecation ceremony added instead of deleting
// - Comments narrating deletion instead of just deleting
//
// These run in the PostToolUse pipeline when old_string is available.
// They return Finding[] for injection into the suggestion scorer,
// but with higher base severity than typical heuristic checks.

import { nonNull } from "../lib/non-null.js";
import type { Finding } from "./suggestion-scorer.js";

// ===========================================
// Helpers
// ===========================================

/** Check if content has "real code" indicators — multiple statements, control flow, etc. */
function hasRealCode(text: string): boolean {
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && l !== "{" && l !== "}" && l !== "};");

	if (lines.length < 2) return false;

	// Real code has control flow, multiple statements, or function calls
	const codeIndicators =
		/\b(if|else|for|while|switch|try|catch|await|yield|const|let|var)\b|\breturn\s+\S|[;{}]\s*\S/;
	let codeLineCount = 0;
	for (const line of lines) {
		if (codeIndicators.test(line)) codeLineCount++;
	}
	return codeLineCount >= 2;
}

/** Check if content is a stub — throw "not implemented", return null, or empty */
function isStubContent(text: string): boolean {
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => {
			if (l.length === 0) return false;
			// Strip structural-only lines (braces, closing parens)
			if (l === "{" || l === "}" || l === "};" || l === ");") return false;
			// Strip function/method signatures (they're the wrapper, not the body)
			if (/^(export\s+)?(async\s+)?function\s+\w+/.test(l)) return false;
			if (/^(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/.test(l)) return false;
			if (/^\w+\s*\([^)]*\)\s*\{?\s*$/.test(l)) return false;
			return true;
		});

	if (lines.length === 0) return true;
	if (lines.length > 2) return false;

	const body = lines.join(" ");
	const throwStub = /^\s*throw\s+new\s+Error\s*\(\s*['"](not\s*implemented|todo|stub|fixme)/i;
	const returnDefault = /^\s*return\s+(null|undefined|\[]|{}|false|void\s+0)\s*;?\s*$/;
	const bareReturn = /^\s*return\s*;\s*$/;
	const bareThrow = /^\s*throw\s+['"](not\s*implemented|todo|stub)/i;
	return (
		throwStub.test(body) ||
		returnDefault.test(body) ||
		bareReturn.test(body) ||
		bareThrow.test(body)
	);
}

/** Check if text contains assertions (expect, assert, should) */
function hasAssertions(text: string): boolean {
	return /\b(expect|assert)\s*\(|\.should\.|\.to(Equal|Be|Have|Match|Throw|Include|Contain)\b/.test(
		text,
	);
}

/** Check if a file path looks like a test file */
function looksLikeTestFile(filePath: string): boolean {
	return (
		/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath) ||
		/\/__tests__\//.test(filePath) ||
		/\/tests?\//.test(filePath)
	);
}

// ===========================================
// Layer 2 Diff-Aware Checks
// ===========================================

/**
 * Detect working code replaced with a stub.
 * The agent was supposed to remove a function but replaced its body
 * with `throw new Error("Not implemented")` or `return null` instead.
 *
 * old_string: had real logic (multiple statements, conditionals, returns)
 * new_string: has a stub (throw Error, return null, empty body)
 */
export function checkReplacedWithStub(
	oldString: string,
	newString: string,
	filePath: string,
): Finding[] {
	if (looksLikeTestFile(filePath)) return [];
	if (!hasRealCode(oldString)) return [];
	if (!isStubContent(newString)) return [];

	// Count how much code was replaced
	const oldLines = oldString.split("\n").filter((l) => l.trim().length > 0).length;

	return [
		{
			check: "replaced-with-stub",
			line: 0,
			message: `Working code (${oldLines} lines) was replaced with a stub. If removing this function, delete it entirely instead of stubbing it out.`,
			source: "quality",
		},
	];
}

/**
 * Detect tests that were gutted instead of deleted.
 * The agent emptied a test body or converted it to it.skip instead of
 * removing the test entirely.
 *
 * old_string: had assertions (expect, assert, should)
 * new_string: has empty body, it.skip, or no assertions
 */
export function checkTestGutted(oldString: string, newString: string, filePath: string): Finding[] {
	if (!looksLikeTestFile(filePath)) return [];
	if (!hasAssertions(oldString)) return [];

	// Check if new_string gutted the test
	const isGutted =
		// Converted to skip/todo
		/\b(it|test|describe)\.(skip|todo)\s*\(/.test(newString) ||
		// Empty body
		(/\b(it|test)\s*\(/.test(newString) &&
			!hasAssertions(newString) &&
			newString
				.split("\n")
				.filter(
					(l) =>
						l.trim().length > 0 &&
						l.trim() !== "}" &&
						l.trim() !== "});" &&
						l.trim() !== "{",
				).length <= 2);

	if (!isGutted) return [];

	return [
		{
			check: "test-gutted",
			line: 0,
			message:
				"Test was gutted instead of deleted. If the feature is gone, delete the test entirely.",
			source: "quality",
		},
	];
}

/**
 * Detect deprecation ceremony added in a diff.
 * The agent added @deprecated annotations or console.warn("deprecated")
 * instead of just deleting the code.
 */
export function checkDeprecationAdded(
	oldString: string,
	newString: string,
	_filePath: string,
): Finding[] {
	const hadDeprecation =
		/@deprecated/i.test(oldString) ||
		/\bconsole\.(warn|log)\s*\([^)]*deprecated/i.test(oldString);
	if (hadDeprecation) return []; // Already existed — not a new addition

	const hasNewDeprecation =
		/@deprecated/i.test(newString) ||
		/\bconsole\.(warn|log)\s*\([^)]*\b(deprecated|removed|no\s*longer)\b/i.test(newString);
	if (!hasNewDeprecation) return [];

	return [
		{
			check: "deprecation-added",
			line: 0,
			message:
				"Deprecation notice was added instead of deleting the code. If removing this, just delete it — don't add ceremony.",
			source: "quality",
		},
	];
}

/**
 * Detect deletion-narrating comments added in a diff.
 * The agent added comments like "Removed the old auth handler" instead
 * of just deleting the code and letting git record the history.
 */
export function checkDeletionCommentAdded(
	oldString: string,
	newString: string,
	_filePath: string,
): Finding[] {
	const deletionVocabulary =
		/\/\/\s*.*(removed|deleted|stripped\s+out|no\s+longer\s+(needed|used|required)|previously\s+(called|used|had)|used\s+to\s+(call|use|be)|was\s*:\s*\w+)/i;

	const hadDeletionComment = deletionVocabulary.test(oldString);
	if (hadDeletionComment) return []; // Already existed

	const hasNewDeletionComment = deletionVocabulary.test(newString);
	if (!hasNewDeletionComment) return [];

	return [
		{
			check: "deletion-comment-added",
			line: 0,
			message:
				"Comment narrating a deletion was added. Git history records what was removed — don't leave prose about it in the code.",
			source: "quality",
		},
	];
}

// ===========================================
// Layer 3: Session-Level Orphaned Tests Check
// ===========================================

const isWordChar = (ch: string) => /\w/.test(ch);

/**
 * True when `symbol` occurs in `content` delimited by non-word characters.
 * Uses indexOf + boundary checks instead of a dynamic RegExp (semgrep ReDoS concern).
 */
function referencesSymbolAsWord(content: string, symbol: string): boolean {
	let searchFrom = 0;
	while (searchFrom < content.length) {
		const idx = content.indexOf(symbol, searchFrom);
		if (idx === -1) return false;
		const before = idx > 0 ? nonNull(content[idx - 1]) : " ";
		const after =
			idx + symbol.length < content.length
				? nonNull(content[idx + symbol.length])
				: " ";
		if (!isWordChar(before) && !isWordChar(after)) return true;
		searchFrom = idx + 1;
	}
	return false;
}

/**
 * After structural checks detect removed exports, check if test files
 * for those exports were also cleaned up.
 *
 * Returns findings if:
 * - Symbols were removed from a source file's exports
 * - The source file has a co-located test file
 * - The test file still references the removed symbols
 * - The test file was NOT edited in this session
 *
 * This catches the pattern where an agent removes a function but
 * forgets to clean up its tests (or stubs them instead of deleting).
 */
export function checkOrphanedTests(
	removedSymbols: string[],
	testFilePath: string,
	testFileContent: string,
	testFileWasEdited: boolean,
): Finding[] {
	if (removedSymbols.length === 0) return [];
	if (testFileWasEdited) return []; // Agent already touched the test file

	const findings: Finding[] = [];

	for (const symbol of removedSymbols) {
		// Does the test file still reference this symbol as a whole word?
		if (!referencesSymbolAsWord(testFileContent, symbol)) continue;
		findings.push({
			check: "orphaned-test-reference",
			line: 0,
			message: `"${symbol}" was removed but ${testFilePath} still references it. Delete or update the test.`,
			source: "quality",
		});
	}

	// Cap at 5 findings to avoid noise
	return findings.slice(0, 5);
}
