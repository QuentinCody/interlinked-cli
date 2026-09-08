// ===========================================
// Object-path walker for software-version anchors
// ===========================================
// Walks content once tracking object/array/block nesting so each line gets a
// parent key chain (e.g. "dependencies.lodash"). Without this, every
// "version" key in a lockfile maps to the same anchor and unchanged nested
// versions are wrongly compared against the first occurrence.
//
// Anonymous scopes are DISAMBIGUATED rather than collapsed: the old walker
// pushed a bare "{}"/"[]" for any brace without a preceding key, so two
// sibling it()-blocks (or functions) at equal nesting depth got IDENTICAL
// paths and their version-like fixtures were cross-compared — the
// software_version_regression cross-block false positive. Each anonymous
// scope now gets, in preference order:
//   1. the enclosing call + its first string argument  (`it:some title`)
//   2. the enclosing call alone                        (`fn:seedDemo`)
//   3. the nearest preceding identifier                (`id:legacyConfig`)
//   4. a per-parent occurrence counter                 (`{}#1`)
// The `#n` counter suffix is reserved grammar: anchors are grouped back into
// their pre-disambiguation "family" by stripping `#\d+` (see
// `anchorFamilyOf` in software-version-regression.ts), so literal segments
// have `#` sanitized away.

/** Mutable state for one anonymous-scope disambiguation walk. */
interface ScopeWalkState {
	stack: string[];
	/** Occurrence count per parent-path+segment so repeated siblings differ. */
	siblingCounts: Map<string, number>;
	/** Key literal/identifier immediately followed by `:` (JSON/object key). */
	lastKey: string | undefined;
	/** Identifier immediately before the most recent `(`. */
	lastCallee: string | undefined;
	/** Most recent string literal (a call's title argument, typically). */
	lastLiteral: string | undefined;
	/** Nearest completed identifier token (`const legacy = {` → "legacy"). */
	lastIdentifier: string | undefined;
	/** In-flight identifier accumulator. */
	identifier: string;
	inString: boolean;
	stringQuote: string;
	stringStart: number;
	escape: boolean;
}

const IDENT_CHAR_RE = /[A-Za-z0-9_$]/;

const MAX_LITERAL_SEGMENT_LENGTH = 48;

// Statement-shaped keywords that would otherwise become meaningless `id:*`
// segments (`return {` is positional, not a name).
const ANON_SEGMENT_KEYWORDS = new Set([
	"return",
	"else",
	"try",
	"do",
	"finally",
	"await",
	"yield",
	"new",
	"typeof",
	"void",
	"in",
	"of",
	"case",
	"default",
	"const",
	"let",
	"var",
]);

export function computeObjectPathByLine(content: string, lineCount: number): string[] {
	const out = new Array<string>(lineCount).fill("");
	const st: ScopeWalkState = {
		stack: [],
		siblingCounts: new Map(),
		lastKey: undefined,
		lastCallee: undefined,
		lastLiteral: undefined,
		lastIdentifier: undefined,
		identifier: "",
		inString: false,
		stringQuote: "",
		stringStart: -1,
		escape: false,
	};
	let lineIndex = 0;

	for (let i = 0; i < content.length; i++) {
		const ch = content.charAt(i);

		if (ch === "\n") {
			out[lineIndex] = st.stack.join(".");
			lineIndex++;
			completeIdentifier(st);
			if (lineIndex >= lineCount) break;
			continue;
		}

		if (st.inString) {
			consumeStringChar(st, content, i);
			continue;
		}

		if (ch === '"' || ch === "'") {
			completeIdentifier(st);
			st.inString = true;
			st.stringQuote = ch;
			st.stringStart = i;
			continue;
		}

		if (IDENT_CHAR_RE.test(ch)) {
			st.identifier += ch;
			continue;
		}

		consumeStructuralChar(st, ch);
	}

	if (lineIndex < lineCount) out[lineIndex] = st.stack.join(".");
	return out;
}

/** Flush the in-flight identifier accumulator into `lastIdentifier`. */
function completeIdentifier(st: ScopeWalkState): void {
	if (st.identifier) st.lastIdentifier = st.identifier;
	st.identifier = "";
}

function consumeStringChar(st: ScopeWalkState, content: string, i: number): void {
	const ch = content[i];
	if (st.escape) {
		st.escape = false;
		return;
	}
	if (ch === "\\") {
		st.escape = true;
		return;
	}
	if (ch !== st.stringQuote) return;
	st.inString = false;
	const literal = content.slice(st.stringStart + 1, i);
	st.lastLiteral = literal;
	let j = i + 1;
	while (j < content.length && (content[j] === " " || content[j] === "\t")) j++;
	if (content[j] === ":") st.lastKey = literal;
}

function consumeStructuralChar(st: ScopeWalkState, ch: string): void {
	if (ch === "(") {
		if (st.identifier) {
			st.lastCallee = st.identifier;
			// Only a literal that appears AFTER the call-open (its argument)
			// may name the scope; drop any stale one from earlier code.
			st.lastLiteral = undefined;
		}
	} else if (ch === ":" && st.identifier) {
		// Unquoted object key (`packages: {`). String-literal keys are
		// handled by the lookahead in consumeStringChar.
		st.lastKey = st.identifier;
	} else if (ch === ";") {
		resetScopeNaming(st);
	} else if (ch === ",") {
		// Commas separate siblings: an identifier before the comma belongs
		// to the previous sibling, but a call's title argument
		// (`it("x", () => {`) must survive to the arrow's brace.
		st.lastIdentifier = undefined;
	} else if (ch === "{" || ch === "[") {
		pushScope(st, ch);
	} else if (ch === "}" || ch === "]") {
		st.stack.pop();
		resetScopeNaming(st);
	}
	completeIdentifier(st);
}

function resetScopeNaming(st: ScopeWalkState): void {
	st.lastKey = undefined;
	st.lastCallee = undefined;
	st.lastLiteral = undefined;
	st.lastIdentifier = undefined;
}

function pushScope(st: ScopeWalkState, ch: string): void {
	const seg =
		(st.lastKey !== undefined ? sanitizeSegment(st.lastKey) : undefined) ??
		calleeSegment(st) ??
		identifierSegment(st) ??
		(ch === "[" ? "[]" : "{}");
	const parentKey = `${st.stack.join(".")}\0${seg}`;
	const n = st.siblingCounts.get(parentKey) ?? 0;
	st.siblingCounts.set(parentKey, n + 1);
	st.stack.push(n === 0 ? seg : `${seg}#${n}`);
	resetScopeNaming(st);
}

function calleeSegment(st: ScopeWalkState): string | undefined {
	if (!st.lastCallee) return undefined;
	return st.lastLiteral !== undefined
		? `${st.lastCallee}:${sanitizeSegment(st.lastLiteral)}`
		: `fn:${st.lastCallee}`;
}

function identifierSegment(st: ScopeWalkState): string | undefined {
	if (!st.lastIdentifier || ANON_SEGMENT_KEYWORDS.has(st.lastIdentifier)) return undefined;
	return `id:${st.lastIdentifier}`;
}

/** `#` is reserved for the sibling-occurrence counter (family grouping strips
 *  `#\d+`), so a literal containing it must not masquerade as a counter. */
function sanitizeSegment(literal: string): string {
	return literal.replace(/#/g, "~").slice(0, MAX_LITERAL_SEGMENT_LENGTH);
}
