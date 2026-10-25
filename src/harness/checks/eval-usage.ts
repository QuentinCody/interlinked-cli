// eval_usage — direct and implied eval in JavaScript/TypeScript.
// Extracted from agent-safety-js-correctness.ts (2026-10-21) to keep that
// module under the per-file line cap; re-exported there so the family barrel
// and the registry keep importing it from the same place.

import { nonNull } from "../../lib/non-null.js";
import { memberMayStartAfter } from "./eval-definition-scan.js";
import { blankJsxText } from "./nan-comparison-scan.js";
import { getExtension, type InlineMatch, isTestFile, JS_TS_EXTS, stripCommentsAndStrings } from "./shared.js";

// Direct eval — negative lookbehind so `this.#eval(...)`, `$eval(...)` or an
// identifier-suffixed call is not read as the global eval. A member call
// (`vm.eval(...)`, `sandbox.\n\teval(...)`) is excluded by the preceding
// non-space character instead, so a dot at the end of the previous line counts.
const EVAL_OPEN = /(?<![\w#$])eval\s*\(/g;
// The parameter list of a definition starts with a typed parameter
// (`code: string`, `...args: T[]`, `x?: T`); a call argument never does.
const TYPED_FIRST_PARAM = /^\s*(?:\.\.\.)?[\w$]+\s*\??\s*:/;

/** Index of the `)` that closes the `(` at `open`, or -1 when unbalanced. */
function closingParen(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")" && --depth === 0) return i;
	}
	return -1;
}

/** True when the `eval(` whose paren is at `open` DEFINES a member named
 *  `eval` rather than calling the global: a typed first parameter, a method
 *  body `{` on the same line after the parameter list (a call is never
 *  followed by `{`), or a return-type `:` where a member may start
 *  (`memberMayStartAfter`: a separator, modifier, decorator, generator `*`
 *  or ASI-terminated previous member; never `?`, `case` or an operator). `head` is the
 *  content before `eval`, trailing whitespace trimmed. The parameter list is
 *  balanced over the whole content, so a Prettier-wrapped signature, nested
 *  callback types and default values that are calls are all one list. Found
 *  by the 2026-10-21 adversarial review (interpreter / sandbox classes). */
function isEvalDefinition(text: string, open: number, head: string): boolean {
	const close = closingParen(text, open);
	if (close < 0) return false;
	if (TYPED_FIRST_PARAM.test(text.slice(open + 1, close))) return true;
	const after = text.slice(close + 1);
	if (/^[ \t]*\{/.test(after)) return true;
	return /^\s*:/.test(after) && memberMayStartAfter(head);
}

/** 0-based line indices that hold a call to the GLOBAL eval. */
function globalEvalCallLines(stripped: string): Set<number> {
	const found = new Set<number>();
	for (const m of stripped.matchAll(EVAL_OPEN)) {
		const before = stripped.slice(0, m.index);
		const head = before.trimEnd();
		if (head.endsWith(".")) continue;
		if (isEvalDefinition(stripped, m.index + m[0].length - 1, head)) continue;
		found.add((before.match(/\n/g) ?? []).length);
	}
	return found;
}

/**
 * Detect eval/implied-eval in JavaScript/TypeScript.
 * Catches: eval(), Function(), setTimeout/setInterval with string arg.
 */
export function checkEvalUsage(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	// JSX text is prose (`<code>eval(input)</code>` in a docs component): the
	// shared strip keeps it as written, so a .tsx/.jsx file blanks it first.
	const stripped = stripCommentsAndStrings(blankJsxText(content, filePath));
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const evalLines = globalEvalCallLines(stripped);
	const matches: InlineMatch[] = [];
	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= 10) break;
		if (
			evalLines.has(i) ||
			// new Function() — implied eval
			/\bnew\s+Function\s*\(/.test(line) ||
			// setTimeout/setInterval with string argument (implied eval)
			/\b(setTimeout|setInterval)\s*\(\s*['"`]/.test(line)
		) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}
