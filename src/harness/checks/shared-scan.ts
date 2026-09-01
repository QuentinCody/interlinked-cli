// interlinked-tdd: exempt
// Code-shape scanning helpers extracted from shared.ts (no behavior change):
//   - isTypeOnlyModule + its top-level-statement scanner
//   - findEnclosingScope + its declaration matcher
// Both depend only on stripCommentsAndStrings. Leaf module: shared.ts
// re-exports the two public entry points so existing importers are unchanged.

import { stripCommentsAndStrings } from "./shared-text-utils.js";

/**
 * Detect a TypeScript module whose entire surface is type-level — only
 * `interface` / `type` declarations (plus imports and type re-exports),
 * with no runtime code. Such a module emits nothing executable; `tsc`
 * already validates it, so checks that demand a `.test.<ext>` sibling
 * (`no_test_file`, the TDD-cycle nudges) only ever false-positive on it.
 * The harness's own `src/harness/types/*.ts` were the recurring trigger.
 *
 * TS-only by extension: `interface` / `type` are not reliable type-only
 * markers in Go (`type X struct`) or JS, so non-TS files return false.
 *
 * Conservative — any top-level runtime declaration, import/export, or
 * expression statement marks the module NOT type-only. A file with even one
 * runtime value is still checked; the failure mode is "check a file that
 * needn't be tested", never "skip a real one".
 */
export function isTypeOnlyModule(filePath: string, content: string): boolean {
	if (!/\.(?:ts|tsx|mts|cts)$/i.test(filePath)) return false;
	const code = stripCommentsAndStrings(content);
	// Must declare at least one type — otherwise "type-only" is vacuous
	// (an empty file, a pure side-effect import module, etc.).
	if (!/^[ \t]*(?:export[ \t]+)?(?:interface|type)[ \t]/m.test(code)) {
		return false;
	}
	// `export default <expr>` ships a runtime value even with no keyword.
	if (/^[ \t]*export[ \t]+default\b/m.test(code)) return false;
	if (!hasOnlyTypeLevelTopLevelStatements(code)) return false;
	return true;
}

type TypeOnlyTopLevelMode = "import-type" | "type" | "interface";

function hasOnlyTypeLevelTopLevelStatements(code: string): boolean {
	let offset = 0;

	for (;;) {
		offset = skipWhitespace(code, offset);
		if (offset >= code.length) return true;

		const mode = typeOnlyTopLevelModeAt(code, offset);
		if (mode === null) return false;

		const nextOffset = findTypeOnlyStatementEnd(code, offset, mode);
		if (nextOffset === null || nextOffset <= offset) return false;
		offset = nextOffset;
	}
}

function skipWhitespace(code: string, offset: number): number {
	let i = offset;
	while (i < code.length && /\s/.test(code[i] ?? "")) i++;
	return i;
}

function typeOnlyTopLevelModeAt(code: string, offset: number): TypeOnlyTopLevelMode | null {
	const rest = code.slice(offset);
	if (/^import[ \t]+type\b/.test(rest)) return "import-type";
	if (/^(?:export[ \t]+)?type\b/.test(rest)) return "type";
	if (/^(?:export[ \t]+)?interface\b/.test(rest)) return "interface";
	return null;
}

/** Mutable bracket-nesting bookkeeping for a single top-level statement scan.
 *  `interfaceSawBody` records whether the interface's `{ … }` body has opened
 *  yet — used to distinguish `interface X {}` completion from a stray brace. */
interface TypeOnlyScanState {
	braceDepth: number;
	bracketDepth: number;
	parenDepth: number;
	interfaceSawBody: boolean;
}

/** True when no bracket/brace/paren is currently open — i.e. we're back at the
 *  statement's top level and a `;` or newline can legitimately terminate it. */
function atTopLevelDepth(state: TypeOnlyScanState): boolean {
	return state.braceDepth === 0 && state.bracketDepth === 0 && state.parenDepth === 0;
}

/** Advance the nesting depths for a single bracket-class character. Non-bracket
 *  characters leave the state untouched. For `interface` mode, opening the first
 *  `{` flips `interfaceSawBody` so the matching close can be recognized. */
function updateTypeOnlyScanDepth(
	state: TypeOnlyScanState,
	ch: string | undefined,
	mode: TypeOnlyTopLevelMode,
): void {
	if (ch === "{") {
		state.braceDepth++;
		if (mode === "interface") state.interfaceSawBody = true;
	} else if (ch === "}") {
		state.braceDepth = Math.max(0, state.braceDepth - 1);
	} else if (ch === "[") {
		state.bracketDepth++;
	} else if (ch === "]") {
		state.bracketDepth = Math.max(0, state.bracketDepth - 1);
	} else if (ch === "(") {
		state.parenDepth++;
	} else if (ch === ")") {
		state.parenDepth = Math.max(0, state.parenDepth - 1);
	}
}

/**
 * Decide whether the current character at index `i` ends the type-only
 * statement, returning the index just past the statement (or `null` to keep
 * scanning). Called AFTER `updateTypeOnlyScanDepth` has applied this character's
 * depth change, so an interface's closing `}` is seen at `braceDepth === 0`.
 */
function typeOnlyStatementEndAt(
	code: string,
	i: number,
	ch: string | undefined,
	mode: TypeOnlyTopLevelMode,
	state: TypeOnlyScanState,
): number | null {
	if (ch === "}" && mode === "interface" && state.interfaceSawBody && state.braceDepth === 0) {
		return consumeOptionalSemicolon(code, i + 1);
	}
	if (ch === ";" && atTopLevelDepth(state)) {
		return i + 1;
	}
	if (
		ch === "\n" &&
		mode !== "interface" &&
		atTopLevelDepth(state) &&
		canEndTypeOnlyStatementAtNewline(code, i, mode)
	) {
		return i + 1;
	}
	return null;
}

function findTypeOnlyStatementEnd(
	code: string,
	offset: number,
	mode: TypeOnlyTopLevelMode,
): number | null {
	const state: TypeOnlyScanState = {
		braceDepth: 0,
		bracketDepth: 0,
		parenDepth: 0,
		interfaceSawBody: false,
	};

	for (let i = offset; i < code.length; i++) {
		const ch = code[i];
		updateTypeOnlyScanDepth(state, ch, mode);
		const end = typeOnlyStatementEndAt(code, i, ch, mode, state);
		if (end !== null) return end;
	}

	if (!atTopLevelDepth(state)) return null;
	if (mode === "interface" && !state.interfaceSawBody) return null;
	return code.length;
}

function consumeOptionalSemicolon(code: string, offset: number): number {
	let i = offset;
	while (i < code.length && (code[i] === " " || code[i] === "\t" || code[i] === "\r")) {
		i++;
	}
	return code[i] === ";" ? i + 1 : offset;
}

function canEndTypeOnlyStatementAtNewline(
	code: string,
	newlineOffset: number,
	mode: TypeOnlyTopLevelMode,
): boolean {
	const nextLineStart = newlineOffset + 1;
	const nextLineEnd = code.indexOf("\n", nextLineStart);
	const nextLine =
		nextLineEnd === -1
			? code.slice(nextLineStart).trim()
			: code.slice(nextLineStart, nextLineEnd).trim();
	if (nextLine.length === 0) return true;
	if (mode === "import-type") return !/^from\b/.test(nextLine);
	return !(
		/^[|&=?:,\]>)]/.test(nextLine) ||
		/^(?:keyof|readonly|infer|typeof|unique|this)\b/.test(nextLine)
	);
}

// ===========================================
// Enclosing-scope detection — used to give findings context
// ===========================================
// When a finding fires at a specific line, we want to tell the caller
// *which function/class/method* the line belongs to. This saves the
// agent from re-reading the file just to triage the warning. We avoid
// AST parsing — strip comments/strings, then scan backwards looking
// for the nearest declaration whose body opens before our target line.
// Heuristic only; meant for log annotations, not refactoring.

const SCOPE_DECLARATION_RES: readonly RegExp[] = [
	// `function name(` or `function* name(` or `async function name(`
	/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
	// `class Name` (with optional extends/implements)
	/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/,
	// `const|let|var name = (...) => {` or `... = function (...) {`
	/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
	/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/,
	// Class method: `methodName(args) {` or `async methodName(args) {`
	// Indented (inside a class body). Excludes control keywords.
	/^\s+(?:async\s+|static\s+|public\s+|private\s+|protected\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
];

const SCOPE_KEYWORD_BLACKLIST = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"return",
	"do",
	"with",
	"throw",
	"typeof",
	"new",
	"in",
	"of",
	"as",
]);

/**
 * Find the name of the nearest enclosing function / arrow / class / method
 * for a 1-based line number. Returns null if the line is at top-level (no
 * enclosing scope) or detection fails.
 *
 * Public API — consumed by `quality-checks.ts` to annotate findings with
 * the enclosing scope so cold readers don't have to open the file just to
 * see "what function is this line in?". Heuristic; tolerant of comments
 * and string literals via `stripCommentsAndStrings` upstream.
 */
export function findEnclosingScope(content: string, line: number): string | null {
	const stripped = stripCommentsAndStrings(content);
	const lines = stripped.split("\n");
	const targetIdx = Math.max(0, Math.min(line - 1, lines.length - 1));

	// Walk backwards looking for the nearest declaration whose `{` opens
	// at or before the target line. We don't try to verify scope-end —
	// reporting the closest enclosing name is good enough for triage.
	for (let i = targetIdx; i >= 0; i--) {
		const candidate = lines[i];
		if (candidate === undefined) continue;
		const name = matchScopeDeclaration(candidate);
		if (name && !SCOPE_KEYWORD_BLACKLIST.has(name)) {
			return name;
		}
	}
	return null;
}

function matchScopeDeclaration(line: string): string | null {
	for (const re of SCOPE_DECLARATION_RES) {
		const m = re.exec(line);
		if (m) return m[1] ?? null;
	}
	return null;
}

// ===========================================
// Elapsed-duration shape (`const t0 = Date.now(); … Date.now() - t0`)
// ===========================================
// Shared by the two nondeterminism detectors that were written from the same
// regex and had drifted apart: `checkTestNondeterminism` (test files, which
// has exempted this shape since the 2026-07 verify-noise calibration) and
// `checkUntestableTimeInSource` (non-test source, which did not).
//
// The shape is exempt because subtracting two clock reads yields a DURATION:
// the wall-clock value never escapes as an absolute, and injecting a clock
// would defeat the measurement outright — a fake clock measures fake elapsed
// time, i.e. nothing. That argument is if anything stronger in production
// source than in tests, which is why keeping the two in sync matters.
//
// Known and deliberate limit (inherited, not introduced): the ANCHOR line is
// exempt on the strength of the file containing a matching subtraction, so an
// anchor whose value ALSO escapes as an absolute (`const T0 = Date.now();
// record({ at: T0 })`) is exempt too. Both detectors are warning-only
// heuristics; tightening this needs use-site dataflow, not a wider regex.

/** `const t0 = Date.now()` / `let start = performance.now()` — candidate anchors. */
const TIMER_ANCHOR_ASSIGN_RE =
	/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Date|performance)\s*\.\s*now\s*\(\s*\)/g;

/**
 * Identifiers assigned from `Date.now()` / `performance.now()` that the file
 * later subtracts from a second read (`Date.now() - t0`) — the elapsed-time
 * shape. Takes comment/string-stripped content so a literal in a docstring
 * cannot mint an anchor.
 */
export function collectElapsedTimeAnchors(stripped: string): Set<string> {
	const anchors = new Set<string>();
	for (const m of stripped.matchAll(TIMER_ANCHOR_ASSIGN_RE)) {
		const ident = m[1];
		if (ident === undefined) continue;
		const escaped = ident.replace(/\$/g, "\\$");
		const subtraction = new RegExp(
			`(?:Date|performance)\\s*\\.\\s*now\\s*\\(\\s*\\)\\s*-\\s*${escaped}\\b`,
		);
		if (subtraction.test(stripped)) anchors.add(ident);
	}
	return anchors;
}

/**
 * True when the line is one half of an elapsed-time pair: the anchor
 * assignment (`const t0 = Date.now()`) or the delta (`Date.now() - t0`).
 */
export function isElapsedTimeLine(
	strippedLine: string,
	anchors: ReadonlySet<string>,
): boolean {
	for (const ident of anchors) {
		const escaped = ident.replace(/\$/g, "\\$");
		const assign = new RegExp(
			`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:Date|performance)\\s*\\.\\s*now\\s*\\(`,
		);
		const delta = new RegExp(
			`(?:Date|performance)\\s*\\.\\s*now\\s*\\(\\s*\\)\\s*-\\s*${escaped}\\b`,
		);
		if (assign.test(strippedLine) || delta.test(strippedLine)) return true;
	}
	return false;
}
