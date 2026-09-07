// One-hop alias resolution for `test-discrimination-fallback.ts`'s
// sibling-visibility rule.
//
// The file-level sibling rule links `expect(parse(x))` and `expect(parse(y))`
// by their literal call text — but real tests routinely bind the SUT's
// result to a variable first (`const rows = parse(x); expect(rows[0].id)…`),
// which the literal-text rule can't see through: the pinning assertion's
// subject is `rows[0].id`, not `parse(...)`, so a fallback-only sibling on
// the SAME underlying call reads as unpinned. Closing that gap needs real
// dataflow in general, but ONE hop covers the overwhelmingly common shape:
// a single `const`/`let` (or one destructure) binding the SUT call directly.
// So: record every such binding — per `it()` block AND at file/describe
// scope, since fixtures are often built once and shared across tests — and
// when an assertion subject's head identifier matches a recorded binding,
// resolve the subject to the BINDING'S call target instead of its own
// property path (`rows[0].id` → the target `rows` was bound to).
//
// A second, narrower rule folds `JSON.parse(x)` / `String(x)` / `Number(x)`
// wrappers to whatever `x` names: this trio wraps unrelated SUT calls across
// a codebase (every `captureStdio`-based CLI test calls `JSON.parse` on its
// own captured stdout), so using the wrapper's own name as the sibling key
// would silently link tests that have nothing to do with each other. Using
// the wrapped argument instead (or, one hop further, ITS call target) keeps
// the key specific to what's actually being parsed.
//
// No dataflow engine: a variable reassigned, destructured twice, or bound
// through a helper function is simply not resolved — the caller falls back
// to the plain call/property-path target, exactly as before this module
// existed.

import { findCallSpan } from "./test-hygiene-shared.js";
import { innermostBlockAt, type TestBlock } from "./test-structure.js";

/** Call names whose own name must never become the sibling-matching target
 *  — they wrap unrelated SUT calls throughout a codebase. */
const UNWRAP_CALL_NAMES = new Set(["JSON.parse", "String", "Number"]);

interface ParsedCall {
	/** Callee identifier path when `isCall`; the whole (whitespace-collapsed)
	 *  subject text otherwise. */
	target: string;
	/** Raw argument-list text when `isCall`; `""` otherwise. */
	argsText: string;
	isCall: boolean;
}

// An arrow-function wrapper (`() => run(dir)`, `async () => …`, `x => …`) —
// stripped BEFORE the subject's own call/property target is resolved, so
// `expect(() => run(dir)).not.toThrow()` keys on `run` like a direct
// `expect(run(dir))` would, instead of on the arrow syntax itself. Requires
// no space between the keyword/param and what follows because the caller
// strips this before the general whitespace collapse (mirrors how
// `await\s+` is stripped early, for the same reason: collapsing whitespace
// first would fuse `async x` into `asyncx`).
const ARROW_PREFIX_RE = /^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/;

/** Strip one leading arrow-function wrapper (`(...) =>` / `async (...) =>` /
 *  `x =>`), if present. */
function stripArrowPrefix(raw: string): string {
	const m = ARROW_PREFIX_RE.exec(raw);
	return m ? raw.slice(m[0].length) : raw;
}

/**
 * A call immediately followed by member access only (`<calleePath>(<args>)
 * <propertyTail>`, e.g. `out.get("x")?.previous_state`) — no further
 * operators. Reduces to the SAME `{ target: calleePath, argsText }` shape a
 * bare call produces, discarding the property tail, so a direct occurrence
 * of `foo(x).bar` keys identically to a `const y = foo(x).bar` binding's
 * alias (which already discards everything past the call at declaration
 * time). `null` when the string isn't shaped this way. */
function callThenPropertyTarget(s: string): { target: string; argsText: string } | null {
	const calleeMatch = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(/.exec(s);
	if (!calleeMatch) return null;
	const openParen = calleeMatch[0].length - 1; // index of the "(" itself
	let depth = 0;
	let closeIdx = -1;
	for (let i = openParen; i < s.length; i++) {
		const ch = s[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) {
				closeIdx = i;
				break;
			}
		}
	}
	if (closeIdx === -1) return null;
	// A `!` non-null assertion right after the call's closing paren
	// (`foo(x)!.bar`) is transparent to the target — strip ONE leading bang
	// before matching the property/index tail, so a call-then-bang-then-
	// property subject resolves to the same target as the plain form.
	const rawTail = s.slice(closeIdx + 1);
	const tail = rawTail.startsWith("!") ? rawTail.slice(1) : rawTail;
	if (tail === "" || !/^(?:\??\.[A-Za-z_$][\w$]*|\[[^[\]]*\])+$/.test(tail)) return null;
	return { target: calleeMatch[1] ?? "", argsText: s.slice(openParen + 1, closeIdx) };
}

/** Leading dotted-identifier prefix of a string, stopping at the first
 *  non-identifier character (typically `(`). */
const LEADING_IDENT_PATH_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/;

/** A CHAINED call's callee text (`f(x).get` from `f(x).get(y)`) embeds an
 *  earlier call's own parens — reduce it to just the BASE callee (`f`): the
 *  outermost call in a chain is rarely the meaningful sibling key, the
 *  object the chain starts from is (mirrors `callThenPropertyTarget`'s
 *  discard-the-tail coarsening, applied to a call-then-call chain instead of
 *  a call-then-property one). No-op when `calleePath` has no embedded call. */
function baseCalleeOf(calleePath: string): string {
	if (!calleePath.includes("(")) return calleePath;
	return LEADING_IDENT_PATH_RE.exec(calleePath)?.[0] ?? calleePath;
}

// `[...(EXPR)]` — an array-spread of a parenthesized expression, the shape
// `[...(seen[0]?.protectPids ?? [])]` produces. The default/spread wrapper
// carries no target information of its own; reducing it to EXPR lets it
// resolve identically to a bare `EXPR` subject elsewhere in the file. Greedy
// `.*` plus the anchored `)]$` correctly finds the OUTERMOST spread's own
// parens even when EXPR itself contains nested `)]` sequences.
const ARRAY_SPREAD_WRAPPER_RE = /^\[\.\.\.\((.*)\)\]$/;

/** Strip one `[...( ... )]` array-spread wrapper, if the whole (whitespace-
 *  collapsed) string is shaped that way. No-op otherwise. */
function stripArraySpreadWrapper(s: string): string {
	const m = ARRAY_SPREAD_WRAPPER_RE.exec(s);
	return m?.[1] ?? s;
}

/** Cut a subject at its first TOP-LEVEL `??` (nullish-coalescing) operator,
 *  keeping only the left-hand side — `firstSweep(seen).dryRun ?? false`
 *  resolves the same way as `firstSweep(seen).dryRun` since the fallback
 *  literal carries no target information. Depth-tracked over `()[]{}` so a
 *  `??` nested inside the call's OWN arguments (`build(x ?? y).total`) is
 *  left alone — only a `??` outside every bracket is a "default" applied to
 *  the whole subject. No-op when no top-level `??` is present. */
function stripTrailingNullishDefault(s: string): string {
	let depth = 0;
	for (let i = 0; i < s.length - 1; i++) {
		const ch = s[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (depth === 0 && ch === "?" && s[i + 1] === "?") return s.slice(0, i);
	}
	return s;
}

/** Parse a subject/argument expression: strip a leading `await` and any
 *  arrow-function wrapper, collapse whitespace, unwrap an array-spread
 *  wrapper and a trailing top-level `?? <default>`, then resolve either a
 *  trailing balanced `(...)` call or a call-then-property-access shape into
 *  its callee and argument text. */
function parseCallShape(raw: string): ParsedCall {
	const unwrapped = stripArrowPrefix(raw.trim().replace(/^await\s+/, ""));
	const s = stripTrailingNullishDefault(stripArraySpreadWrapper(unwrapped.replace(/\s+/g, "")));
	if (s.endsWith(")")) {
		let depth = 0;
		for (let i = s.length - 1; i >= 0; i--) {
			const ch = s[i];
			if (ch === ")") depth++;
			else if (ch === "(") {
				depth--;
				if (depth === 0) {
					const rawCallee = s.slice(0, i);
					const target = baseCalleeOf(rawCallee);
					return { target, argsText: s.slice(i + 1, s.length - 1), isCall: true };
				}
			}
		}
	}
	const tailCall = callThenPropertyTarget(s);
	if (tailCall) return { target: tailCall.target, argsText: tailCall.argsText, isCall: true };
	return { target: s, argsText: "", isCall: false };
}

/** Resolve one call's effective sibling-matching target: unwraps a
 *  `JSON.parse`/`String`/`Number` wrapper to its argument's own target
 *  (one hop), otherwise the callee itself. */
function resolveCallTarget(calleePath: string, argsText: string): string {
	if (!UNWRAP_CALL_NAMES.has(calleePath) || argsText.trim() === "") return calleePath;
	return parseCallShape(argsText).target;
}

/** The effective target for an `expect(...)` subject with NO alias applied
 *  — a call resolves through {@link resolveCallTarget}; a plain property
 *  path (no trailing call) keys on its own text. */
export function plainSubjectTarget(subjectRaw: string): string {
	const parsed = parseCallShape(subjectRaw);
	return parsed.isCall ? resolveCallTarget(parsed.target, parsed.argsText) : parsed.target;
}

/** Per-file alias state: bindings declared outside any `it()`/`test()` body
 *  (shared fixtures) plus bindings declared inside one specific block. */
export interface AliasMaps {
	fileAliases: Map<string, string>;
	blockAliases: Map<number, Map<string, string>>;
}

/** Index of the nearest enclosing `kind: "test"` block containing `line`,
 *  walking up through `describe`/`suite` ancestors — or -1 (file/describe
 *  scope) when no test block contains it. */
function enclosingTestBlockIndex(blocks: TestBlock[], line: number): number {
	let idx = innermostBlockAt(blocks, line);
	while (idx !== -1) {
		const b = blocks[idx];
		if (!b) return -1;
		if (b.kind === "test") return idx;
		idx = b.parent;
	}
	return -1;
}

/** Record one alias binding at the scope its declaration line falls in. */
function recordAlias(maps: AliasMaps, blocks: TestBlock[], line: number, name: string, target: string): void {
	const blockIdx = enclosingTestBlockIndex(blocks, line);
	if (blockIdx === -1) {
		maps.fileAliases.set(name, target);
		return;
	}
	let local = maps.blockAliases.get(blockIdx);
	if (!local) {
		local = new Map();
		maps.blockAliases.set(blockIdx, local);
	}
	local.set(name, target);
}

/** 0-based line index containing char offset `index` in `text`. */
function lineOf(text: string, index: number): number {
	let line = 0;
	for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

/**
 * Chase ONE hop through an existing alias when a NEW binding's own callee is
 * itself an aliased variable — `const out = readTddCycles(x); const entry =
 * out.get(k);` must alias `entry` to "readTddCycles", not the literal
 * "out.get", so `entry`'s sibling-matching target lines up with a plain
 * `out.get(k)` occurrence elsewhere (which resolves through the SAME
 * head-identifier alias check in {@link resolveSubjectTarget}). Checked in
 * the SAME scope order: current block first, then file scope. Returns
 * `calleePath` unchanged when its head identifier isn't aliased.
 */
function resolveCalleeThroughAlias(calleePath: string, blockIdx: number, maps: AliasMaps): string {
	const head = calleePath.split(".")[0] ?? "";
	const local = maps.blockAliases.get(blockIdx)?.get(head);
	if (local !== undefined) return local;
	const fileLevel = maps.fileAliases.get(head);
	return fileLevel !== undefined ? fileLevel : calleePath;
}

// A name bound from `import(...)`/`require(...)` is a MODULE REFERENCE, not
// a computed value — `const { runGoBuild } = await import("./go.js")` makes
// `runGoBuild` the SUT function itself. Recording it as an alias to "import"
// (the calleePath) made every later `runGoBuild(...)` call site resolve to
// the bogus shared target "import" instead of "runGoBuild", silently
// breaking sibling-pin matching across the whole file — found via
// go.integration.test.ts's `const { runGoBuild, runGolangciLint } = await
// import("./go.js")` (a common post-`vi.mock` pattern in this codebase).
const MODULE_BINDING_CALL_NAMES = new Set(["import", "require"]);

const SIMPLE_DECL_RE =
	/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;

/** `const|let <name> = (await )?<callTarget>(...)` bindings. Skips
 *  `import(...)`/`require(...)` — see {@link MODULE_BINDING_CALL_NAMES}. */
function collectSimpleAliases(masked: string, blocks: TestBlock[], maps: AliasMaps): void {
	SIMPLE_DECL_RE.lastIndex = 0;
	let m: RegExpExecArray | null = SIMPLE_DECL_RE.exec(masked);
	while (m !== null) {
		const openParen = m.index + m[0].length;
		const span = findCallSpan(masked, openParen);
		if (span === null) break;
		const name = m[1] ?? "";
		const rawCalleePath = m[2] ?? "";
		if (!MODULE_BINDING_CALL_NAMES.has(rawCalleePath)) {
			const line = lineOf(masked, m.index);
			const blockIdx = enclosingTestBlockIndex(blocks, line);
			const calleePath = resolveCalleeThroughAlias(rawCalleePath, blockIdx, maps);
			const argsText = masked.slice(openParen, span.end);
			const target = calleePath === rawCalleePath ? resolveCallTarget(calleePath, argsText) : calleePath;
			recordAlias(maps, blocks, line, name, target);
		}
		SIMPLE_DECL_RE.lastIndex = span.end + 1;
		m = SIMPLE_DECL_RE.exec(masked);
	}
}

/** Extract bound identifier names from a `{ a, b: c, d = 1 }` pattern body
 *  (renames use the LOCAL name; default values are stripped). */
function destructuredNames(inner: string): string[] {
	const names: string[] = [];
	for (const rawPart of inner.split(",")) {
		let part = rawPart.trim();
		if (part === "") continue;
		const colon = part.indexOf(":");
		if (colon !== -1) part = part.slice(colon + 1).trim();
		const eq = part.indexOf("=");
		if (eq !== -1) part = part.slice(0, eq).trim();
		if (/^[A-Za-z_$][\w$]*$/.test(part)) names.push(part);
	}
	return names;
}

const DESTRUCTURE_DECL_RE =
	/\b(?:const|let)\s*\{([^{}]*)\}\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;

/** `const { a, b } = <callTarget>(...)` bindings — every destructured name
 *  aliases to the SAME (coarse) call target. Skips `import(...)`/
 *  `require(...)` — see {@link MODULE_BINDING_CALL_NAMES}: a name
 *  destructured from a dynamic import IS the SUT function, not a value
 *  aliased to the import call. */
function collectDestructureAliases(masked: string, blocks: TestBlock[], maps: AliasMaps): void {
	DESTRUCTURE_DECL_RE.lastIndex = 0;
	let m: RegExpExecArray | null = DESTRUCTURE_DECL_RE.exec(masked);
	while (m !== null) {
		const openParen = m.index + m[0].length;
		const span = findCallSpan(masked, openParen);
		if (span === null) break;
		const rawCalleePath = m[2] ?? "";
		if (!MODULE_BINDING_CALL_NAMES.has(rawCalleePath)) {
			const names = destructuredNames(m[1] ?? "");
			const line = lineOf(masked, m.index);
			const blockIdx = enclosingTestBlockIndex(blocks, line);
			const calleePath = resolveCalleeThroughAlias(rawCalleePath, blockIdx, maps);
			const argsText = masked.slice(openParen, span.end);
			const target = calleePath === rawCalleePath ? resolveCallTarget(calleePath, argsText) : calleePath;
			for (const name of names) recordAlias(maps, blocks, line, name, target);
		}
		DESTRUCTURE_DECL_RE.lastIndex = span.end + 1;
		m = DESTRUCTURE_DECL_RE.exec(masked);
	}
}

// `const|let <name> = (await )?<basePath>[<index>]` — a plain index/bracket
// access, not a call, so the alias target is the base path AS-IS (no
// `resolveCallTarget` unwrap — there is no callee to unwrap). A single
// `[...]` level only (no nested brackets in the index expression), matching
// the shapes actually seen (`OBJ[key]`, `rows[0]`).
const INDEX_DECL_RE =
	/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\[[^[\]]*\]/g;

/** `const|let <name> = <basePath>[<index>]` bindings. */
function collectIndexAliases(masked: string, blocks: TestBlock[], maps: AliasMaps): void {
	INDEX_DECL_RE.lastIndex = 0;
	let m: RegExpExecArray | null = INDEX_DECL_RE.exec(masked);
	while (m !== null) {
		const name = m[1] ?? "";
		const base = m[2] ?? "";
		recordAlias(maps, blocks, lineOf(masked, m.index), name, base);
		INDEX_DECL_RE.lastIndex = m.index + m[0].length;
		m = INDEX_DECL_RE.exec(masked);
	}
}

/** Scan the whole (masked) file once for one-hop alias bindings, split into
 *  file-scope (outside any test block) and per-block maps. */
export function collectAliases(masked: string, blocks: TestBlock[]): AliasMaps {
	const maps: AliasMaps = { fileAliases: new Map(), blockAliases: new Map() };
	collectSimpleAliases(masked, blocks, maps);
	collectDestructureAliases(masked, blocks, maps);
	collectIndexAliases(masked, blocks, maps);
	return maps;
}

/** The maximal leading identifier of a (trimmed) subject expression, or ""
 *  when it doesn't start with one (a literal, a parenthesized expression). */
function headIdentifier(subjectRaw: string): string {
	const s = subjectRaw.trim().replace(/^await\s+/, "");
	return /^[A-Za-z_$][\w$]*/.exec(s)?.[0] ?? "";
}

/**
 * Resolve an `expect(...)` subject to its sibling-matching target: if the
 * subject's head identifier is a recorded alias (checked in the CURRENT
 * block's own bindings first, then file/describe-scope bindings), use the
 * alias's call target — `rows[0].id` resolves to whatever `rows` was bound
 * to. Otherwise falls back to the subject's own plain call/property target.
 */
export function resolveSubjectTarget(subjectRaw: string, blockIdx: number, maps: AliasMaps): string {
	const head = headIdentifier(subjectRaw);
	if (head !== "") {
		const local = maps.blockAliases.get(blockIdx)?.get(head);
		if (local !== undefined) return local;
		const fileLevel = maps.fileAliases.get(head);
		if (fileLevel !== undefined) return fileLevel;
	}
	return plainSubjectTarget(subjectRaw);
}
