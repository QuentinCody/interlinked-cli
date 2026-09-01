// ===========================================
// Inline Language Checks — per-language regex passes
// ===========================================
// Runs the `inline_checks` array declared in each LanguageProfile
// (language-profiles.ts) against a file's content, yielding one
// QualityCheckResult per pattern match. Patterns run after a language-aware
// comment + string stripping pass so matches inside strings and comments
// don't false-positive.
//
// The c_include_guard check is a negative check (absence-of-pattern) and
// uses a sentinel pattern string + dedicated handler — keep it special-cased
// rather than forcing every entry into the positive-match shape.

import { basename, extname } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import type { InlineCheckDef, LanguageId, LanguageProfile } from "../types.js";
import { isLikelyTestFile } from "./test-classifier.js";

interface InlineLangCheckResult {
	name: string;
	severity: "error" | "warning";
	message: string;
	file: string;
	detail: string;
}

const C_INCLUDE_GUARD_SENTINEL = "__C_INCLUDE_GUARD_NEVER_MATCH__";

/**
 * Public API — consumed by quality-checks.runQualityChecks. Exported because
 * the dispatch loop in `quality-checks.ts` invokes this on every Edit/Write
 * event for files whose language profile declares inline_checks.
 */
export function runInlineLanguageChecks(
	filePath: string,
	fileContent: string,
	profile: LanguageProfile,
): InlineLangCheckResult[] {
	if (profile.inline_checks.length === 0) return [];

	const ctx = buildContext(filePath, fileContent, profile);
	if (!ctx) return [];

	const results: InlineLangCheckResult[] = [];
	for (const def of profile.inline_checks) {
		results.push(...runOneDef(def, ctx));
	}
	return results;
}

interface LangCheckContext {
	filePath: string;
	fileContent: string;
	ext: string;
	isTest: boolean;
	strippedLines: string[];
	rawLines: string[];
}

function buildContext(
	filePath: string,
	fileContent: string,
	profile: LanguageProfile,
): LangCheckContext | null {
	const ext = extname(filePath).toLowerCase();
	const baseName = basename(filePath, ext);
	const isTest = isLikelyTestFile(baseName, filePath);
	const stripped = stripForLanguage(fileContent, profile.id);
	return {
		filePath,
		fileContent,
		ext,
		isTest,
		strippedLines: stripped.split("\n"),
		rawLines: fileContent.split("\n"),
	};
}

function runOneDef(def: InlineCheckDef, ctx: LangCheckContext): InlineLangCheckResult[] {
	if (!def.file_types.includes(ctx.ext)) return [];
	if (def.skip_test_files && ctx.isTest) return [];

	// Special-case: absence-of-pattern check for header-guard.
	if (def.pattern === C_INCLUDE_GUARD_SENTINEL) {
		if (headerHasGuard(ctx.fileContent)) return [];
		return [
			{
				name: def.name,
				severity: def.severity,
				message: `${basename(ctx.filePath)}: missing include guard (#pragma once or #ifndef/#define)`,
				file: ctx.filePath,
				detail: def.fix_instruction,
			},
		];
	}

	const re = safeCompile(def.pattern, def.pattern_flags ?? "gm");
	if (!re) return []; // malformed or rejected — skip rather than throw
	const exemptRe = def.exempt_if_line_matches
		? safeCompile(def.exempt_if_line_matches)
		: null;

	const out: InlineLangCheckResult[] = [];
	for (const { lineNum } of findLineMatches(ctx.strippedLines, re)) {
		const rawLine = ctx.rawLines[lineNum - 1] ?? "";
		const prevLine = ctx.rawLines[lineNum - 2];
		if (exemptRe && (exemptRe.test(rawLine) || (prevLine && exemptRe.test(prevLine)))) continue;
		out.push({
			name: def.name,
			severity: def.severity,
			message: `${basename(ctx.filePath)}:${lineNum} — ${def.description}`,
			file: ctx.filePath,
			detail: `  L${lineNum}: ${rawLine.trim().slice(0, 160)}\n  ${def.fix_instruction}`,
		});
	}
	return out;
}

/**
 * Compile a regex from the inline-checks config. Rejects patterns that look
 * vulnerable to catastrophic backtracking — nested quantifiers of the form
 * `(...+)+` / `(...*)+` / `(...+)*` / `(...*)*` catch the classic ReDoS
 * trap without false-positives on well-formed patterns. Patterns in
 * language-profiles.ts are hand-written and auditable; a user who overrides
 * via rules config still passes through this guard.
 *
 * Reason for dynamic RegExp: inline-check configs are, by design, a data-
 * driven table of patterns — the same shape evaluator/rule-matching.ts
 * `getCachedRegex` accepts. Config origin is the admin-authored language
 * profile (trusted), not agent or user content.
 */
function safeCompile(src: string, flags = ""): RegExp | null {
	if (looksLikeReDoS(src)) return null;
	try {
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		return new RegExp(src, flags);
	} catch {
		return null;
	}
}

const NESTED_QUANTIFIER_RE = /\([^)]*[+*][^)]*\)[+*]/;

function looksLikeReDoS(src: string): boolean {
	return NESTED_QUANTIFIER_RE.test(src);
}

function findLineMatches(
	strippedLines: string[],
	re: RegExp,
): Array<{ lineNum: number; lineText: string }> {
	const src = re.source;
	const flagsNoG = re.flags.replace("g", "");
	const out: Array<{ lineNum: number; lineText: string }> = [];
	for (let i = 0; i < strippedLines.length; i++) {
		// Fresh regex per line so `g`-flagged patterns don't carry lastIndex.
		// `src` originates from safeCompile above (already ReDoS-screened).
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		const lineRe = new RegExp(src, flagsNoG);
		const lineText = nonNull(strippedLines[i]);
		if (lineRe.test(lineText)) {
			out.push({ lineNum: i + 1, lineText });
		}
	}
	return out;
}

function headerHasGuard(content: string): boolean {
	if (/\n\s*#\s*pragma\s+once\b/.test(`\n${content}`)) return true;
	// Traditional: `#ifndef FOO` ... `#define FOO`
	if (/\n\s*#\s*ifndef\s+\w+/.test(`\n${content}`)) return true;
	return false;
}

// ===========================================
// Per-language comment + string stripping
// ===========================================
// Each stripper is offset-preserving: replaces comment/string interiors with
// spaces so line and column numbers in match offsets map cleanly to the
// original. Implementations favor correctness on realistic code over full
// coverage of exotic tokenizer corner cases — they only need to handle code
// well enough that a regex probe doesn't false-match text inside a docstring
// or line comment.
//
// Both strippers below (Python and C-style) are small single-pass state
// machines: the outer loop only dispatches on the current mode (one flat
// if/else-if chain, cheap regardless of nesting depth); each mode's actual
// per-character decision lives in its own top-level `step*` function, so none
// of that decision logic is nested inside the loop *and* inside an outer
// mode-check. `blankChar` / `blankEscapeSpan` (shared by both strippers)
// factor out the "replace with a space, but keep real newlines so line
// numbers survive" rule that recurs across every mode.

/** Blank a single character while preserving newline position (keeps line numbers stable). */
function blankChar(ch: string | undefined): string {
	return ch === "\n" ? "\n" : " ";
}

/** Blank a 2-char `\<escaped>` span, preserving position if the escaped char is a newline. */
function blankEscapeSpan(escapedCh: string | undefined): string {
	return escapedCh === "\n" ? "\\\n" : "  ";
}

function stripForLanguage(content: string, lang: LanguageId): string {
	switch (lang) {
		case "python":
			return stripPython(content);
		case "rust":
		case "go":
		case "c_cpp":
		case "java":
		case "swift":
		// GPU / shading languages — all use C-style comments (// and /* */)
		// and double-quoted string literals, so the existing stripCStyle pass
		// works without modification. WGSL also supports nested /* */ block
		// comments per the spec; the current implementation handles the outer
		// pair correctly and trailing nesting is rare enough that it's not
		// worth a dedicated stripper until we ship WGSL-specific checks.
		case "cuda":
		case "opencl":
		case "metal":
		case "hlsl":
		case "wgsl":
			return stripCStyle(content);
		case "typescript":
			// Currently unused — typescript inline_checks is an empty array.
			// Return as-is; callers already have stripAllLiterals for TS paths.
			return content;
		default: {
			// Exhaustiveness assertion: any new LanguageId added in
			// types.ts will trip this as a compile error.
			const _exhaustive: never = lang;
			return _exhaustive;
		}
	}
}

type PyStringDelim = '"' | "'" | '"""' | "'''";

type PyMode =
	| { kind: "code" }
	| { kind: "line" }
	| { kind: "string"; delim: PyStringDelim };

interface PyStep {
	/** Text to append to the output, preserving offsets. */
	text: string;
	/** Characters of `content` this step consumes. */
	consumed: number;
	mode: PyMode;
}

function pyStepLineMode(ch: string | undefined): PyStep {
	if (ch === "\n") return { text: "\n", consumed: 1, mode: { kind: "code" } };
	return { text: " ", consumed: 1, mode: { kind: "line" } };
}

function pyStepStringMode(
	ch: string | undefined,
	next3: string,
	nextCh: string | undefined,
	delim: PyStringDelim,
	hasNext: boolean,
): PyStep {
	if (delim.length === 3 && next3 === delim) {
		return { text: "   ", consumed: 3, mode: { kind: "code" } };
	}
	if (delim.length === 1 && ch === delim) {
		return { text: nonNull(ch), consumed: 1, mode: { kind: "code" } };
	}
	if (ch === "\\" && hasNext) {
		// Preserve newline positions; blank otherwise.
		return { text: blankEscapeSpan(nextCh), consumed: 2, mode: { kind: "string", delim } };
	}
	return { text: blankChar(ch), consumed: 1, mode: { kind: "string", delim } };
}

function pyStepCodeMode(ch: string | undefined, next3: string): PyStep {
	if (ch === "#") return { text: " ", consumed: 1, mode: { kind: "line" } };
	if (next3 === '"""' || next3 === "'''") {
		return { text: next3, consumed: 3, mode: { kind: "string", delim: next3 } };
	}
	if (ch === '"' || ch === "'") {
		return { text: ch, consumed: 1, mode: { kind: "string", delim: ch } };
	}
	return { text: nonNull(ch), consumed: 1, mode: { kind: "code" } };
}

/** Strip Python comments (#) and string literals (single, double, triple-quoted). */
function stripPython(content: string): string {
	const out: string[] = [];
	let i = 0;
	const n = content.length;
	let mode: PyMode = { kind: "code" };

	while (i < n) {
		const ch = content[i];
		const next3 = content.slice(i, i + 3);
		let step: PyStep;
		if (mode.kind === "line") {
			step = pyStepLineMode(ch);
		} else if (mode.kind === "string") {
			step = pyStepStringMode(ch, next3, content[i + 1], mode.delim, i + 1 < n);
		} else {
			step = pyStepCodeMode(ch, next3);
		}
		out.push(step.text);
		i += step.consumed;
		mode = step.mode;
	}

	return out.join("");
}

// Strip C-style single-line (//) + block (/* */) comments and quoted strings.
// Same small state-machine shape as stripPython above (see the shared comment
// there); this stripper adds a fourth mode ("block") for /* */ comments.

type CStyleMode =
	| { kind: "code" }
	| { kind: "line" }
	| { kind: "block" }
	| { kind: "string"; delim: '"' | "'" | "`" };

interface CStyleStep {
	/** Text to append to the output, preserving offsets. */
	text: string;
	/** Characters of `content` this step consumes. */
	consumed: number;
	mode: CStyleMode;
}

function stepLineMode(ch: string | undefined): CStyleStep {
	if (ch === "\n") return { text: "\n", consumed: 1, mode: { kind: "code" } };
	return { text: " ", consumed: 1, mode: { kind: "line" } };
}

function stepBlockMode(ch: string | undefined, next: string | undefined): CStyleStep {
	if (ch === "*" && next === "/") return { text: "  ", consumed: 2, mode: { kind: "code" } };
	return { text: blankChar(ch), consumed: 1, mode: { kind: "block" } };
}

function stepStringMode(
	ch: string | undefined,
	next: string | undefined,
	delim: '"' | "'" | "`",
	hasNext: boolean,
): CStyleStep {
	if (ch === "\\" && hasNext) {
		// Preserve newline positions inside escapes.
		return { text: blankEscapeSpan(next), consumed: 2, mode: { kind: "string", delim } };
	}
	if (ch === delim) {
		return { text: ch, consumed: 1, mode: { kind: "code" } };
	}
	return { text: blankChar(ch), consumed: 1, mode: { kind: "string", delim } };
}

function stepCodeMode(ch: string | undefined, next: string | undefined): CStyleStep {
	if (ch === "/" && next === "/") return { text: "  ", consumed: 2, mode: { kind: "line" } };
	if (ch === "/" && next === "*") return { text: "  ", consumed: 2, mode: { kind: "block" } };
	if (ch === '"' || ch === "'" || ch === "`") {
		return { text: ch, consumed: 1, mode: { kind: "string", delim: ch } };
	}
	return { text: nonNull(ch), consumed: 1, mode: { kind: "code" } };
}

function stripCStyle(content: string): string {
	const out: string[] = [];
	let i = 0;
	const n = content.length;
	let mode: CStyleMode = { kind: "code" };

	while (i < n) {
		const ch = content[i];
		const next = content[i + 1];
		let step: CStyleStep;
		if (mode.kind === "line") {
			step = stepLineMode(ch);
		} else if (mode.kind === "block") {
			step = stepBlockMode(ch, next);
		} else if (mode.kind === "string") {
			step = stepStringMode(ch, next, mode.delim, i + 1 < n);
		} else {
			step = stepCodeMode(ch, next);
		}
		out.push(step.text);
		i += step.consumed;
		mode = step.mode;
	}

	return out.join("");
}

// Exported helpers for tests.
export const __test__ = {
	stripPython,
	stripCStyle,
	headerHasGuard,
	C_INCLUDE_GUARD_SENTINEL,
};

// Keep imported-but-unused shape: `InlineCheckDef` documents the contract
// this module reads, so the import anchors the type dependency for readers.
export type { InlineCheckDef };
