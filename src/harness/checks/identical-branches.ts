// ===========================================================================
// Identical-branch detector — "the condition has no effect"
// ===========================================================================
// Flags a conditional whose branches produce the SAME thing both ways, so the
// condition is dead weight:
//
//   if condition {            cond ? val : val
//       val
//   } else {
//       val                   // ← byte-identical to the `then` branch
//   }
//
// This is a genuine correctness smell, not a style nit: either the author meant
// the branches to differ (latent bug) or the conditional is pure dead code.
// Mature linters agree — SonarQube S3923 ("all branches identical") classifies
// it a Bug, and Clippy's `if_same_then_else` is a deny-by-default *correctness*
// lint. We catch the same CLASS in any brace-delimited language.
//
// Two forms, both language-agnostic over the brace family (JS/TS, Rust, Go,
// Java, Kotlin, Swift, Scala, C/C++/ObjC, C#, PHP, Dart, Groovy, Zig):
//   1. block   — `if (...) { A } else { B }`   fires when norm(A) === norm(B)
//   2. ternary — `c ? X : Y`                    fires when norm(X) === norm(Y)
//
// Detection is text-based (partially_deterministic): STRUCTURE is found on the
// brace-balanced strip (`stripForBraceScan`, the same scanner the complexity
// gates trust for scope detection), and BODIES are compared on the
// comment-stripped / string-PRESERVING strip so `return "a"` vs `return "b"`
// never reads as identical. Indentation-delimited languages (Python, …) are
// deliberately out of scope — reliable suite extraction needs a real
// indentation pass (the Python cyclomatic gate shells to radon for the same
// reason), and a flaky version would violate the low-FP bar.
//
// Check id: identical_conditional_branches
// Phase:    pre_warn (edit-time priming), severity warning, default gate.

import {
	getExtension,
	type InlineMatch,
	isGeneratedFile,
	isVendoredOrFixturePath,
	stripComments,
	stripForBraceScan,
} from "./shared.js";

/** Brace-delimited languages where `if {…} else {…}` / `?:` are idiomatic. */
const BRACE_LANG_EXTS = new Set<string>([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
	".rs", ".go", ".java", ".kt", ".kts", ".swift", ".scala",
	".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx",
	".cs", ".php", ".dart", ".groovy", ".gradle", ".zig", ".m", ".mm",
]);

/** Cap findings per file — a flood from one file is noise, not signal. */
const MAX_MATCHES = 10;
/** Bound the forward ternary scan so a pathological line can't go quadratic. */
const TERNARY_SCAN_LIMIT = 2000;
/** Trim a branch snippet for the agent-facing locator text. */
const SNIPPET_MAX = 70;

// Rust lifetimes (`'a`, `'static`, `'_`) are an UNPAIRED apostrophe that the
// JS-oriented brace scanner would read as a string-literal opener, blanking the
// rest of the line — including any `{`/`}` on it, which unbalances the braces.
// Neutralize the leading apostrophe (length-preserving: `'a` → ` a`) before the
// scan, but only on Rust. A char literal (`'a'`) is left alone: its trailing
// `'` makes the negative lookahead fail.
const RUST_LIFETIME_RE = /'([a-zA-Z_][a-zA-Z0-9_]*)(?!')/g;

/** 1-based line number of a character index. */
function lineAt(content: string, index: number): number {
	let line = 1;
	const stop = Math.min(index, content.length);
	for (let i = 0; i < stop; i++) {
		if (content[i] === "\n") line += 1;
	}
	return line;
}

/**
 * Normalize a branch body for equality: collapse every whitespace run to one
 * space and trim. Slices come from comment-stripped source, so comments are
 * already blanked — two branches with identical code but differing comments
 * still compare equal (the behavior is identical). String literals are
 * preserved, so differing string contents keep the branches distinct.
 */
function normalizeBody(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Trim a normalized body to a short, single-line snippet for display. */
function snippet(body: string): string {
	return body.length > SNIPPET_MAX ? `${body.slice(0, SNIPPET_MAX)}…` : body;
}

/** Index of the `{` matching the `}` at `closerIdx`, scanning left. -1 if none. */
function matchOpenBrace(scan: string, closerIdx: number): number {
	let depth = 0;
	for (let i = closerIdx; i >= 0; i--) {
		const ch = scan[i];
		if (ch === "}") depth += 1;
		else if (ch === "{") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Index of the `}` matching the `{` at `openerIdx`, scanning right. -1 if none. */
function matchCloseBrace(scan: string, openerIdx: number): number {
	let depth = 0;
	for (let i = openerIdx; i < scan.length; i++) {
		const ch = scan[i];
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * `} else {` block form. For each else-block, compare the body that just closed
 * (the `then` arm, or the trailing `else if` arm of a chain) against the else
 * body. Catches the canonical two-branch case and the identical tail of an
 * if / else-if / else chain.
 */
function findIdenticalBlocks(
	scan: string,
	noComments: string,
	content: string,
): InlineMatch[] {
	const out: InlineMatch[] = [];
	// `}` ws* `else` ws* `{`. The `}` boundary excludes `let … else {`
	// (Rust let-else) and `guard … else {` (Swift), where `else` follows the
	// condition rather than a closing brace. `else if (…) {` does not match
	// (the `{` is gated behind `if`), so only a chain's final else is compared.
	const re = /\}[ \t\r\n]*else[ \t\r\n]*\{/g;
	let m = re.exec(scan);
	while (m !== null) {
		const thenCloseIdx = m.index;
		const elseOpenIdx = m.index + m[0].length - 1;
		const finding = compareBlockArms(scan, noComments, content, thenCloseIdx, elseOpenIdx);
		if (finding !== null) out.push(finding);
		if (out.length >= MAX_MATCHES) break;
		m = re.exec(scan);
	}
	return out;
}

function compareBlockArms(
	scan: string,
	noComments: string,
	content: string,
	thenCloseIdx: number,
	elseOpenIdx: number,
): InlineMatch | null {
	const thenOpenIdx = matchOpenBrace(scan, thenCloseIdx);
	const elseCloseIdx = matchCloseBrace(scan, elseOpenIdx);
	if (thenOpenIdx === -1 || elseCloseIdx === -1) return null;
	const thenBody = normalizeBody(noComments.slice(thenOpenIdx + 1, thenCloseIdx));
	const elseBody = normalizeBody(noComments.slice(elseOpenIdx + 1, elseCloseIdx));
	if (thenBody.length === 0 || thenBody !== elseBody) return null;
	return {
		line: lineAt(content, thenCloseIdx),
		text: `identical if/else branches — condition has no effect; both arms run: ${snippet(thenBody)}`,
	};
}

/** True when the `?` at `i` opens a C-style ternary (not `?.`, `??`, `?:`, `x?`). */
function isTernaryQuestion(scan: string, i: number): boolean {
	if (scan[i] !== "?") return false;
	const next = scan[i + 1];
	const prev = scan[i - 1];
	// `?.` optional chain, `??` nullish, `?:` TS-optional / Elvis, and the
	// second `?` of `??` are all non-ternary. Rust's postfix try (`foo()?`)
	// has no matching depth-0 `:` and is rejected later by findTernaryColon.
	return next !== "." && next !== "?" && next !== ":" && prev !== "?";
}

/** Bracket-depth change a character contributes: +1 opener, -1 closer, else 0. */
function bracketDelta(ch: string | undefined): number {
	if (ch === "(" || ch === "[" || ch === "{") return 1;
	if (ch === ")" || ch === "]" || ch === "}") return -1;
	return 0;
}

/**
 * From a ternary `?` at `qIdx`, return the index of its matching `:` at the same
 * bracket depth, or -1 when it isn't a clean (non-nested) ternary — a nested
 * depth-0 `?`, a statement terminator before the colon, leaving the enclosing
 * scope, or the scan bound all bail conservatively.
 */
function findTernaryColon(scan: string, qIdx: number): number {
	let depth = 0;
	const end = Math.min(scan.length, qIdx + TERNARY_SCAN_LIMIT);
	for (let i = qIdx + 1; i < end; i++) {
		const ch = scan[i];
		const delta = bracketDelta(ch);
		if (delta !== 0) {
			depth += delta;
			if (depth < 0) return -1; // left the enclosing expression
			continue;
		}
		if (depth !== 0) continue;
		if (ch === ":") return i;
		if (ch === ";") return -1; // statement ended before any colon
		if (isTernaryQuestion(scan, i)) return -1; // nested ternary — skip
	}
	return -1;
}

/** End (exclusive) of the false-branch that starts after the ternary `:`. */
function findTernaryEnd(scan: string, colonIdx: number): number {
	let depth = 0;
	const end = Math.min(scan.length, colonIdx + TERNARY_SCAN_LIMIT);
	for (let i = colonIdx + 1; i < end; i++) {
		const ch = scan[i];
		if (ch === "(" || ch === "[" || ch === "{") depth += 1;
		else if (ch === ")" || ch === "]" || ch === "}") {
			if (depth === 0) return i; // the enclosing bracket closed
			depth -= 1;
		} else if (depth === 0 && (ch === ";" || ch === "," || isTernaryQuestion(scan, i))) {
			return i;
		}
	}
	return end;
}

function findIdenticalTernaries(
	scan: string,
	noComments: string,
	content: string,
): InlineMatch[] {
	const out: InlineMatch[] = [];
	for (let i = 0; i < scan.length; i++) {
		if (!isTernaryQuestion(scan, i)) continue;
		const colonIdx = findTernaryColon(scan, i);
		if (colonIdx === -1) continue;
		const endIdx = findTernaryEnd(scan, colonIdx);
		const trueBranch = normalizeBody(noComments.slice(i + 1, colonIdx));
		const falseBranch = normalizeBody(noComments.slice(colonIdx + 1, endIdx));
		if (trueBranch.length > 0 && trueBranch === falseBranch) {
			out.push({
				line: lineAt(content, i),
				text: `identical ternary results — condition has no effect; both yield: ${snippet(trueBranch)}`,
			});
			if (out.length >= MAX_MATCHES) break;
		}
		i = colonIdx; // resume past the true-branch interior
	}
	return out;
}

/**
 * Detect conditionals whose branches are identical (the same value/effect both
 * ways). Brace-delimited languages only; skips vendored/fixture and generated
 * files. Returns up to {@link MAX_MATCHES} findings.
 */
export function checkIdenticalBranches(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!BRACE_LANG_EXTS.has(ext)) return [];
	if (isVendoredOrFixturePath(filePath) || isGeneratedFile(content)) return [];
	// Cheap pre-reject: no `else` block and no `?` ⇒ neither form can exist.
	if (!content.includes("else") && !content.includes("?")) return [];

	const forScan = ext === ".rs" ? content.replace(RUST_LIFETIME_RE, " $1") : content;
	const scan = stripForBraceScan(forScan);
	const noComments = stripComments(content);

	const blocks = findIdenticalBlocks(scan, noComments, content);
	if (blocks.length >= MAX_MATCHES) return blocks;
	const ternaries = findIdenticalTernaries(scan, noComments, content);
	return [...blocks, ...ternaries].slice(0, MAX_MATCHES);
}
