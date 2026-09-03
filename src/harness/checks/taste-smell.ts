// Taste checks — part 2 of 2 (magic numbers, ternaries, flag args, commented-out code).
// Extracted from taste.ts to stay under the 800-line module ceiling.

import { nonNull } from "../../lib/non-null.js";
import {
	collectFunctionSignature,
	getExtension,
	type InlineMatch,
	isTestFile,
	stripCommentsAndStrings,
} from "./shared.js";
import { ifBlockHasMatchingElse, maxTernaryNestingDepth } from "./taste-smell-scanners.js";

export { checkSameTypedPrimitiveParams } from "./taste-smell-same-typed-params.js";

/**
 * Detect magic numbers in logic — numeric literals without named constants.
 * `if (retries > 3)` — why 3? `setTimeout(fn, 86400000)` — what is that?
 *
 * Only flags numbers in conditionals and expressions, not declarations.
 * Skips: 0, 1, -1, 2, common HTTP status codes, powers of 2, test files,
 * array indices, and numbers in const/enum declarations.
 */
export function checkMagicNumbers(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Numbers that are universally acceptable without a name
	const ALLOWED = new Set([
		"0",
		"1",
		"2",
		"-1",
		"-2",
		"10",
		"16",
		"100",
		"1000",
		// HTTP status codes
		"200",
		"201",
		"204",
		"301",
		"302",
		"304",
		"400",
		"401",
		"403",
		"404",
		"405",
		"409",
		"422",
		"429",
		"500",
		"502",
		"503",
		"504",
		// Powers of 2
		"8",
		"32",
		"64",
		"128",
		"256",
		"512",
		"1024",
		"2048",
		"4096",
	]);

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);
		if (!isMagicNumberContext(line.trim())) continue;
		if (!lineHasBareMagicNumber(line, ALLOWED)) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}

	return matches;
}

/**
 * True when a stripped, trimmed line is the kind of line a magic number can hide
 * in: not a declaration (the number IS the named constant), not a bare-number
 * `return` (often intentional), not a `case` label, and carrying a conditional,
 * an operator, or a call.
 */
function isMagicNumberContext(trimmed: string): boolean {
	if (/^\s*(const|let|var|enum|static\s+(readonly\s+)?)\b/.test(trimmed)) return false;
	if (/^\s*return\s+-?\d/.test(trimmed)) return false;
	if (/^\s*case\s+-?\d/.test(trimmed)) return false;
	return (
		/\b(if|else|while|for|switch|&&|\|\||[<>=!]+|[+\-*/%])\b/.test(trimmed) ||
		/\w+\s*\(/.test(trimmed)
	);
}

/**
 * True when the line carries a bare numeric literal that is neither on the
 * allow-list nor an array index (`[123]`).
 */
function lineHasBareMagicNumber(line: string, allowed: Set<string>): boolean {
	const numPattern = /(?<![.\w])(-?\d+(?:\.\d+)?)\b/g;
	for (const numMatch of line.matchAll(numPattern)) {
		const num = nonNull(numMatch[1]);
		if (allowed.has(num)) continue;
		const before = line.slice(Math.max(0, numMatch.index - 1), numMatch.index);
		if (before === "[") continue;
		return true;
	}
	return false;
}

/**
 * Detect `if (!condition) { ... } else { ... }` — negated condition with else.
 * The reader must mentally double-negate. Just flip the branches.
 *
 * Only flags simple negation of a single identifier (not complex expressions).
 * Skips: if blocks without else, complex negated expressions like !(a && b).
 */
export function checkNegatedConditionWithElse(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);

		// Match: if (!identifier) or if (!identifier.property)
		if (!/\bif\s*\(\s*!\s*\w+[\w.]*\s*\)/.test(line)) continue;

		// Must have a corresponding else — scan ahead for } else
		if (!ifBlockHasMatchingElse(strippedLines, i)) continue;

		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}

	return matches;
}

/**
 * Detect nested ternary expressions.
 * `a ? b ? c : d : e` is a puzzle, not code.
 * Use if/else or extract into a function.
 */
export function checkNestedTernary(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];

		// Quick check: line must have at least 2 question marks
		const qCount = (nonNull(line).match(/\?/g) || []).length;
		if (qCount < 2) continue;

		// Verify nesting: walk through and track ternary depth
		const maxTernaryDepth = maxTernaryNestingDepth(nonNull(line));

		if (maxTernaryDepth >= 2) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}

	return matches;
}

/**
 * Detect function signatures with 2+ boolean parameters.
 * Definition-side companion to checkBooleanTrap (which catches call sites).
 *
 * When a function has multiple boolean params, callers will always pass
 * unlabeled `true`/`false`. Use an options object instead.
 *
 * Only runs on TypeScript (requires type annotations to detect boolean params).
 * Skips test files.
 */
export function checkFlagArguments(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	// Only TS — need type annotations to detect boolean params reliably
	if (![".ts", ".tsx", ".mts", ".cts"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = nonNull(lines[i]).trim();
		if (!declaredFunctionName(trimmed)) continue;

		// Collect the full signature, then count `: boolean` params in it
		const boolParamCount = countBooleanParams(collectFunctionSignature(lines, i));
		if (boolParamCount < 2) continue;

		matches.push({
			line: i + 1,
			text: `[${boolParamCount} boolean params → use options object] ${nonNull(originalLines[i]).trim().slice(0, 100)}`,
		});
	}

	return matches;
}

const FUNC_DECL_PATTERNS = [
	/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
	/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/,
];

/** The function name a trimmed line declares, or null when it declares none. */
function declaredFunctionName(trimmed: string): string | null {
	for (const pat of FUNC_DECL_PATTERNS) {
		const m = trimmed.match(pat);
		if (m) return nonNull(m[1]);
	}
	return null;
}

/**
 * Count params carrying a `: boolean` type annotation in a collected signature.
 * A signature with no parseable parameter list counts zero — same effect as the
 * caller skipping the line.
 */
function countBooleanParams(sig: string): number {
	const paramMatch = sig.match(/\(([^)]*)\)/);
	if (!paramMatch) return 0;
	let boolParamCount = 0;
	// Match: paramName: boolean or paramName?: boolean
	for (const p of nonNull(paramMatch[1]).split(",")) {
		if (/:\s*boolean\s*(?:[,=)]|$)/.test(p)) boolParamCount++;
	}
	return boolParamCount;
}

/**
 * Classify a single uncommented line (comment prefix already stripped).
 *
 * Returns:
 *   - "code": an actual executable statement someone disabled — a real
 *     keyword statement, an assignment with a real value, a bare call,
 *     a closing/opening brace of such a statement, a block terminator.
 *   - "doc": prose or illustrative content — words, type unions (`|`),
 *     `<placeholder>` brackets, bare `key: type` annotations, `...`
 *     ellipsis used as prose, parentheticals like `(e.g. ...)`. The
 *     presence of *any* doc line vetoes the whole block.
 *   - "neutral": blank, a divider, or a line that is neither — does not
 *     count toward the code ratio either way.
 *
 * The detector fires only on a strong majority of "code" lines with zero
 * "doc" lines, so it can never flag a documentation comment, an ASCII
 * diagram, or an illustrative type/shape example.
 */
function classifyCommentLine(raw: string, isPython = false): "code" | "doc" | "neutral" {
	const line = raw.trim();
	if (line === "") return "neutral";

	// Divider / ASCII-art lines — pure punctuation runs, no real tokens.
	if (/^[=\-*~_#+.|/\\<>\s]+$/.test(line)) return "neutral";

	// --- Doc markers (any one of these vetoes the block) ---------------
	if (isDocMarkerLine(line, isPython)) return "doc";

	// --- Real-code markers ---------------------------------------------

	// Statement keywords at the start of the line.
	if ((isPython ? PY_STATEMENT_KEYWORDS : JS_STATEMENT_KEYWORDS).test(line)) return "code";

	if (isPython) return isPythonCodeLine(line) ? "code" : "neutral";
	return isJsCodeLine(line) ? "code" : "neutral";
}

/** True when the line carries any documentation marker (vetoes the block). */
function isDocMarkerLine(line: string, isPython: boolean): boolean {
	// Type unions / pipe-separated alternatives (`a | b | c`, `string | null`).
	// Real code rarely puts ` | ` mid-line outside a type position; doc shape
	// examples use it constantly. (Python bitwise-or is rare in commented code
	// and would still need a doc-free majority elsewhere — acceptable veto.)
	if (/\s\|\s/.test(line)) return true;
	// Angle-bracket placeholders: `<original native event name>`, `<T>` as prose.
	// A `<...>` span containing a space is a natural-language placeholder, not
	// a generic type argument (those have no spaces: `Array<string>`).
	if (/<[^<>]*\s[^<>]*>/.test(line)) return true;
	// Ellipsis used as prose ("...event-specific fields", "etc. ...").
	if (line.includes("...")) return true;
	// Prose parentheticals: "(e.g. ...)", "(see ...)", "(per the design ...)".
	if (/\((?:e\.g\.|i\.e\.|see\b|per\b|note\b|or\b|and\b|matches\b|with\b)/i.test(line))
		return true;
	// A bare `key: type` annotation — illustrative shape line, no value, no
	// terminator. JS/TS only: in Python `:` ends a compound-statement header
	// (`if x:`, `def f():`) which is real code, so skip this veto there.
	// Object-literal entries end in `,` or `{`; `case Foo:` starts with the
	// `case` keyword (caught as code below). Anything left is a bare type
	// annotation → doc.
	return (
		!isPython &&
		/^[A-Za-z_$][\w$]*\s*\??:\s*[A-Za-z_$]/.test(line) &&
		!/[;,{]\s*$/.test(line)
	);
}

const JS_STATEMENT_KEYWORDS =
	/^(const|let|var|function|async\s+function|class|interface|enum|type\s+[A-Za-z]|import|export|return|throw|await|yield|if|else|for|while|do|switch|case\s|default:|try|catch|finally|break|continue|new\s|delete\s)\b/;
const PY_STATEMENT_KEYWORDS =
	/^(def|class|import|from\s|return|raise|yield|await|async\s+def|if|elif|else|for|while|with|try|except|finally|break|continue|pass|global|nonlocal|assert|del|lambda\b)\b/;

/** Python: statements are newline-terminated. */
function isPythonCodeLine(line: string): boolean {
	// An assignment with a real right-hand side: `data = request.json()`, `x = 3`.
	if (/^[\w$.[\]]+\s*[-+*/%|&^]?=\s*\S/.test(line) && !/[=<>!]=\s*$/.test(line)) return true;
	// A bare call statement: `save(data)`, `obj.run(a, b)`.
	return /^[\w$]+(?:\.[\w$]+)*\([^)]*\)\s*$/.test(line);
}

/** JS/TS real-code markers. */
function isJsCodeLine(line: string): boolean {
	// Assignment with a real right-hand side ending in a terminator:
	// `x = foo();`  `this.y = 3;`  `obj.k = "v";`
	if (/^[\w$.[\]]+\s*[-+*/|&^]?=\s*\S.*[;,]\s*$/.test(line)) return true;
	// A bare function/method call statement: `doThing();`  `obj.run(a, b);`
	if (/^[\w$]+(?:\.[\w$]+)*\([^)]*\)\s*;?\s*$/.test(line)) return true;
	// A line that ends in a semicolon and contains a call or assignment — a
	// disabled statement that didn't match the tighter patterns above.
	if (/;\s*$/.test(line) && /[\w$]\s*[=(]/.test(line)) return true;
	// A lone block-closer that belongs to disabled code: `}`, `};`, `});`,
	// `} else {`. A lone `{` is too ambiguous (shape examples open with it),
	// so an opening brace only counts when preceded by code on the same line.
	return /^\}[\s;)]*[,;]?\s*(else\b.*)?$/.test(line);
}

/**
 * Detect blocks of commented-out code (3+ consecutive lines).
 * Commented-out code rots, confuses grep, and makes the real code harder to scan.
 * Use version control instead of comment-preservation.
 *
 * Fires only when a comment block is a strong majority of real executable
 * statements AND contains zero documentation markers. Documentation comments,
 * ASCII diagrams, illustrative type/shape examples, JSDoc blocks, license
 * headers, and prose with incidental code-like punctuation are never flagged.
 */
export function checkCommentedOutCode(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".py"].includes(ext))
		return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const isPython = ext === ".py";
	const commentPrefix = isPython ? /^\s*#\s?/ : /^\s*\/\/\s?/;
	const tally: CommentBlockTally = { blockStart: -1, codeLines: 0, totalLines: 0, docLines: 0 };

	for (let i = 0; i <= originalLines.length; i++) {
		if (matches.length >= 5) break;

		const line = i < originalLines.length ? nonNull(originalLines[i]) : "";
		if (commentPrefix.test(line)) tallyCommentLine(line, commentPrefix, isPython, tally, i);
		else flushCommentBlock(tally, matches);
	}

	return matches;
}

/** Running state for one run of consecutive comment lines. */
interface CommentBlockTally {
	blockStart: number;
	codeLines: number;
	totalLines: number;
	docLines: number;
}

// JSDoc/doc-tag and license/header lines are skipped — they never count as code,
// but unlike a "doc" classification they do not by themselves veto the block.
const DOC_TAG_PATTERN =
	/^\s*\/\/\s*(@\w+|@param|@returns|@throws|@example|@see|@todo|TODO|FIXME|NOTE|HACK|XXX)\b/i;
const LICENSE_PATTERN = /^\s*\/\/\s*(copyright|license|MIT|Apache|BSD|GPL|all rights reserved)/i;

/** Fold one comment line into the running tally; the block spans skipped lines. */
function tallyCommentLine(
	line: string,
	commentPrefix: RegExp,
	isPython: boolean,
	tally: CommentBlockTally,
	index: number,
): void {
	if (tally.blockStart === -1) tally.blockStart = index;
	tally.totalLines++;
	if (DOC_TAG_PATTERN.test(line) || LICENSE_PATTERN.test(line)) return;
	const kind = classifyCommentLine(line.replace(commentPrefix, ""), isPython);
	if (kind === "code") tally.codeLines++;
	else if (kind === "doc") tally.docLines++;
}

/**
 * Emit a match for the just-ended block when it qualifies, then reset the tally.
 * Needs 3+ comment lines, 3+ unambiguous code lines, a >60% code ratio, and zero
 * doc lines — one prose/shape line vetoes the block, since a false positive at
 * edit time is especially annoying.
 */
function flushCommentBlock(tally: CommentBlockTally, matches: InlineMatch[]): void {
	const { blockStart, codeLines, totalLines, docLines } = tally;
	tally.blockStart = -1;
	tally.codeLines = 0;
	tally.totalLines = 0;
	tally.docLines = 0;
	if (blockStart === -1 || totalLines < 3 || docLines !== 0) return;
	const codeRatio = totalLines > 0 ? codeLines / totalLines : 0;
	if (codeLines < 3 || codeRatio <= 0.6) return;
	matches.push({
		line: blockStart + 1,
		text: `[${totalLines} lines of commented-out code → use version control instead]`,
	});
}
