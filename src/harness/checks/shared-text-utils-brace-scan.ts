// interlinked-tdd: exempt
// Brace-balanced scanner for scope/complexity analysis — extracted from
// shared-text-utils.ts. Consumed via the shared-text-utils.ts barrel
// (re-exported) and by cyclomatic.ts / complexity.ts.

// ===========================================
// Brace-balanced scanner for scope/complexity analysis
// ===========================================
// The complexity walkers (`cyclomatic.ts`, `complexity.ts`) find each function
// body by counting `{`/`}` on the stripped source, so they need the strip to
// preserve STRUCTURAL brace balance. The general two-pass
// `stripStrings(stripComments())` does NOT: it blanks multi-line template
// continuation lines wholesale, deleting the braces of `${…}` interpolation
// code and leaving the count unbalanced (clean.ts: 89/89 → 61/59), which makes
// walkBraceBody run off the end of the file and over-count complexity to EOF.
//
// `stripForBraceScan` below is the dedicated fix: a single-pass char scanner
// that blanks comment / string / template-text / regex content (→ spaces,
// newlines preserved) while KEEPING structural braces and `${…}` interpolation
// *expression* code (its braces are balanced real code). It is deliberately NOT
// wired into `stripCommentsAndStrings` — the ~50 general consumers depend on
// that one keeping string delimiters and leaving regex intact, so swapping them
// onto the scanner shifts their match counts (verified: 14 test regressions).

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/** Chars that, immediately before `/`, start a regex literal (not division). */
const REGEX_PRECEDER_CHARS = new Set([
	"", "(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "^", "~", "<", ">",
]);
/** Keywords that can precede a regex literal: `return /x/`, `typeof /x/`, … */
const REGEX_PRECEDER_WORDS = new Set([
	"return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "do", "else", "yield", "await", "case",
]);

type ScanFrame =
	| { k: "code"; brace: number; expr: boolean }
	| { k: "str"; quote: string }
	| { k: "tmpl" }
	| { k: "block" }
	| { k: "regex"; cls: boolean };

/** The identifier run ending just before `slashIdx` (skipping whitespace). */
function precedingWord(content: string, slashIdx: number): string {
	let j = slashIdx - 1;
	while (j >= 0 && /\s/.test(content[j] ?? "")) j--;
	const end = j;
	while (j >= 0 && IDENT_CHAR.test(content[j] ?? "")) j--;
	return content.slice(j + 1, end + 1);
}

function isRegexStart(prevChar: string, content: string, slashIdx: number): boolean {
	if (REGEX_PRECEDER_CHARS.has(prevChar)) return true;
	if (IDENT_CHAR.test(prevChar)) return REGEX_PRECEDER_WORDS.has(precedingWord(content, slashIdx));
	return false;
}

/**
 * One step of {@link stripForBraceScan}. Each handler advances the cursor `i`
 * past the chars it consumes (blanking them) and returns the next cursor plus
 * the next `prevChar`. `stack` is mutated in place (push/pop) and the active
 * frame's mutable fields (`brace`/`cls`/`expr`) are updated on the object, so
 * those propagate without being threaded through the return value.
 */
type ScanStep = { i: number; prevChar: string };

type BlankFn = (idx: number) => void;

/** Consume one char inside a `"`/`'` string literal frame. */
function stepStr(
	content: string,
	n: number,
	i: number,
	top: Extract<ScanFrame, { k: "str" }>,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep {
	const c = content[i] ?? "";
	if (c === "\\") {
		blank(i);
		if (i + 1 < n) blank(i + 1);
		return { i: i + 2, prevChar };
	}
	if (c === "\n") {
		stack.pop(); // unterminated string — bail rather than swallow the file
		return { i: i + 1, prevChar };
	}
	blank(i);
	if (c === top.quote) {
		stack.pop();
		return { i: i + 1, prevChar: "v" }; // a value just ended → following `/` is division
	}
	return { i: i + 1, prevChar };
}

/** Consume one char inside a `/* … *​/` block-comment frame. */
function stepBlock(
	content: string,
	i: number,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep {
	const c = content[i] ?? "";
	const c2 = content[i + 1] ?? "";
	if (c === "*" && c2 === "/") {
		blank(i);
		blank(i + 1);
		stack.pop();
		return { i: i + 2, prevChar };
	}
	blank(i);
	return { i: i + 1, prevChar };
}

/** Consume one char inside a regex-literal frame. */
function stepRegex(
	content: string,
	i: number,
	top: Extract<ScanFrame, { k: "regex" }>,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep {
	const c = content[i] ?? "";
	if (c === "\\") {
		blank(i);
		if (i + 1 < content.length) blank(i + 1);
		return { i: i + 2, prevChar };
	}
	if (c === "\n") {
		stack.pop(); // unterminated regex — bail
		return { i: i + 1, prevChar };
	}
	if (c === "[") top.cls = true;
	else if (c === "]") top.cls = false;
	const closing = c === "/" && !top.cls;
	blank(i);
	if (closing) {
		stack.pop();
		return { i: i + 1, prevChar: "v" };
	}
	return { i: i + 1, prevChar };
}

/** Consume one char inside a template-literal frame (outside `${…}`). */
function stepTmpl(
	content: string,
	n: number,
	i: number,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep {
	const c = content[i] ?? "";
	const c2 = i + 1 < n ? (content[i + 1] ?? "") : "";
	if (c === "\\") {
		blank(i);
		if (i + 1 < n) blank(i + 1);
		return { i: i + 2, prevChar };
	}
	if (c === "`") {
		blank(i);
		stack.pop();
		return { i: i + 1, prevChar: "v" };
	}
	if (c === "$" && c2 === "{") {
		// Drop `${` and (later) the matching `}` so the interpolation's net brace
		// contribution is zero; keep the expression between.
		blank(i);
		blank(i + 1);
		stack.push({ k: "code", brace: 0, expr: true });
		return { i: i + 2, prevChar };
	}
	blank(i);
	return { i: i + 1, prevChar };
}

/**
 * In a `code` frame, handle the char if it OPENS a comment / string / template /
 * regex frame (pushing that frame). Returns the step, or `null` when the char is
 * not a frame opener and brace/whitespace handling should run instead.
 */
function stepCodeOpener(
	content: string,
	n: number,
	i: number,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep | null {
	const c = content[i] ?? "";
	const c2 = i + 1 < n ? (content[i + 1] ?? "") : "";
	if (c === "/" && c2 === "/") {
		let j = i;
		while (j < n && content[j] !== "\n") {
			blank(j);
			j += 1;
		}
		return { i: j, prevChar };
	}
	if (c === "/" && c2 === "*") {
		blank(i);
		blank(i + 1);
		stack.push({ k: "block" });
		return { i: i + 2, prevChar };
	}
	if (c === '"' || c === "'") {
		blank(i);
		stack.push({ k: "str", quote: c });
		return { i: i + 1, prevChar };
	}
	if (c === "`") {
		blank(i);
		stack.push({ k: "tmpl" });
		return { i: i + 1, prevChar };
	}
	if (c === "/" && isRegexStart(prevChar, content, i)) {
		blank(i);
		stack.push({ k: "regex", cls: false });
		return { i: i + 1, prevChar };
	}
	return null;
}

/** In a `code` frame, handle `{` / `}` brace tracking and the plain-char tail. */
function stepCodeBrace(
	content: string,
	i: number,
	top: Extract<ScanFrame, { k: "code" }>,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep {
	const c = content[i] ?? "";
	if (c === "{") {
		top.brace += 1;
		return { i: i + 1, prevChar: "{" };
	}
	if (c === "}") {
		if (top.expr && top.brace === 0) {
			blank(i); // closes the `${…}` interpolation
			stack.pop();
			return { i: i + 1, prevChar: "v" };
		}
		top.brace -= 1;
		return { i: i + 1, prevChar: "}" };
	}
	return { i: i + 1, prevChar: /\s/.test(c) ? prevChar : c };
}

/** Consume one char in a `code` frame (top-level or inside a `${…}` expr). */
function stepCode(
	content: string,
	n: number,
	i: number,
	top: Extract<ScanFrame, { k: "code" }>,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep {
	return (
		stepCodeOpener(content, n, i, stack, prevChar, blank) ??
		stepCodeBrace(content, i, top, stack, prevChar, blank)
	);
}

/** Dispatch one scan step to the handler for the active frame kind. */
function stepScan(
	content: string,
	n: number,
	i: number,
	top: ScanFrame,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep {
	switch (top.k) {
		case "str":
			return stepStr(content, n, i, top, stack, prevChar, blank);
		case "block":
			return stepBlock(content, i, stack, prevChar, blank);
		case "regex":
			return stepRegex(content, i, top, stack, prevChar, blank);
		case "tmpl":
			return stepTmpl(content, n, i, stack, prevChar, blank);
		default:
			return stepCode(content, n, i, top, stack, prevChar, blank);
	}
}

/**
 * Brace-balanced strip for SCOPE / COMPLEXITY analysis (`cyclomatic.ts`,
 * `complexity.ts`). Replaces comment / string / template-text / regex
 * characters with spaces (newlines kept, so line + column positions stay
 * stable) while preserving structural code — including the expression inside
 * `${…}` interpolations, whose `${` and matching `}` are themselves removed so
 * each interpolation's net brace contribution is zero. `strip-brace-balance`
 * pins the resulting `{`/`}` balance.
 *
 * Distinct from {@link stripCommentsAndStrings} ON PURPOSE: this blanks string
 * delimiters and strips regex bodies (correct for brace/keyword scope
 * counting), whereas the general stripper keeps delimiters and leaves regex
 * intact — a contract its ~50 consumers rely on. Do not merge them.
 */
export function stripForBraceScan(content: string): string {
	const out = content.split("");
	const n = content.length;
	const blank = (idx: number): void => {
		const ch = out[idx];
		if (ch !== "\n" && ch !== "\r") out[idx] = " ";
	};
	const stack: ScanFrame[] = [{ k: "code", brace: 0, expr: false }];

	let i = 0;
	let prevChar = ""; // last significant (non-whitespace) code char
	while (i < n) {
		// SAFETY: the initial code frame has expr=false and is never popped; only nested literal/interpolation frames close.
		const top = stack[stack.length - 1] as ScanFrame;
		const step = stepScan(content, n, i, top, stack, prevChar, blank);
		i = step.i;
		prevChar = step.prevChar;
	}
	return out.join("");
}
