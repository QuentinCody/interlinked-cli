// Deletion hygiene — zombie code detectors.
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Deletion Hygiene — Zombie Code Detectors
// ===========================================
// These checks detect code that should have been deleted but wasn't.
// AI agents systematically hedge on deletion: they stub instead of remove,
// add deprecation ceremony instead of deleting, hollow out tests instead
// of removing them, and narrate deletions in comments. These patterns
// are never shippable and indicate an incomplete deletion.

/**
 * Detect "not implemented" / "TODO" / "stub" throw statements.
 * `throw new Error("Not implemented")` is never shippable — the agent punted.
 *
 * Also detects: `throw new Error("TODO")`, `throw new Error("stub")`,
 * `throw "not implemented"`, `// TODO: implement` on an otherwise empty function.
 *
 * Skips test files (test stubs are sometimes intentional).
 */
export function checkNotImplementedStubs(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Match the original lines (we need the string content), but skip comment-only lines
	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(originalLines[i]);
		const strippedLine = nonNull(strippedLines[i]).trim();

		// Skip if the line is entirely a comment (stripped content is empty)
		if (strippedLine.length === 0 && line.trim().length > 0) continue;

		// Pattern 1: throw new Error("Not implemented|TODO|stub|...")
		if (
			/\bthrow\s+new\s+Error\s*\(\s*["'`](not\s*implemented|todo|stub|fixme|unimplemented|needs?\s*implementation)/i.test(
				line,
			)
		) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
			continue;
		}

		// Pattern 2: throw "not implemented" (bare string throw)
		if (/\bthrow\s+["'`](not\s*implemented|todo|stub)/i.test(line)) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
			continue;
		}

		// Pattern 3: return with a TODO/FIXME comment indicating incomplete implementation
		// e.g., `return null; // TODO: implement` or `return undefined; // FIXME`
		if (/\breturn\s+(null|undefined)\s*;?\s*\/\/\s*(TODO|FIXME|HACK|XXX)\b/i.test(line)) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}

	return matches;
}

const EMPTY_FN_PATTERNS = [
	/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/,
	/(\w+)\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/, // method syntax
];

/**
 * From a single stripped line, return the function/method name if the line opens
 * a function whose body is worth inspecting, or `null` to skip it. Skips
 * intentional no-ops (`_`-prefixed, `noop`), abstract members, and constructors
 * (often empty for DI). Pure helper for {@link checkEmptyFunctionBody}.
 */
function emptyFnCandidateName(line: string): string | null {
	let funcName: string | null = null;
	for (const pat of EMPTY_FN_PATTERNS) {
		const m = line.match(pat);
		if (m) {
			funcName = nonNull(m[1]);
			break;
		}
	}
	if (!funcName) return null;
	if (funcName.startsWith("_") || funcName === "noop" || funcName === "NOOP") return null;
	if (/\babstract\b/.test(line)) return null;
	if (funcName === "constructor") return null;
	return funcName;
}

/**
 * Collect the (stripped) body text of the function opening at `startIndex`,
 * scanning forward up to 8 lines and tracking brace depth so it stops at the
 * closing brace. Returns the trimmed body. Pure helper for
 * {@link checkEmptyFunctionBody}.
 */
function collectEmptyFnBody(strippedLines: string[], startIndex: number): string {
	let bodyContent = "";
	let braceDepth = 0;
	let started = false;
	for (let j = startIndex; j < Math.min(startIndex + 8, strippedLines.length); j++) {
		for (const ch of nonNull(strippedLines[j])) {
			if (ch === "{") {
				started = true;
				braceDepth++;
			}
			if (ch === "}") braceDepth--;
		}
		if (started && j > startIndex) {
			bodyContent = `${bodyContent}${nonNull(strippedLines[j]).trim()}\n`;
		}
		if (started && braceDepth === 0) break;
	}
	return bodyContent.trim();
}

/**
 * True when a collected function body is empty or a trivial stub return
 * (`return;` / `return null;` / `return undefined;` as the only statement).
 * Pure helper for {@link checkEmptyFunctionBody}.
 */
function isTrivialFnBody(bodyContent: string): boolean {
	// Empty body: just whitespace or closing brace
	if (bodyContent === "" || bodyContent === "}") return true;
	// Trivial stub: only `return null;` or `return undefined;` or `return;`
	const nonTrivialLines = bodyContent
		.split("\n")
		.filter((l) => l.trim().length > 0 && l.trim() !== "}").length;
	return (
		/^(return\s*(null|undefined)\s*;?\s*\}?|return\s*;\s*\}?)$/m.test(bodyContent) &&
		nonTrivialLines <= 1
	);
}

/**
 * Detect functions/methods with empty bodies or trivial stub returns.
 * An exported function that does nothing is dead weight pretending to be alive.
 *
 * Detects:
 * - `function foo() {}`
 * - `function foo() { return undefined; }`
 * - `function foo() { return null; }`
 * - `foo() { return; }`
 * - Arrow functions: `const foo = () => {}`
 *
 * Skips: test files, abstract/interface declarations, catch blocks,
 * noop/_ prefixed functions, callback/handler stubs (onX, handleX with 0 lines),
 * .d.ts files, overload signatures.
 */
export function checkEmptyFunctionBody(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (filePath.endsWith(".d.ts")) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]).trim();

		const funcName = emptyFnCandidateName(line);
		if (!funcName) continue;

		const bodyContent = collectEmptyFnBody(strippedLines, i);
		if (isTrivialFnBody(bodyContent)) {
			matches.push({
				line: i + 1,
				text: `[empty function body] ${nonNull(originalLines[i]).trim().slice(0, 120)}`,
			});
		}
	}

	return matches;
}

/**
 * Net brace-depth change across one line: each `{` adds one, each `}` subtracts
 * one. Pure helper for {@link countFnBodyLines}.
 */
function braceDelta(line: string): number {
	let delta = 0;
	for (const ch of line) {
		if (ch === "{") delta++;
		if (ch === "}") delta--;
	}
	return delta;
}

/**
 * True when a body line counts toward the function's size — a blank line or a
 * lone `}` does not. Pure helper for {@link countFnBodyLines}.
 */
function isCountableBodyLine(line: string): boolean {
	const trimmedBody = line.trim();
	return trimmedBody.length > 0 && trimmedBody !== "}";
}

/**
 * Count the non-trivial body lines of the function opening at `fnIndex`,
 * scanning forward up to 8 lines and tracking brace depth. A blank line or a
 * lone `}` does not count. Pure helper for {@link checkDeprecationNotice}.
 */
function countFnBodyLines(lines: string[], fnIndex: number): number {
	let bodyLines = 0;
	let braceDepth = 0;
	let bodyStarted = false;
	for (let k = fnIndex; k < Math.min(fnIndex + 8, lines.length); k++) {
		const text = nonNull(lines[k]);
		if (text.includes("{")) bodyStarted = true;
		braceDepth += braceDelta(text);
		if (bodyStarted && k > fnIndex && isCountableBodyLine(text)) bodyLines++;
		if (bodyStarted && braceDepth === 0) break;
	}
	return bodyLines;
}

/**
 * Starting just after a `@deprecated` line at `deprecatedIndex`, scan ahead (up
 * to 5 lines) for the function it annotates. If found and its body is trivial
 * (≤1 non-trivial line), return that function's trimmed source line; otherwise
 * `null`. Pure helper for {@link checkDeprecationNotice}.
 */
function deprecatedTrivialFnLine(lines: string[], deprecatedIndex: number): string | null {
	for (let j = deprecatedIndex + 1; j < Math.min(deprecatedIndex + 5, lines.length); j++) {
		const nextLine = nonNull(lines[j]).trim();
		if (/^(export\s+)?(async\s+)?function\s+\w+|^\w+\s*\(/.test(nextLine)) {
			return countFnBodyLines(lines, j) <= 1 ? nextLine : null;
		}
		// Skip blank lines and other JSDoc lines
		if (nextLine.length > 0 && !nextLine.startsWith("*") && !nextLine.startsWith("//")) {
			return null;
		}
	}
	return null;
}

/**
 * Detect deprecation ceremony — @deprecated annotations or deprecation warnings
 * on functions that have no real implementation.
 *
 * Legitimate: `@deprecated` on a working function (telling callers to migrate).
 * Zombie: `@deprecated` on an empty/stub function, or `console.warn("deprecated")`
 * added as the only logic. The agent added ceremony instead of deleting.
 */
export function checkDeprecationNotice(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(originalLines[i]);

		// Pattern 1: console.warn/log with "deprecated" or "removed" in the message
		if (
			/\bconsole\.(warn|log)\s*\([^)]*\b(deprecated|removed|no\s*longer\s*(available|supported|exists?))\b/i.test(
				line,
			)
		) {
			matches.push({
				line: i + 1,
				text: `[deprecation ceremony — just delete it] ${nonNull(line).trim().slice(0, 120)}`,
			});
			continue;
		}

		// Pattern 2: @deprecated JSDoc tag followed by an empty/stub function
		if (/@deprecated/i.test(line)) {
			const trivialFnLine = deprecatedTrivialFnLine(originalLines, i);
			if (trivialFnLine !== null) {
				matches.push({
					line: i + 1,
					text: `[@deprecated on empty/stub function — just delete it] ${trivialFnLine.slice(0, 100)}`,
				});
			}
		}
	}

	return matches;
}

/**
 * Collect the (stripped) body text of the test block opening at `startIndex`,
 * scanning forward up to 10 lines and tracking brace depth (stops at the closing
 * brace). Lines are space-joined. Pure helper for {@link checkOrphanedTestStub}.
 */
function collectTestBody(strippedLines: string[], startIndex: number): string {
	let braceDepth = 0;
	let bodyStarted = false;
	let bodyContent = "";
	for (let j = startIndex; j < Math.min(startIndex + 10, strippedLines.length); j++) {
		for (const ch of nonNull(strippedLines[j])) {
			if (ch === "{") {
				bodyStarted = true;
				braceDepth++;
			}
			if (ch === "}") braceDepth--;
		}
		if (bodyStarted && j > startIndex) {
			bodyContent = `${bodyContent}${nonNull(strippedLines[j]).trim()} `;
		}
		if (bodyStarted && braceDepth <= 0) break;
	}
	return bodyContent.trim();
}

/**
 * True when a collected test body is empty or only closing punctuation /
 * a bare `return`. Pure helper for {@link checkOrphanedTestStub}.
 */
function isEmptyTestBody(bodyContent: string): boolean {
	return (
		bodyContent === "" ||
		bodyContent === "}" ||
		bodyContent === "});" ||
		/^(return\s*;?\s*)?[});\s]*$/.test(bodyContent)
	);
}

/**
 * Detect test blocks with empty bodies — tests that silently pass without
 * testing anything. The agent hollowed out the test instead of deleting it.
 *
 * Distinct from:
 * - checkAssertionFreeTests: catches tests with CODE but no assertions
 * - checkTestRegressions: catches it.skip / it.todo
 * This catches tests that LOOK active but have completely empty bodies.
 *
 * Detects:
 * - `it("...", () => {})`
 * - `it("...", () => { return; })`
 * - `it("...", function() {})`
 * - `test("...", () => {})`
 */
export function checkOrphanedTestStub(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Pattern: it( or test( on a line (not .skip, .todo, xit, xtest)
	const testOpenPattern = /\b(?:it|test)\s*\(\s*(?:["'`])/;
	const skipPattern = /\b(?:it|test)\s*\.\s*(?:skip|todo|only)\s*\(/;
	const xPattern = /\b(?:xit|xtest)\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]).trim();

		if (!testOpenPattern.test(line)) continue;
		if (skipPattern.test(line) || xPattern.test(line)) continue;

		const bodyContent = collectTestBody(strippedLines, i);
		if (isEmptyTestBody(bodyContent)) {
			matches.push({
				line: i + 1,
				text: `[empty test body — delete the test or implement it] ${nonNull(originalLines[i]).trim().slice(0, 100)}`,
			});
		}
	}

	return matches;
}

/**
 * Detect comments that narrate deletion — prose about what was removed,
 * what used to exist, or what "no longer" applies.
 *
 * These comments are dead weight: the git history records what was deleted.
 * Leaving narration comments clutters the code and confuses grep.
 *
 * Detects:
 * - `// Removed the old auth handler`
 * - `// Previously this called validateToken()`
 * - `// No longer needed`
 * - `// Was: oldFunction()`
 * - `// Deleted the X feature`
 *
 * Skips: TODO/FIXME comments, license headers, JSDoc annotations.
 */
export function checkDeletionComments(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".py"].includes(ext))
		return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const isPython = ext === ".py";
	const commentPattern = isPython ? /^\s*#\s*(.+)/ : /^\s*\/\/\s*(.+)/;

	// Patterns that indicate deletion narration
	const deletionPatterns = [
		/\b(removed|deleted|stripped\s+out|ripped\s+out|gutted|eliminated)\s+(the|this|old|previous|legacy|unused|obsolete)\b/i,
		/\bpreviously\s+(this|we|it)\s+(called|used|had|was|relied)/i,
		/\bno\s+longer\s+(needed|used|required|necessary|exists?|supported|available)/i,
		/\bwas\s*:\s*\w+/i, // "Was: oldFunction()"
		/\bused\s+to\s+(call|use|have|be|return|import)/i,
		/\b(old|legacy|deprecated|obsolete)\s+\w+\s+(removed|deleted|stripped)/i,
		/\bthis\s+(was|used\s+to\s+be|has\s+been)\s+(removed|deleted|deprecated)/i,
	];

	// Skip patterns (legitimate comments that happen to use deletion vocabulary)
	const skipPatterns = [
		/^\s*(\/\/|#)\s*(TODO|FIXME|HACK|XXX|NOTE)\b/i,
		/^\s*(\/\/|#)\s*@/i, // JSDoc annotations
		/^\s*(\/\/|#)\s*(copyright|license|MIT|Apache)/i,
		/^\s*(\/\/|#)\s*eslint-disable/i,
		/^\s*(\/\/|#)\s*interlinked-ignore/i,
	];

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(originalLines[i]);

		// Must be a comment line
		const commentMatch = line.match(commentPattern);
		if (!commentMatch) continue;

		// Skip known non-deletion comment types
		if (skipPatterns.some((p) => p.test(line))) continue;

		// Check if the comment narrates a deletion
		const commentText = nonNull(commentMatch[1]);
		if (deletionPatterns.some((p) => p.test(commentText))) {
			matches.push({
				line: i + 1,
				text: `[deletion narration — git history records this] ${nonNull(line).trim().slice(0, 120)}`,
			});
		}
	}

	return matches;
}
