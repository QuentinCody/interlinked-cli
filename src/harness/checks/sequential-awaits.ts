// Sequential independent awaits detection (JS/TS).
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import { getExtension, type InlineMatch, isTestFile, JS_TS_EXTS } from "./shared.js";

// ===========================================
// Sequential Independent Awaits Detection (JS/TS)
// ===========================================

const AWAIT_PATTERN = /^(?:const|let|var)\s+(\w+)\s*=\s*await\s+(.+);?\s*$/;
// Prompts must be sequential — their output interleaves, so they're never
// flagged as candidates for Promise.all even when otherwise independent.
const INTERACTIVE_IO_PATTERN = /\bprompt\s*\(|\breadline\b|\bquestion\s*\(/;

function isInteractiveIO(expr: string): boolean {
	return INTERACTIVE_IO_PATTERN.test(expr);
}

interface AwaitLineResult {
	/** true when the original loop body would have hit `continue` — the
	 * caller must leave prevVarName/prevLineIdx untouched in that case. */
	skip: boolean;
	match: InlineMatch | null;
	varName: string | null;
	lineIdx: number;
}

function processAwaitLine(
	lines: string[],
	i: number,
	prevVarName: string | null,
	prevLineIdx: number,
): AwaitLineResult {
	const trimmed = nonNull(lines[i]).trim();
	const m = AWAIT_PATTERN.exec(trimmed);
	if (!m) {
		return { skip: false, match: null, varName: null, lineIdx: -1 };
	}

	const varName = nonNull(m[1]);
	const expr = nonNull(m[2]);

	// Check if this await references the previous await's variable
	if (prevVarName === null || prevLineIdx !== i - 1) {
		return { skip: false, match: null, varName, lineIdx: i };
	}
	if (expr.includes(prevVarName)) {
		return { skip: false, match: null, varName, lineIdx: i };
	}

	const prevExpr = nonNull(lines[prevLineIdx]).trim();
	if (isInteractiveIO(prevExpr) || isInteractiveIO(expr)) {
		return { skip: true, match: null, varName: null, lineIdx: -1 };
	}

	return {
		skip: false,
		match: {
			line: prevLineIdx + 1,
			text: `[sequential independent awaits — consider Promise.all] ${prevExpr.slice(0, 100)}`,
		},
		varName,
		lineIdx: i,
	};
}

/**
 * Detect sequential `const x = await ...;` lines where the second doesn't
 * reference the first's variable — they could run concurrently with Promise.all.
 *
 * Only fires on JS/TS files. Skips test files.
 */
export function checkSequentialAwaits(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];

	let prevVarName: string | null = null;
	let prevLineIdx = -1;

	for (let i = 0; i < lines.length; i++) {
		const result = processAwaitLine(lines, i, prevVarName, prevLineIdx);
		if (result.skip) continue;
		if (result.match) matches.push(result.match);
		prevVarName = result.varName;
		prevLineIdx = result.lineIdx;
	}

	return matches;
}
