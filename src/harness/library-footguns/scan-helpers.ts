// ============================================================
// Shared scanning primitives for the library-footgun detectors
// ============================================================
// Every footgun module answers the same two mechanical questions
// before it can say anything about a library: "is this file even
// eligible for scanning?" and "where does the argument list of
// this call end?". Those answers are library-independent, so they
// live here rather than being re-derived per library.

import { getExtension, type InlineMatch, isGeneratedFile, isTestFile, JS_TS_EXTS } from "../checks/shared.js";

/**
 * True when a file is outside the footgun detectors' population:
 * non-JS/TS source, a test file, or generator output. Every
 * library-footgun detector gates on this before scanning.
 */
export function shouldSkipFootgunScan(filePath: string, content: string): boolean {
	const ext = getExtension(filePath);
	if (!JS_TS_EXTS.has(ext)) return true;
	if (isTestFile(filePath)) return true;
	if (isGeneratedFile(content)) return true;
	return false;
}

/**
 * Extract the argument-list text between the `(` at openIdx and
 * its matching `)`, respecting nested parens. Returns null if no
 * balanced match.
 */
export function balancedArgList(content: string, openIdx: number): string | null {
	let depth = 1;
	let i = openIdx + 1;
	while (i < content.length && depth > 0) {
		const ch = content[i];
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		i++;
	}
	if (depth !== 0) return null;
	return content.slice(openIdx + 1, i - 1);
}

/**
 * Report one InlineMatch per match of a global regex: the 1-based
 * line the match starts on, plus that line's trimmed source text
 * (truncated to 150 chars). The regex's `lastIndex` is reset first,
 * so a module-level `/g` pattern is safe to reuse across calls.
 */
export function collectRegexLineMatches(content: string, re: RegExp): InlineMatch[] {
	const out: InlineMatch[] = [];
	const lines = content.split("\n");
	re.lastIndex = 0;
	let m: RegExpExecArray | null = re.exec(content);
	while (m !== null) {
		const lineNo = content.slice(0, m.index).split("\n").length;
		out.push({
			line: lineNo,
			text: (lines[lineNo - 1] || "").trim().slice(0, 150),
		});
		m = re.exec(content);
	}
	return out;
}
