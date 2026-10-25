// C/C++ checks (unsafe functions, include guards, sprintf, malloc checks).
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import { getExtension, type InlineMatch, isTestFile, stripCommentsAndStrings } from "./shared.js";

// ===========================================
// C/C++ Checks
// ===========================================

const C_CPP_EXTENSIONS = new Set([".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"]);
const C_HEADER_EXTENSIONS = new Set([".h", ".hpp", ".hxx"]);
/** C-only (not C++ where `new` is standard) */
const C_ONLY_EXTENSIONS = new Set([".c", ".h"]);

function isCFile(filePath: string): boolean {
	return C_CPP_EXTENSIONS.has(getExtension(filePath));
}

/**
 * True when the match is really the bounded variant (strncpy, strncat, snprintf):
 * the unsafe pattern matches their tail, so the preceding character decides.
 */
function isBoundedStringVariant(line: string, m: RegExpExecArray): boolean {
	const funcName = m[1];
	if (funcName !== "strcpy" && funcName !== "strcat" && funcName !== "sprintf") return false;
	const charBefore = m.index > 0 ? line[m.index - 1] : "";
	return charBefore === "n";
}

/**
 * Keywords that can directly precede a call expression. Any other identifier
 * (or a `*`) directly before the function name is a declarator type, so the
 * line is the libc prototype or definition, not a call.
 */
const CALL_PRECEDING_KEYWORDS = new Set([
	"return",
	"else",
	"case",
	"do",
	"throw",
	"co_return",
	"co_yield",
	"co_await",
	"and",
	"or",
	"not",
]);

/**
 * True when the name at `nameIndex` cannot be the libc function:
 * - a member access (`buf.sprintf(`, `fops->gets(`) is a method or a
 *   function-pointer field;
 * - a namespace other than `std` (`fmt::sprintf(`, `tfm::sprintf(`) is a
 *   different, usually bounded, function;
 * - a type token or `*` directly before the name is a prototype or definition
 *   line (`extern char *strcpy(char *, const char *);`) in a libc tree.
 * `std::sprintf(`, `::sprintf(`, `return sprintf(` and `x = sprintf(` remain calls.
 */
function isNonLibcReference(line: string, nameIndex: number): boolean {
	const before = line.slice(0, nameIndex);
	if (/(?:\.|->)\s*$/.test(before)) return true;
	const namespace = /(\w+)\s*::\s*$/.exec(before);
	if (namespace) return namespace[1] !== "std";
	const declarator = /(\w+|\*)\s*$/.exec(before);
	if (!declarator) return false;
	const token = nonNull(declarator[1]);
	return token === "*" || !CALL_PRECEDING_KEYWORDS.has(token);
}

/**
 * Detect unsafe C functions: strcpy, strcat, gets, sprintf, stpcpy, vsprintf.
 * These have no bounds checking and are common sources of buffer overflows.
 */
export function checkCUnsafeFunctions(content: string, filePath: string): InlineMatch[] {
	if (!isCFile(filePath)) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const unsafePattern = /\b(strcpy|strcat|gets|sprintf|stpcpy|vsprintf)\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);
		const m = unsafePattern.exec(line);
		if (!m) continue;
		// Ensure we didn't match the safe variant (strncpy, strncat, snprintf)
		if (isBoundedStringVariant(line, m)) continue;
		if (isNonLibcReference(line, m.index)) continue;
		matches.push({
			line: i + 1,
			text: nonNull(originalLines[i]).trim().slice(0, 150),
		});
	}

	return matches;
}

/**
 * Strip C block and line comments, keeping newlines so line-anchored regexes
 * still work. `stripCommentsAndStrings` cannot be used here: it treats a `#`
 * line as a Python comment and would erase every preprocessor directive.
 */
function stripCComments(content: string): string {
	return content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "");
}

/** True when the header carries a once-directive or a traditional guard pair. */
function hasHeaderGuard(content: string): boolean {
	if (/^\s*#\s*pragma\s+once\b/m.test(content)) return true;
	if (/^\s*_Pragma\s*\(\s*"once"\s*\)/m.test(content)) return true;
	const hasOpen = /^\s*#\s*(?:ifndef\b|if\s*!\s*defined\b)/m.test(content);
	return hasOpen && /^\s*#\s*define\b/m.test(content);
}

/**
 * True when the header is designed for repeated inclusion, so a guard would be
 * wrong: an X-macro contract (`#ifndef X` answered by `#error`, or `#undef X`
 * after `X(...)` rows) or a one-sided `#pragma pack(push|pop)` wrapper
 * (`pshpack1.h` / `poppack.h`).
 */
function isMultipleInclusionHeader(stripped: string): boolean {
	if (/^\s*#\s*ifndef\s+\w+\s*\n\s*#\s*error\b/m.test(stripped)) return true;
	const undef = /^\s*#\s*undef\s+(\w+)/m.exec(stripped);
	if (undef && new RegExp(`^\\s*${nonNull(undef[1])}\\s*\\(`, "m").test(stripped)) return true;
	const push = /^\s*#\s*pragma\s+pack\s*\(\s*push\b/m.test(stripped);
	const pop = /^\s*#\s*pragma\s+pack\s*\(\s*pop\b/m.test(stripped);
	return push !== pop;
}

/** Objective-C headers rely on `#import` once-semantics; Xcode emits no guard. */
function isObjectiveCHeader(stripped: string): boolean {
	return /^\s*(?:#\s*import\b|@(?:interface|protocol|implementation|class|end)\b)/m.test(stripped);
}

/**
 * Detect header files missing #pragma once or #ifndef/#define include guard.
 */
export function checkCIncludeGuard(content: string, filePath: string): InlineMatch[] {
	if (!C_HEADER_EXTENSIONS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	// Use original content (not stripped) — preprocessor directives start with #
	// which stripCommentsAndStrings treats as Python comments
	if (hasHeaderGuard(content)) return [];
	const stripped = stripCComments(content);
	if (stripped.trim() === "") return []; // comment-only placeholder: nothing to guard
	if (isMultipleInclusionHeader(stripped)) return [];
	if (isObjectiveCHeader(stripped)) return [];

	return [
		{
			line: 1,
			text: "header file missing #pragma once or #ifndef/#define include guard",
		},
	];
}

/**
 * Detect strcmp/strncmp return value used as boolean without comparison operator.
 * `if (strcmp(a, b))` is true when strings are NOT equal — a common C bug.
 * `if (!strcmp(a, b))` and `if (strcmp(a, b) == 0)` are correct idioms.
 */
export function checkCStrcmpBooleanMisuse(content: string, filePath: string): InlineMatch[] {
	if (!isCFile(filePath)) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Match: if (strcmp(...)) or while (strcmp(...)) — without !, ==, !=, <, > around it
	// We look for `if/while` followed by `(` then `str[n]cmp(` with no `!` prefix,
	// and the line must not contain `== 0`, `!= 0`, `< 0`, `> 0` after the strcmp call.
	const callPattern = /\b(if|while)\s*\(\s*str[n]?cmp\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);
		if (!callPattern.test(line)) continue;
		// Skip if there's a negation: if (!strcmp(...))
		if (/\b(if|while)\s*\(\s*!\s*str[n]?cmp/.test(line)) continue;
		// Skip if there's a comparison operator after the call
		if (/str[n]?cmp\s*\([^)]*\)\s*(==|!=|<|>|<=|>=)/.test(line)) continue;
		matches.push({
			line: i + 1,
			text: nonNull(originalLines[i]).trim().slice(0, 150),
		});
	}

	return matches;
}

/**
 * True when one of the 3 lines after the allocation null-checks `varName`.
 * Common null-check patterns: if (!ptr), if (ptr == NULL), if (ptr != NULL), if (ptr).
 */
function hasNullCheckAfterAlloc(
	strippedLines: string[],
	allocIndex: number,
	varName: string,
): boolean {
	const lookAhead = Math.min(allocIndex + 4, strippedLines.length);
	for (let j = allocIndex + 1; j < lookAhead; j++) {
		const ahead = nonNull(strippedLines[j]);
		if (!ahead.includes(varName)) continue;
		if (/\b(if|assert)\s*\(/.test(ahead) || /==\s*NULL|!=\s*NULL/.test(ahead)) return true;
	}
	return false;
}

/**
 * Detect malloc/calloc/realloc calls where the return value is not null-checked
 * within the next 3 lines. C-only (not C++ where `new` is standard).
 */
export function checkCUncheckedMalloc(content: string, filePath: string): InlineMatch[] {
	if (!C_ONLY_EXTENSIONS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const allocPattern = /(\w+)\s*=\s*(?:malloc|calloc|realloc)\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const m = allocPattern.exec(nonNull(strippedLines[i]));
		if (!m) continue;
		const varName = nonNull(m[1]);
		// Only match simple C identifiers to avoid regex injection
		if (!/^\w+$/.test(varName)) continue;
		// Look ahead 3 lines for a null check on this variable
		if (hasNullCheckAfterAlloc(strippedLines, i, varName)) continue;
		matches.push({
			line: i + 1,
			text: nonNull(originalLines[i]).trim().slice(0, 150),
		});
	}

	return matches;
}

/**
 * Detect sprintf() usage — should use snprintf() for bounds-safe formatting.
 */
export function checkCSprintfUsage(content: string, filePath: string): InlineMatch[] {
	if (!isCFile(filePath)) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	// Match sprintf( but not snprintf(
	const pattern = /\bsprintf\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);
		if (!pattern.test(line)) continue;
		// Ensure it's not snprintf by checking the char before 'sprintf'
		const idx = line.search(/\bsprintf\s*\(/);
		if (idx > 0 && line[idx - 1] === "n") continue;
		if (isNonLibcReference(line, idx)) continue;
		matches.push({
			line: i + 1,
			text: nonNull(originalLines[i]).trim().slice(0, 150),
		});
	}

	return matches;
}
