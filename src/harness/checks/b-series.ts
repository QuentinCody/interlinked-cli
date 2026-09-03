// B-Series PostToolUse inline checks.
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import { getExtension, type InlineMatch, isTestFile, stripCommentsAndStrings } from "./shared.js";

export {
	checkHardcodedCredentials,
	checkInfiniteRecursion,
	checkSuppressionDensity,
} from "./b-series-credentials.js";
export { checkFloatEquality, checkParseIntRadix } from "./b-series-numeric.js";

// ===========================================
// B-Series PostToolUse Inline Checks
// ===========================================

/**
 * True when `trimmed` is a return/throw line that hasn't actually completed
 * on this line — it ends with an open bracket/operator, or lacks a
 * terminating `;` — so it's a multi-line continuation, not a finished
 * statement. Non-return/throw lines (break/continue) are never incomplete.
 */
function isIncompleteReturnOrThrow(trimmed: string): boolean {
	if (!/^return\b/.test(trimmed) && !/^throw\b/.test(trimmed)) return false;
	// Skip if line ends with open paren/bracket/brace/comma/operator (multi-line)
	if (/[([{,+\-|&?:]$/.test(trimmed)) return true;
	// Skip if line doesn't end with ; (statement continues on next line)
	return !trimmed.endsWith(";");
}

/**
 * Look at the first non-empty line after `i` (bounded to i+1..i+3) and decide
 * whether it's unreachable code following the control-flow statement at `i`.
 * Returns null when the next statement closes a block, is a case/default
 * label, or sits at a shallower indent than `indent`.
 */
function findUnreachableMatch(
	lines: string[],
	strippedLines: string[],
	i: number,
	indent: number,
): InlineMatch | null {
	for (let j = i + 1; j < strippedLines.length && j <= i + 3; j++) {
		const strippedLineJ = nonNull(strippedLines[j]);
		const nextTrimmed = strippedLineJ.trim();
		if (!nextTrimmed) continue;
		// Closing brace is fine
		if (nextTrimmed === "}" || nextTrimmed === "};") return null;
		// Case/default labels are fine
		if (/^(case\s|default\s*:)/.test(nextTrimmed)) return null;
		const nextIndent = strippedLineJ.search(/\S/);
		if (nextIndent >= indent) {
			return { line: j + 1, text: nonNull(lines[j]).trim().slice(0, 150) };
		}
		return null;
	}
	return null;
}

/**
 * Detect unreachable code after return/throw/break/continue.
 * Non-empty lines at the same or deeper indent level after a control flow statement.
 * Returns up to 10 matches.
 */
export function checkUnreachableCode(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];
	// Skip .d.ts files — property names like `return?:` are not control flow
	if (filePath.endsWith(".d.ts")) return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length - 1; i++) {
		if (matches.length >= 10) break;
		const strippedLineI = nonNull(strippedLines[i]);
		const trimmed = strippedLineI.trim();
		// Match return/throw/break/continue that end a statement
		if (!/^(return\b|throw\b|break\s*;|continue\s*;)/.test(trimmed)) continue;

		// Skip property declarations in interfaces/objects (e.g., `return?: Handler`)
		if (/^return\s*[?:]/.test(trimmed)) continue;

		// Skip multi-line statements — a return/throw that doesn't end with ; or
		// that ends with ( , { [ + is a continuation, not a completed statement.
		// Only flag when the statement clearly terminates on this line.
		if (isIncompleteReturnOrThrow(trimmed)) continue;

		// Get indent level of current line
		const indent = strippedLineI.search(/\S/);
		if (indent < 0) continue;
		// Check next non-empty line
		const match = findUnreachableMatch(lines, strippedLines, i, indent);
		if (match) matches.push(match);
	}

	return matches;
}

/**
 * Detect empty catch blocks that silently swallow errors.
 * `catch (e) {}` or `catch {}` with no content.
 */
export function checkSilentCatch(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const pattern = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/;
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (!pattern.test(nonNull(strippedLines[i]))) continue;
		// Check the original (pre-strip) line: if the catch block has a comment
		// between the braces, it's an intentional empty catch — don't flag it.
		// e.g. catch (e) { /* expected */ } or catch { // optional }
		const original = nonNull(originalLines[i]);
		if (/\bcatch\s*(?:\([^)]*\))?\s*\{[^}]*(?:\/\/|\/\*)/.test(original)) continue;
		// Also check the next line for a comment inside the catch block
		if (i + 1 < originalLines.length && /^\s*(\/\/|\/\*)/.test(nonNull(originalLines[i + 1]))) {
			// Multi-line catch with comment body: catch (e) {\n  // reason\n}
			if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/.test(nonNull(originalLines[i]))) continue;
		}
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}

	return matches;
}

/**
 * Net change in brace depth contributed by one source line (naive
 * char-by-char count — deliberately does not strip string/comment content,
 * matching the pre-extraction behavior this helper was pulled from).
 */
function braceCountDelta(line: string): number {
	let delta = 0;
	for (const ch of line) {
		if (ch === "{") delta++;
		if (ch === "}") delta--;
	}
	return delta;
}

/** Scan state for one `it(`/`test(` block being walked line by line. */
interface TestBlockScanState {
	inTestBlock: boolean;
	testStartLine: number;
	braceDepth: number;
	hasAssertion: boolean;
	testName: string;
}

/** True when the line carries an assertion in any supported flavour. */
function lineHasAssertion(trimmed: string): boolean {
	return (
		/\b(expect|assert)\s*\(/.test(trimmed) ||
		/\.should\./.test(trimmed) ||
		/\bthrows\s*\(/.test(trimmed)
	);
}

/** Open a test block on `state` when the line starts one; otherwise leave `state` alone. */
function tryEnterTestBlock(line: string, lineIndex: number, state: TestBlockScanState): void {
	const trimmed = line.trim();
	if (!/^(?:it|test)\s*\(/.test(trimmed)) return;
	state.inTestBlock = true;
	state.testStartLine = lineIndex;
	state.hasAssertion = false;
	state.testName = trimmed.slice(0, 80);
	// Count braces on the opening line (arrow function body brace)
	state.braceDepth = braceCountDelta(line);
}

/**
 * Detect test blocks without assertions.
 * `it(` or `test(` blocks without `expect(`, `assert(`, or `.should.`.
 * Only runs on test files.
 */
export function checkAssertionFreeTests(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");
	const state: TestBlockScanState = {
		inTestBlock: false,
		testStartLine: 0,
		braceDepth: 0,
		hasAssertion: false,
		testName: "",
	};

	for (let i = 0; i < lines.length; i++) {
		const line = nonNull(lines[i]);

		if (!state.inTestBlock) {
			tryEnterTestBlock(line, i, state);
			continue;
		}

		// Count braces
		state.braceDepth += braceCountDelta(line);

		// Check for assertions
		if (lineHasAssertion(line.trim())) {
			state.hasAssertion = true;
		}

		// End of test block
		if (state.braceDepth <= 0 && i > state.testStartLine) {
			if (!state.hasAssertion && matches.length < 10) {
				matches.push({
					line: state.testStartLine + 1,
					text: state.testName,
				});
			}
			state.inTestBlock = false;
		}
	}

	return matches;
}

/**
 * Detect trivial/tautological assertions that pass without testing anything meaningful.
 * Examples: expect(true).toBe(true), expect(1).toBe(1), expect("a").toEqual("a")
 * These are a gaming vector — the test has assertions but asserts nothing about the code.
 */
export function checkTrivialAssertions(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const trimmed = nonNull(lines[i]).trim();

		// Match expect(LITERAL).toBe(LITERAL) or .toEqual(LITERAL) where both literals are identical
		const m = trimmed.match(
			/expect\(\s*(true|false|null|undefined|\d+|'[^']*'|"[^"]*")\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\(\s*(true|false|null|undefined|\d+|'[^']*'|"[^"]*")\s*\)/,
		);
		if (m) {
			const left = nonNull(m[1]).replace(/['"]/g, "");
			const right = nonNull(m[2]).replace(/['"]/g, "");
			if (left === right) {
				matches.push({
					line: i + 1,
					text: `Tautological assertion: expect(${m[1]}).toBe(${m[2]}) always passes. Assert on actual code behavior instead.`,
				});
			}
		}

		// Match expect(true), expect(false) with .toBeTruthy/.toBeFalsy
		if (/expect\(\s*true\s*\)\.toBeTruthy\(\)/.test(trimmed)) {
			matches.push({
				line: i + 1,
				text: "Tautological assertion: expect(true).toBeTruthy() always passes.",
			});
		}
		if (/expect\(\s*false\s*\)\.toBeFalsy\(\)/.test(trimmed)) {
			matches.push({
				line: i + 1,
				text: "Tautological assertion: expect(false).toBeFalsy() always passes.",
			});
		}

		// Match assert(true), assert.ok(true)
		if (
			/\bassert\s*\(\s*true\s*\)/.test(trimmed) ||
			/\bassert\.ok\s*\(\s*true\s*\)/.test(trimmed)
		) {
			matches.push({
				line: i + 1,
				text: "Tautological assertion: assert(true) always passes.",
			});
		}
	}

	return matches;
}

/**
 * Detect synchronous filesystem calls inside async functions.
 * `readFileSync`, `writeFileSync`, etc. inside async functions.
 */
interface SyncIoScanState {
	inAsyncFn: boolean;
	braceDepth: number;
}

/** Process one line of the sync-io-in-async scan, mutating `state` and `matches` in place. */
function scanLineForSyncIoInAsync(
	line: string,
	lineIndex: number,
	state: SyncIoScanState,
	matches: InlineMatch[],
): void {
	// Track async function entry
	if (/\basync\s+(function|\()/.test(line) || /=\s*async\s*(\(|[^=])/.test(line)) {
		state.inAsyncFn = true;
		state.braceDepth = 0;
	}

	if (state.inAsyncFn) {
		state.braceDepth += braceCountDelta(line);
		if (state.braceDepth <= 0 && lineIndex > 0) {
			state.inAsyncFn = false;
		}
	}

	if (
		state.inAsyncFn &&
		/\b(readFileSync|writeFileSync|appendFileSync|mkdirSync|readdirSync|statSync|existsSync|unlinkSync|rmdirSync|renameSync|copyFileSync)\s*\(/.test(
			line,
		)
	) {
		matches.push({
			line: lineIndex + 1,
			text: line.trim().slice(0, 150),
		});
	}
}

export function checkSyncIoInAsync(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");
	const state: SyncIoScanState = { inAsyncFn: false, braceDepth: 0 };

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(lines[i]);
		scanLineForSyncIoInAsync(line, i, state, matches);
	}

	return matches;
}
