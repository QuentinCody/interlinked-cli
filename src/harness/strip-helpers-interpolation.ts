// interlinked-tdd: exempt
// ===========================================
// Template-interpolation extraction (sibling of strip-helpers.ts)
// ===========================================
// Extracts executable `${...}` bodies from JS/TS template literals while
// ignoring backticks inside comments and quoted strings. A self-contained
// leaf cluster carved out of strip-helpers.ts to keep that module under the
// per-file line cap. Public entry: extractTemplateInterpolationExpressions.

/**
 * Extract executable `${...}` bodies from JS/TS template literals while
 * ignoring backticks inside comments and quoted strings. Plain template text
 * is intentionally not returned; it is string data, not code.
 */
export function extractTemplateInterpolationExpressions(content: string): string[] {
	const expressions: string[] = [];
	scanTemplateLiterals(content, expressions, 0);
	return expressions;
}

type TemplateScanContext = {
	expressions: string[];
	recursionDepth: number;
};

/**
 * Advance one step of `scanTemplateLiterals`'s top-level scan: skip
 * comment/string state via `stepPastCommentOrString`, then dispatch on the
 * current character (comment/string start, or a template literal to hand
 * off to `collectTemplateExpressions`). Returns the next index to resume
 * scanning from. Extracted so the caller's loop stays flat — the per-state
 * dispatch that used to nest inside the loop now lives at this function's
 * top level instead.
 */
function advanceTemplateLiteralScan(
	content: string,
	i: number,
	state: CommentStringLexerState,
	ctx: TemplateScanContext,
): number {
	const stepped = stepPastCommentOrString(content, i, state);
	if (stepped !== null) return stepped;

	const ch = content[i];
	const next = content[i + 1];

	if (ch === "/" && next === "/") {
		state.inLineComment = true;
		return i + 2;
	}
	if (ch === "/" && next === "*") {
		state.inBlockComment = true;
		return i + 2;
	}
	if (ch === '"' || ch === "'") {
		state.inString = ch;
		return i + 1;
	}
	if (ch === "`") {
		const end = collectTemplateExpressions(content, i + 1, ctx.expressions, ctx.recursionDepth);
		return end === null ? content.length : end + 1;
	}
	return i + 1;
}

function scanTemplateLiterals(
	content: string,
	expressions: string[],
	recursionDepth: number,
): void {
	let i = 0;
	// Same comment/string skip logic `readBalancedTemplateExpression` uses below —
	// shared via `stepPastCommentOrString` instead of re-inlined, which is also
	// what keeps this loop flat (no nested if-inside-if per lexer state).
	const state: CommentStringLexerState = {
		inLineComment: false,
		inBlockComment: false,
		inString: null,
	};
	const ctx: TemplateScanContext = { expressions, recursionDepth };

	while (i < content.length) {
		i = advanceTemplateLiteralScan(content, i, state, ctx);
	}
}

function collectTemplateExpressions(
	content: string,
	start: number,
	expressions: string[],
	recursionDepth: number,
): number | null {
	let i = start;
	while (i < content.length) {
		const ch = content[i];
		const next = content[i + 1];

		if (ch === "\\" && i + 1 < content.length) {
			i += 2;
			continue;
		}
		if (ch === "`") return i;
		if (ch === "$" && next === "{") {
			const expr = readBalancedTemplateExpression(content, i + 2);
			if (expr === null) return null;
			expressions.push(expr.body);
			if (recursionDepth < 3) {
				scanTemplateLiterals(expr.body, expressions, recursionDepth + 1);
			}
			i = expr.end + 1;
			continue;
		}
		i++;
	}
	return null;
}

type CommentStringLexerState = {
	inLineComment: boolean;
	inBlockComment: boolean;
	inString: '"' | "'" | null;
};

/**
 * Advance one step while `i` sits inside a line comment, a block comment, or
 * a quoted string (mutating `state` to match). Returns the next index, or
 * `null` when `i` is not inside any of those states — the caller then falls
 * through to normal-mode dispatch (comment/string start, backtick, brace).
 */
function stepPastCommentOrString(
	content: string,
	i: number,
	state: CommentStringLexerState,
): number | null {
	const ch = content[i];
	const next = content[i + 1];

	if (state.inLineComment) {
		if (ch === "\n") state.inLineComment = false;
		return i + 1;
	}
	if (state.inBlockComment) {
		if (ch === "*" && next === "/") {
			state.inBlockComment = false;
			return i + 2;
		}
		return i + 1;
	}
	if (state.inString) {
		if (ch === "\\" && i + 1 < content.length) return i + 2;
		if (ch === state.inString) state.inString = null;
		return i + 1;
	}
	return null;
}

type BalancedExpressionStep =
	| { kind: "continue"; i: number; depth: number }
	| { kind: "return-null" }
	| { kind: "done"; body: string; end: number };

/**
 * Advance one lexer step of `readBalancedTemplateExpression`'s scan: skip
 * comment/string state via `stepPastCommentOrString`, then dispatch on the
 * current character (comment/string start, nested template literal, or
 * brace depth tracking). Extracted so the caller's loop stays flat — the
 * depth bookkeeping and nested-template lookahead that used to nest inside
 * the loop now live at this function's top level instead.
 */
function advanceBalancedExpressionScan(
	content: string,
	i: number,
	start: number,
	depth: number,
	state: CommentStringLexerState,
): BalancedExpressionStep {
	const stepped = stepPastCommentOrString(content, i, state);
	if (stepped !== null) {
		return { kind: "continue", i: stepped, depth };
	}
	const ch = content[i];
	const next = content[i + 1];

	if (ch === "/" && next === "/") {
		state.inLineComment = true;
		return { kind: "continue", i: i + 2, depth };
	}
	if (ch === "/" && next === "*") {
		state.inBlockComment = true;
		return { kind: "continue", i: i + 2, depth };
	}
	if (ch === '"' || ch === "'") {
		state.inString = ch;
		return { kind: "continue", i: i + 1, depth };
	}
	if (ch === "`") {
		const end = findTemplateLiteralEnd(content, i + 1);
		if (end === null) return { kind: "return-null" };
		return { kind: "continue", i: end + 1, depth };
	}
	if (ch === "{") {
		return { kind: "continue", i: i + 1, depth: depth + 1 };
	}
	if (ch === "}") {
		const newDepth = depth - 1;
		if (newDepth === 0) {
			return { kind: "done", body: content.slice(start, i), end: i };
		}
		return { kind: "continue", i: i + 1, depth: newDepth };
	}
	return { kind: "continue", i: i + 1, depth };
}

function readBalancedTemplateExpression(
	content: string,
	start: number,
): { body: string; end: number } | null {
	let depth = 1;
	let i = start;
	const state: CommentStringLexerState = {
		inLineComment: false,
		inBlockComment: false,
		inString: null,
	};

	while (i < content.length) {
		const step = advanceBalancedExpressionScan(content, i, start, depth, state);
		if (step.kind === "return-null") return null;
		if (step.kind === "done") return { body: step.body, end: step.end };
		i = step.i;
		depth = step.depth;
	}

	return null;
}

function findTemplateLiteralEnd(content: string, start: number): number | null {
	let i = start;
	while (i < content.length) {
		const ch = content[i];
		const next = content[i + 1];
		if (ch === "\\" && i + 1 < content.length) {
			i += 2;
			continue;
		}
		if (ch === "`") return i;
		if (ch === "$" && next === "{") {
			const expr = readBalancedTemplateExpression(content, i + 2);
			if (expr === null) return null;
			i = expr.end + 1;
			continue;
		}
		i++;
	}
	return null;
}
