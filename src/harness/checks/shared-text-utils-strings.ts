// Character-level string/template stripper backing `stripStrings` in
// shared-text-utils.ts. Companion tests: shared-text-utils-strings.test.ts.
//
// Why this exists as its own scan (not the old per-line regex + backtick
// counter): a `${...}` interpolation inside a multi-line template can itself
// contain a nested template literal, a nested string, or a regex literal —
// each of which may carry its own backticks/braces. Counting those as plain
// template-body characters desyncs the "is the outer template still open"
// state, and once desynced every subsequent line reads as still-open and
// gets blanked. This scanner instead tracks a STACK of open constructs
// (template body vs. `${}` interpolation) and treats interpolation content
// as CODE — dispatched through the same string/template/regex handling
// recursively — so nested delimiters only ever affect their own frame.
//
// Contract preserved (see shared-text-utils.ts for the callers that rely on
// it): line count is unchanged, string/template delimiters are kept, regex
// literals are left completely untouched, and string/template CONTENT is
// blanked to nothing (characters dropped, not space-filled) except that a
// real newline inside blanked content is always kept so line numbers stay
// stable.

type Frame = { kind: "template" } | { kind: "interp"; depth: number };

interface ScanState {
	out: string[];
	stack: Frame[];
	inQuote: '"' | "'" | null;
	/** Last emitted non-whitespace character; used to decide if a `/` starts a regex. */
	lastCode: string;
}

const REGEX_PRECEDING = /[=([,!:?;{}&|+\-*^~%<>]/;

function isRegexStart(state: ScanState): boolean {
	return state.lastCode === "" || REGEX_PRECEDING.test(state.lastCode);
}

type RegexBodyStep = { done: false; next: number; inClass: boolean } | { done: true; end: number | null };

/** One step of the regex-body scan started by {@link tryConsumeRegex}. */
function stepRegexBody(content: string, j: number, inClass: boolean): RegexBodyStep {
	const c = content[j];
	if (c === "\n") return { done: true, end: null }; // regex literals can't span a real newline
	if (c === "\\" && j + 1 < content.length) return { done: false, next: j + 2, inClass };
	if (c === "[") return { done: false, next: j + 1, inClass: true };
	if (c === "]") return { done: false, next: j + 1, inClass: false };
	if (c === "/" && !inClass) {
		let k = j + 1;
		while (k < content.length && /[a-zA-Z]/.test(content[k] ?? "")) k++;
		return { done: true, end: k };
	}
	return { done: false, next: j + 1, inClass };
}

/**
 * Try to consume a `/…/flags` regex literal starting at `i`. Returns the
 * index just past it, or `null` if `content[i]` doesn't start one. A
 * matched regex is copied to the output completely untouched — regex
 * literals are never blanked, so a backtick or quote inside one can't be
 * mistaken for a string/template delimiter.
 */
function tryConsumeRegex(content: string, i: number, state: ScanState): number | null {
	if (content[i] !== "/" || content[i + 1] === "/" || content[i + 1] === "*") return null;
	if (!isRegexStart(state)) return null;

	let j = i + 1;
	let inClass = false;
	while (j < content.length) {
		const step = stepRegexBody(content, j, inClass);
		if (step.done) return step.end;
		j = step.next;
		inClass = step.inClass;
	}
	return null;
}

function isWhitespace(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\n";
}

function pushCode(state: ScanState, ch: string): void {
	state.out.push(ch);
	if (!isWhitespace(ch)) state.lastCode = ch;
}

/** One step while inside a `"…"` / `'…'` string literal. */
function stepQuote(content: string, i: number, state: ScanState): number {
	// SAFETY: caller only invokes this while `i < content.length` (the scan
	// loop's own bound), so the indexed access is always in range.
	const ch = content[i] as string;
	if (ch === "\\" && i + 1 < content.length) {
		if (content[i + 1] === "\n") state.out.push("\n");
		return i + 2;
	}
	if (ch === "\n") {
		// Unterminated on this line — bail out of the string and keep the newline.
		state.inQuote = null;
		state.out.push("\n");
		return i + 1;
	}
	if (ch === state.inQuote) {
		state.inQuote = null;
		pushCode(state, ch);
		return i + 1;
	}
	return i + 1; // blank the string's content
}

/** One step while inside a template-literal BODY (outside its own `${}`). */
function stepTemplateBody(content: string, i: number, state: ScanState): number {
	// SAFETY: caller only invokes this while `i < content.length`.
	const ch = content[i] as string;
	if (ch === "\\" && i + 1 < content.length) {
		if (content[i + 1] === "\n") state.out.push("\n");
		return i + 2;
	}
	if (ch === "`") {
		state.stack.pop();
		pushCode(state, ch);
		return i + 1;
	}
	if (ch === "$" && content[i + 1] === "{") {
		state.stack.push({ kind: "interp", depth: 1 });
		state.out.push("$");
		pushCode(state, "{");
		return i + 2;
	}
	if (ch === "\n") {
		state.out.push("\n");
		return i + 1;
	}
	return i + 1; // blank plain template text
}

/** Brace bookkeeping for a `{`/`}` seen while the top frame is an interpolation. */
function stepInterpBrace(state: ScanState, top: Extract<Frame, { kind: "interp" }>, ch: "{" | "}"): void {
	top.depth += ch === "{" ? 1 : -1;
	pushCode(state, ch);
	if (ch === "}" && top.depth === 0) state.stack.pop();
}

/** One step while scanning CODE — top-level, or inside a `${...}` interpolation. */
function stepCode(content: string, i: number, state: ScanState): number {
	const regexEnd = tryConsumeRegex(content, i, state);
	if (regexEnd !== null) {
		const regexText = content.slice(i, regexEnd);
		state.out.push(regexText);
		state.lastCode = regexText.slice(-1);
		return regexEnd;
	}

	// SAFETY: caller only invokes this while `i < content.length`.
	const ch = content[i] as string;
	if (ch === '"' || ch === "'") {
		state.inQuote = ch;
		pushCode(state, ch);
		return i + 1;
	}
	if (ch === "`") {
		state.stack.push({ kind: "template" });
		pushCode(state, ch);
		return i + 1;
	}

	const top = state.stack[state.stack.length - 1];
	if (top?.kind === "interp" && (ch === "{" || ch === "}")) {
		stepInterpBrace(state, top, ch);
		return i + 1;
	}

	pushCode(state, ch);
	return i + 1;
}

/**
 * Blank string/template literal content across the whole of `content`,
 * tracking template and `${}` interpolation state as one contiguous scan
 * (not per line) so nested constructs inside an interpolation can't desync
 * the outer template's open/close tracking. See the module header for the
 * full contract.
 */
export function stripStringsAcrossLines(content: string): string {
	const state: ScanState = { out: [], stack: [], inQuote: null, lastCode: "" };
	let i = 0;
	while (i < content.length) {
		if (state.inQuote) {
			i = stepQuote(content, i, state);
			continue;
		}
		const top = state.stack[state.stack.length - 1];
		if (top?.kind === "template") {
			i = stepTemplateBody(content, i, state);
			continue;
		}
		i = stepCode(content, i, state);
	}
	return state.out.join("");
}
