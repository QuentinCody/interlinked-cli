// Swift-specific checks (Apple API Design Guidelines + Memory Safety + Concurrency).
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";

export {
	checkSwiftDelegateNotWeak,
	checkSwiftForceCast,
	checkSwiftForceTry,
	checkSwiftForceUnwrap,
	checkSwiftImplicitlyUnwrappedOptional,
} from "./swift-memory-safety.js";
export {
	checkTestRegressions,
	extractEnvReferences,
	extractMockDefinitions,
	extractModuleExportNames,
} from "./swift-test-integrity.js";

/**
 * Detect legacy arc4random() usage in Swift.
 * Apple: Use Int.random(in:), Bool.random(), Collection.randomElement().
 */
export function checkSwiftLegacyRandom(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\barc4random/, 10);
}

/**
 * Detect legacy hashValue implementation.
 * Apple: Implement hash(into hasher: inout Hasher) instead.
 */
export function checkSwiftLegacyHashValue(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\bvar\s+hashValue\s*:\s*Int\b/, 10);
}

/**
 * Detect #file or #filePath in non-test Swift code.
 * Apple: "Use #fileID — it produces smaller strings and avoids leaking the developer's file system."
 * Note: scans original lines because stripComments treats # as Python comment (which strips Swift directives).
 * Only skips lines that start with // (Swift single-line comments).
 */
export function checkSwiftFileIdOverFilePath(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = nonNull(originalLines[i]).trimStart();
		// Skip Swift comment lines
		if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*"))
			continue;
		if (/#file(?:Path)?\b(?!ID|Literal)/.test(nonNull(originalLines[i]))) {
			matches.push({
				line: i + 1,
				text: nonNull(originalLines[i]).trim().slice(0, 150),
			});
		}
	}

	return matches;
}

/**
 * Detect common non-standard abbreviations in Swift identifiers.
 * Apple ADG: "Avoid abbreviations. The expanded form is readily looked up."
 */
export function checkSwiftAbbreviations(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Common iOS/Swift abbreviations flagged by Apple's guidelines
	// Matches declarations (var/let/func name) and function parameter labels (funcName(lbl:))
	const abbrNames = /(?:btn|lbl|mgr|ctl|cfg|img|msg|req|res|vc|tbl|nav|bg|fg)\w*/;
	const abbrPattern = new RegExp(
		"(?:\\b(?:var|let|func)\\s+\\w*" +
			abbrNames.source +
			"\\b" +
			"|\\(\\s*" +
			abbrNames.source +
			"\\s*:)",
		"i",
	);

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);
		const origLine = originalLines[i];

		if (abbrPattern.test(line)) {
			matches.push({
				line: i + 1,
				text: nonNull(origLine).trim().slice(0, 150),
			});
		}
	}

	return matches;
}

// --- Swift Concurrency Safety (SE-0302, SE-0306, SE-0337) ---

/**
 * Detect Task.detached usage — almost always wrong, breaks structured concurrency.
 * Apple docs: "Prefer Task {} or TaskGroup for structured concurrency."
 */
export function checkSwiftTaskDetached(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\bTask\s*\.\s*detached\s*[({]/, 10);
}

/** Net brace-depth change contributed by a single (comment-stripped) line. */
function braceDeltaForLine(line: string): number {
	let delta = 0;
	for (const ch of line) {
		if (ch === "{") delta++;
		if (ch === "}") delta--;
	}
	return delta;
}

/** Is there a `catch` on a line strictly after `fromIndex`, within `bound`? */
function hasCatchAfter(strippedLines: string[], fromIndex: number, bound: number): boolean {
	for (let k = fromIndex + 1; k < bound; k++) {
		if (/\bcatch\b/.test(nonNull(strippedLines[k]))) return true;
	}
	return false;
}

/**
 * Scan a Task body starting at `startIndex` (up to 30 lines, brace-depth
 * bounded) for a `try` that is never wrapped in its own `do`/`catch`.
 */
function taskBodyHasUnhandledTry(strippedLines: string[], startIndex: number): boolean {
	const bound = Math.min(startIndex + 30, strippedLines.length);
	let depth = 0;
	let hasTry = false;
	let hasDoCatch = false;
	for (let j = startIndex; j < bound; j++) {
		const bodyLine = nonNull(strippedLines[j]);
		depth += braceDeltaForLine(bodyLine);
		if (/\btry\b/.test(bodyLine) && !/\btry[?!]/.test(bodyLine)) hasTry = true;
		if (/\bdo\s*\{/.test(bodyLine) && hasCatchAfter(strippedLines, j, bound)) hasDoCatch = true;
		if (depth <= 0 && j > startIndex) break;
	}
	return hasTry && !hasDoCatch;
}

/**
 * Detect unhandled errors in Task closures — errors silently swallowed.
 * Pattern: Task { try ... } without a do/catch inside.
 */
export function checkSwiftUnhandledTaskError(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);

		// Match Task { or Task.detached { on this line
		if (!/\bTask\s*(?:\.\s*detached\s*)?\{/.test(line)) continue;

		if (taskBodyHasUnhandledTry(strippedLines, i)) {
			matches.push({
				line: i + 1,
				text: nonNull(originalLines[i]).trim().slice(0, 150),
			});
		}
	}

	return matches;
}

// Zero-or-more modifiers (access levels, `static`/`final`, and Swift 6's
// `nonisolated` / `nonisolated(unsafe)`) that may precede a file-scope
// `var`/`let`. Kept as one shared fragment so the declaration match and the
// let-skip stay in lockstep — a bare `var` (no modifier at all) still
// matches because the group is repeated zero-or-more times.
const SWIFT_DECL_MODIFIER =
	"(?:public|internal|fileprivate|private|open|package|static|final|nonisolated(?:\\([^)]*\\))?)\\s+";
const SWIFT_FILE_SCOPE_VAR_RE = new RegExp(`^\\s*(?:${SWIFT_DECL_MODIFIER})*var\\s+\\w`);
const SWIFT_FILE_SCOPE_LET_RE = new RegExp(`^\\s*(?:${SWIFT_DECL_MODIFIER})*let\\s`);

// Processes one stripped line for `checkSwiftGlobalVarNoIsolation`: updates brace
// depth, and — for a file-scope mutable `var` with no actor isolation — appends a
// match. Returns the updated brace depth so the caller can carry it to the next line.
function processSwiftGlobalVarLine(
	i: number,
	strippedLines: string[],
	originalLines: string[],
	braceDepth: number,
	matches: InlineMatch[],
): number {
	const line = nonNull(strippedLines[i]);

	for (const ch of line) {
		if (ch === "{") braceDepth++;
		if (ch === "}") braceDepth--;
	}

	// Only check file-scope (depth 0) var declarations
	if (braceDepth !== 0) return braceDepth;

	// Match: var identifier (at file scope), with zero or more modifiers
	if (!SWIFT_FILE_SCOPE_VAR_RE.test(line)) return braceDepth;
	// Skip if it has @MainActor or other actor isolation
	if (/@\w*Actor\b/.test(line) || /@\w*Actor\b/.test(nonNull(strippedLines[Math.max(0, i - 1)])))
		return braceDepth;
	// Skip let (immutable is fine)
	if (SWIFT_FILE_SCOPE_LET_RE.test(line)) return braceDepth;

	matches.push({
		line: i + 1,
		text: nonNull(originalLines[i]).trim().slice(0, 150),
	});

	return braceDepth;
}

/**
 * Detect global mutable variables without actor isolation in Swift.
 * Swift 6: Global `var` must be isolated to a global actor or be Sendable.
 */
export function checkSwiftGlobalVarNoIsolation(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Track brace depth to identify file-scope declarations
	let braceDepth = 0;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		braceDepth = processSwiftGlobalVarLine(i, strippedLines, originalLines, braceDepth, matches);
	}

	return matches;
}

/**
 * Detect self captured in escaping closures without capture list.
 * Apple Swift Book: "Use a capture list when referencing self in an escaping closure."
 */
export function checkSwiftSelfInEscapingClosure(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);

		// Match @escaping closure parameter declarations
		if (!/@escaping/.test(line)) continue;

		// Scan forward for closure body containing self. without [weak self] or [unowned self]
		for (let j = i; j < Math.min(i + 20, strippedLines.length); j++) {
			const scanLine = nonNull(strippedLines[j]);
			if (/\[\s*(?:weak|unowned)\s+self\s*\]/.test(scanLine)) break;
			if (/\bself\./.test(scanLine) && j > i) {
				matches.push({
					line: j + 1,
					text: nonNull(originalLines[j]).trim().slice(0, 150),
				});
				break;
			}
		}
	}

	return matches;
}

// --- Swift Performance Checks ---

/**
 * Detect .filter { ... }.count in Swift — allocates throwaway array just to count.
 * Use .count(where:) instead (available since Swift 5+).
 */
export function checkSwiftFilterCount(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\.filter\s*\{[^}]*\}\s*\.count\b/, 10);
}

export { parseEnvDocumentation } from "./swift-env-doc-fs.js";
