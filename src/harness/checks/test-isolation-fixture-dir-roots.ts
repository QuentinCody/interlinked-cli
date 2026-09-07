// Root-identifier / enclosing-parameter resolution helpers for
// `test-isolation-fixture-dir.ts`'s PARAMETER ROOT rule. Split into a sibling
// module to keep the main file under the line cap — these are cohesive
// "resolve a call argument back to a function parameter" primitives with no
// dependency on the tmp-rootedness resolution that stays in the main file.

/** Char offsets at which `text` splits on a top-level (depth-0) comma —
 *  ignores commas nested inside `()`/`[]`/`{}`. Returns the segments, not the
 *  offsets: `splitTopLevel("cwd, \"x-\"")` → `["cwd", ' "x-"']`. */
function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === "," && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

/** Root identifier of a mkdtemp/mkdirSync first argument: `join(cwd, …)` →
 *  `cwd`; `dirname(path)` → `path`; bare `dir` → `dir`. Null for anything
 *  that isn't a bare identifier or a single-level call wrapping one (a
 *  string literal, `process.cwd()`, or a multi-segment expression) — those
 *  are judged by the caller's own tmp-rootedness resolution instead, never
 *  by parameter identity. */
export function extractRootIdentifier(argText: string): string | null {
	const trimmed = argText.trim();
	if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return trimmed;
	const call = /^[A-Za-z_$][\w$]*\s*\(([^]*)\)$/.exec(trimmed);
	if (!call) return null;
	const firstSeg = (splitTopLevel(call[1] ?? "")[0] ?? "").trim();
	return /^[A-Za-z_$][\w$]*$/.test(firstSeg) ? firstSeg : null;
}

/** Parameter names declared by one `function`/arrow head's parameter-list
 *  text: leading identifier of each top-level segment, so destructured
 *  (`{a,b}`) params contribute nothing and `cwd = "/x"` still yields `cwd`. */
function extractParamNames(paramText: string): string[] {
	const names: string[] = [];
	for (const raw of splitTopLevel(paramText)) {
		const m = /^[A-Za-z_$][\w$]*/.exec(raw.trim().replace(/^\.\.\./, ""));
		if (m) names.push(m[0]);
	}
	return names;
}

const FUNC_DECL_START_RE = /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/g;

/** Forward balanced-paren scan: the index of the `)` matching the `(` at
 *  `openIdx`, or -1. A plain `[^)]*` regex can't do this — it stops at the
 *  FIRST `)`, which misreads `mockImplementation((cwd: string) => {...})`'s
 *  outer paren as swallowing the arrow's own param list. */
function findMatchingCloseParen(text: string, openIdx: number): number {
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Backward balanced-paren scan: the index of the `(` matching the `)` at
 *  `closeIdx`, or -1. */
function findMatchingOpenParen(text: string, closeIdx: number): number {
	let depth = 0;
	for (let i = closeIdx; i >= 0; i--) {
		if (text[i] === ")") depth++;
		else if (text[i] === "(") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Every `function name(...)` declaration's parameter names, for heads
 *  starting before `beforeOffset`. */
function collectFunctionDeclParamsBefore(stripped: string, beforeOffset: number): string[][] {
	FUNC_DECL_START_RE.lastIndex = 0;
	const out: string[][] = [];
	let m: RegExpExecArray | null = FUNC_DECL_START_RE.exec(stripped);
	while (m !== null) {
		if (m.index < beforeOffset) {
			const openIdx = m.index + m[0].length - 1;
			const closeIdx = findMatchingCloseParen(stripped, openIdx);
			if (closeIdx !== -1) out.push(extractParamNames(stripped.slice(openIdx + 1, closeIdx)));
		}
		m = FUNC_DECL_START_RE.exec(stripped);
	}
	return out;
}

/** Every `(...) =>` / `async (...) =>` arrow head's parameter names, for
 *  heads starting before `beforeOffset`. Walks backward from each `=>` to
 *  its param list's balanced parens instead of a `[^)]*` regex, which
 *  cannot tell an arrow's own parens from an enclosing call's. */
function collectArrowParamsBefore(stripped: string, beforeOffset: number): string[][] {
	const out: string[][] = [];
	const arrowRe = /=>/g;
	let m: RegExpExecArray | null = arrowRe.exec(stripped);
	while (m !== null) {
		if (m.index < beforeOffset) {
			let i = m.index - 1;
			while (i >= 0 && /\s/.test(stripped[i] ?? "")) i--;
			if (stripped[i] === ")") {
				const openIdx = findMatchingOpenParen(stripped, i);
				if (openIdx !== -1) out.push(extractParamNames(stripped.slice(openIdx + 1, i)));
			}
		}
		m = arrowRe.exec(stripped);
	}
	return out;
}

/** True when `ident` names a parameter of some function/arrow head that
 *  textually precedes `beforeOffset` — a nearest-enclosing-scope heuristic
 *  (no brace-depth tracking): the common test-helper shape
 *  `function writeFixtures(root, ...) { mkdtempSync(join(root, ...)); }`,
 *  where every call site happens to pass a tmpdir-rooted value in. */
export function isEnclosingParameter(stripped: string, ident: string, beforeOffset: number): boolean {
	const declParams = collectFunctionDeclParamsBefore(stripped, beforeOffset);
	const arrowParams = collectArrowParamsBefore(stripped, beforeOffset);
	return [...declParams, ...arrowParams].some((params) => params.includes(ident));
}
