// PII detection + mixed error strategy check.
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
	stripComments,
} from "./shared.js";

// ===========================================
// PII Detection
// ===========================================

/** A PII pattern definition with an optional skip pattern for false positive suppression. */
export interface PiiPattern {
	name: string;
	pattern: RegExp;
	skip?: RegExp;
	severity?: "low" | "medium" | "high" | "critical";
}

/** Default-on patterns: high signal, low noise */
const DEFAULT_PII_PATTERNS: PiiPattern[] = [
	{
		name: "ssn",
		pattern: /\b\d{3}-\d{2}-\d{4}\b/,
		skip: /0{3}-0{2}|123-45|000-|666-|9\d{2}-/,
		severity: "high",
	},
];

/** Opt-in patterns: useful but noisy without per-project tuning */
const OPTIN_PII_PATTERNS: PiiPattern[] = [
	{
		name: "email",
		pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
		skip: /noreply|example\.com|test\.com|localhost|users\.noreply|@types|@param|@returns/,
		severity: "medium",
	},
	{
		name: "phone_us",
		pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,
		skip: /port|timeout|0{3}|version|127\.|192\.|\.0\.|\.ts:|\.js:/,
		severity: "medium",
	},
	{
		name: "ip_address",
		pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/,
		skip: /127\.0\.0\.1|0\.0\.0\.0|255\.255|10\.0\.|172\.1[6-9]\.|192\.168\./,
		severity: "low",
	},
];

/** Files to skip entirely for PII detection (test fixtures, examples, config) */
function isPiiExcludedFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/").toLowerCase();
	if (isTestFile(filePath)) return true;
	if (normalized.endsWith(".env.example")) return true;
	if (normalized.includes("/fixtures/")) return true;
	if (normalized.includes("/mock")) return true;
	if (normalized.includes("/seed")) return true;
	if (normalized.includes("/testdata/")) return true;
	return false;
}

/** Config shape accepted by {@link checkPiiInSource} for opt-in + custom PII patterns. */
type PiiScanOpts = {
	optIn?: string[];
	customPatterns?: Array<{ name: string; pattern: string; severity?: string }>;
};

/** Resolve named opt-in patterns to their definitions, dropping names that match no known pattern. */
function selectOptInPiiPatterns(names: string[]): PiiPattern[] {
	const selected: PiiPattern[] = [];
	for (const name of names) {
		const found = OPTIN_PII_PATTERNS.find((p) => p.name === name);
		if (found) selected.push(found);
	}
	return selected;
}

/**
 * Compile admin-authored custom patterns (length-capped at 200 chars);
 * patterns that fail to compile are dropped rather than aborting the whole
 * rule load.
 */
function compileCustomPiiPatterns(customPatterns: NonNullable<PiiScanOpts["customPatterns"]>): PiiPattern[] {
	const compiled: PiiPattern[] = [];
	for (const cp of customPatterns) {
		if (typeof cp.pattern !== "string" || cp.pattern.length > 200) continue;
		try {
			// Reason: opts.customPatterns is admin-authored config;
			// length-capped at 200 and compile failures fall through.
			// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
			const pattern = new RegExp(cp.pattern);
			compiled.push({
				name: cp.name,
				pattern,
				severity: (cp.severity as PiiPattern["severity"]) || "medium",
			});
		} catch {
			// intentional: drop user-supplied patterns that fail to
			// compile rather than aborting the whole rule load.
		}
	}
	return compiled;
}

/**
 * Resolve the full set of active PII patterns for a scan: the default-on set,
 * plus any named opt-in patterns, plus any admin-authored custom patterns
 * (length-capped at 200 chars; patterns that fail to compile are dropped
 * rather than aborting the whole rule load).
 */
function resolveActivePiiPatterns(opts?: PiiScanOpts): PiiPattern[] {
	const activePatterns: PiiPattern[] = [...DEFAULT_PII_PATTERNS];
	if (opts?.optIn) activePatterns.push(...selectOptInPiiPatterns(opts.optIn));
	if (opts?.customPatterns) activePatterns.push(...compileCustomPiiPatterns(opts.customPatterns));
	return activePatterns;
}

/**
 * True when a comment-stripped line carries PII for this pattern: the pattern
 * matches, its false-positive skip pattern does not, and the line is not
 * documenting the format (e.g. "format: EMP-XXXXXX").
 */
function lineHasPiiMatch(piiPattern: PiiPattern, line: string): boolean {
	if (!piiPattern.pattern.test(line)) return false;
	if (piiPattern.skip?.test(line)) return false;
	if (/format:|example:|e\.g\.|placeholder|XXXX|sample/i.test(line)) return false;
	return true;
}

/**
 * Detect PII patterns in source code.
 * Default-on: SSN (high signal). Opt-in: email, phone, IP (need per-project tuning).
 * Skips test files, fixtures, .env.example, mock data.
 * Custom patterns and opt-in selection via config.
 */
export function checkPiiInSource(content: string, filePath: string, opts?: PiiScanOpts): InlineMatch[] {
	if (isPiiExcludedFile(filePath)) return [];

	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const activePatterns = resolveActivePiiPatterns(opts);

	for (const piiPattern of activePatterns) {
		for (let i = 0; i < strippedLines.length; i++) {
			if (matches.length >= 20) return matches;
			if (!lineHasPiiMatch(piiPattern, nonNull(strippedLines[i]))) continue;
			matches.push({
				line: i + 1,
				text: `[pii:${piiPattern.name}] ${nonNull(originalLines[i]).trim().slice(0, 120)}`,
			});
		}
	}

	return matches;
}

const MIXED_STRATEGY_FUNC_START =
	/(?:^|[\s;])(?:(?:export\s+)?(?:async\s+)?function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>|(?:async\s+)?\w+\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{)/;
const MIXED_STRATEGY_THROW_PAT = /\bthrow\s+(?:new\s+\w+|err|e|error)\b/;
const MIXED_STRATEGY_RETURN_ERROR_PAT =
	/\breturn\s+\{[^}]*(?:success\s*:\s*false|error\s*:|err\s*:)|return\s+(?:null|undefined)\s*;?\s*\/\/.*error/i;

/** True when a line opens a function body: a function-start shape plus the opening brace. */
function startsFunctionBody(line: string): boolean {
	return MIXED_STRATEGY_FUNC_START.test(line) && line.includes("{");
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

/**
 * Records a throw / return-error occurrence on `line`, but only within the
 * function's own body (depth 1) or one level in — if/else/try blocks at
 * depth 2. Deeper nesting is treated as noise and skipped.
 */
function trackErrorExitAtDepth(
	line: string,
	lineIndex: number,
	funcDepth: number,
	throwLines: number[],
	returnErrorLines: number[],
): void {
	if (funcDepth < 1 || funcDepth > 2) return;
	if (MIXED_STRATEGY_THROW_PAT.test(line)) throwLines.push(lineIndex);
	if (MIXED_STRATEGY_RETURN_ERROR_PAT.test(line)) returnErrorLines.push(lineIndex);
}

/** Pushes a mixed-error-strategy finding when a just-ended function body used both a throw and a return-error exit. */
function recordMixedStrategyIfPresent(
	throwLines: number[],
	returnErrorLines: number[],
	funcStartLine: number,
	originalLines: string[],
	matches: InlineMatch[],
): void {
	if (throwLines.length === 0 || returnErrorLines.length === 0) return;
	const funcLine = nonNull(originalLines[funcStartLine]).trim().slice(0, 120);
	matches.push({
		line: funcStartLine + 1,
		text: `mixed error strategy: function both throws (L${nonNull(throwLines[0]) + 1}) and returns error object (L${nonNull(returnErrorLines[0]) + 1}): ${funcLine}`,
	});
}

/**
 * Detect functions that use mixed error strategies — both `throw` and
 * `return { error }` / `return { success: false }` in the same function body.
 *
 * Callers cannot know whether to try/catch or check the return value,
 * leading to unhandled errors in either direction. This is the core problem
 * that Result types solve: a single, consistent error channel.
 *
 * Only flags when BOTH patterns appear in the same function. A file that
 * consistently uses one strategy throughout is fine.
 *
 * Skips: test files, type definition files, files < 5 lines.
 */
export function checkMixedErrorStrategy(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];
	if (content.split("\n").length < 5) return [];

	const stripped = stripComments(content);
	const lines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// Walk through lines, tracking function boundaries via brace depth
	let funcStartLine = -1;
	let funcDepth = 0;
	let inFunc = false;
	let throwLines: number[] = [];
	let returnErrorLines: number[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = nonNull(lines[i]);

		// Outside a function body, wait for a function start; then track this same line.
		if (!inFunc) {
			if (!startsFunctionBody(line)) continue;
			inFunc = true;
			funcStartLine = i;
			funcDepth = 0;
			throwLines = [];
			returnErrorLines = [];
		}

		funcDepth += braceDeltaForLine(line);
		trackErrorExitAtDepth(line, i, funcDepth, throwLines, returnErrorLines);

		// Function ended
		if (funcDepth > 0) continue;
		recordMixedStrategyIfPresent(throwLines, returnErrorLines, funcStartLine, originalLines, matches);
		inFunc = false;
		if (matches.length >= 5) break;
	}

	return matches;
}
