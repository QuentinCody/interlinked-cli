// Shared internal primitives for the test-hygiene check families.
//
// Holds the two helpers needed by BOTH the isolation family
// (test-hygiene-isolation.ts) and the quality family
// (test-hygiene-quality.ts): the `it()` / `test()` call-opening regex and the
// brace/paren-balanced call-span scanner. Kept in a sibling module rather than
// in the public barrel so each family file imports them directly without an
// import cycle through the re-exporting barrel.

// `it` / `test` (with the usual modifier chain), capturing only the call
// opening. `specify` is intentionally excluded — vitest's slow-subprocess
// flake is `it`/`test`, and `specify` carries no `{ timeout }` overload.
export const IT_TEST_OPEN_RE =
	/\b(it|test)(?:\.(?:each|only|skip|concurrent|skipIf|runIf|sequential|failing))*\s*\(/g;

/**
 * Comment/string-blanking that keeps every character position stable —
 * unlike `stripCommentsAndStrings` (shared.ts), which collapses a quoted
 * literal's contents down to a bare `""`/`''`/` `` ` and so SHRINKS the
 * text. A caller that finds a match/span position in the stripped text (via
 * `IT_TEST_OPEN_RE` / `findCallSpan`) and then slices the ORIGINAL,
 * un-stripped content at that same position needs offsets that agree
 * between the two strings — any string literal earlier in the file would
 * otherwise silently shift every later offset out from under it.
 */
/**
 * Index just past the string literal that opens at `start` (whose quote
 * character is `quote`). An unterminated single/double-quoted literal stops at
 * the newline so blanking never runs past a real line break; a template
 * literal has no such bail-out and runs to `n`. Lifted out of
 * `stripPreservingOffsets` verbatim — it is the deepest-nested block there,
 * and at depth 0 it costs the caller nothing.
 */
function stringLiteralEnd(content: string, start: number, quote: string): number {
	const n = content.length;
	let j = start + 1;
	while (j < n) {
		if (content[j] === "\\") {
			j += 2;
			continue;
		}
		if (content[j] === quote) {
			j++;
			break;
		}
		// Unterminated single/double-quoted string — bail at line end so
		// we never blank past a real newline for those two forms.
		if (content[j] === "\n" && quote !== "`") break;
		j++;
	}
	return j;
}

export function stripPreservingOffsets(content: string): string {
	let out = "";
	let i = 0;
	const n = content.length;
	while (i < n) {
		const ch = content[i];
		const two = content.slice(i, i + 2);
		if (two === "//") {
			const end = content.indexOf("\n", i);
			const stop = end === -1 ? n : end;
			out += " ".repeat(stop - i);
			i = stop;
			continue;
		}
		if (two === "/*") {
			const end = content.indexOf("*/", i + 2);
			const stop = end === -1 ? n : end + 2;
			out += content.slice(i, stop).replace(/[^\n]/g, " ");
			i = stop;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			const j = stringLiteralEnd(content, i, ch);
			out += content.slice(i, j).replace(/[^\n]/g, " ");
			i = j;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/**
 * Brace/paren-balanced span of an `it(...)` / `test(...)` call argument list.
 * `from` is the index just inside the opening `(`. Returns the index of the
 * matching close `)` plus the comma offsets at depth 0 (argument separators),
 * or null if unbalanced (truncated file / regex artifact).
 */
export function findCallSpan(
	text: string,
	from: number,
): { end: number; topLevelCommas: number[] } | null {
	let depth = 1; // already inside the `it(` paren
	const topLevelCommas: number[] = [];
	const MAX_SCAN = 20_000; // a single test block past this is pathological
	const limit = Math.min(text.length, from + MAX_SCAN);
	for (let i = from; i < limit; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ")" || ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) return { end: i, topLevelCommas };
		} else if (ch === "," && depth === 1) {
			topLevelCommas.push(i);
		}
	}
	return null;
}
