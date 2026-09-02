// UBS language-specific detector — `ubs_division_by_variable` (Row 30).
// Extracted from ubs-language-specific.ts during the 1500-line decomposition.
// Cross-language, advisory by default (high FP rate).

import { nonNull } from "../../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	stripCommentsAndStrings,
} from "../shared.js";
import { isJsTsFile, isPyFile } from "./_shared.js";

/**
 * Row 30: division by a variable identifier — the variable might be zero.
 * Cross-language, advisory by default (high FP rate; ships in
 * DEFAULT_ADVISORY_SKIPS so it only runs under `verify --all-checks`).
 *
 * Both LHS and RHS of the slash must be identifier-shaped, AND the slash
 * must be surrounded by whitespace — i.e. an identifier, one-or-more
 * whitespace chars, slash, one-or-more whitespace chars, identifier.
 * Tightened from a one-sided rule (only the right-hand operand had to be
 * an identifier) after markdown like `value / etc.` and compact prose
 * like `TS/JS-centric` and `if/when` produced false positives. Requiring
 * whitespace blocks the compact-slash cases; requiring an LHS identifier
 * blocks the empty-LHS-after-string-strip case.
 *
 * Bilateral matching loses a few real-code patterns — `arr[i] / b`,
 * `func() / b`, multi-line continuations where the slash starts the
 * line, and compact `a/b` divisions without spaces — which is acceptable
 * since the check is advisory by default and modern style guides format
 * spaces around binary operators.
 *
 * Pure-prose alternation like `regex / AST query / taint pattern` is
 * bilateral-id-shaped and would otherwise fire, so the detector also
 * gates on a source-file extension allow-list (mirroring
 * `checkLargeFunction`'s coverage). Markdown, plain-text, config, and
 * unknown extensions short-circuit before the matcher runs. Extending
 * the allow-list to `.kt` / `.rb` / `.cs` is a one-line edit
 * if a TP is reported there.
 *
 * The detector strips comments and strings first, so `*\/` block-comment
 * terminators, end-of-line comments, and division-looking content inside
 * string literals do not contribute matches.
 *
 * Guard-based suppression checks the match's OWN line plus a bounded
 * window of `GUARD_LOOKBACK_LINES` preceding non-blank lines (deliberately
 * NOT a brace-walk / indentation-dominance scan — that was considered and
 * rejected as risking false-suppression of a real division-by-zero
 * elsewhere in the same function; a small fixed window keyed to the
 * specific divisor identifier is a much narrower, more auditable target).
 * A match is dropped when its own line carries a zero-guard in one of the
 * shapes `lineHasZeroGuard` recognizes — the Python ternary
 * (`a / n if n > 0 else 0`), the parenthesized `if (n != 0)`, the JS/Go
 * conditional (`n > 0 ? a / n : 0`), or the `n && a / n` short-circuit —
 * OR when a preceding line within the window carries a guard on the SAME
 * divisor identifier in one of the shapes `precedingLineHasZeroGuard`
 * recognizes: an early-exit `if (n === 0) return;` / `if n == 0: return`,
 * an enclosing `if (n !== 0) {` / `if n > 0:` conditional open, a falsy
 * guard `if (!n) return;` / `if not n: return`, or a fallback default
 * `n = n || 1` / `n = n or 1` / `n ||= 1`. Confirmed over-firer
 * (2026-08): `if (n === 0) return; x = total / n;` split across two
 * lines used to still flag `total / n` — it no longer does.
 *
 * Python path joins (`base / "sub"`, where `/` is
 * `pathlib.Path.__truediv__` rather than division) get two dedicated
 * suppressions: a match whose LHS is a name annotated `: Path` or
 * assigned `Path(...)` anywhere in the file (`collectPathishNames` +
 * `isPathDivisionLine`), and any line carrying an `os.path.join(...)`
 * call.
 */
export function checkDivisionByVariable(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isSupportedDivisionFile(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// 139-repo audit (2026-05): pre-compute a set of names that are
	// ANNOTATED `: Path` or ASSIGNED via `Path(...)` / `pathlib.Path(...)`
	// in the same file. Python's `pathlib.Path.__truediv__` overloads `/`
	// for path joins — `path / "subdir"` is NOT division. The 53 hits in
	// alter/cc-autopipe-source were all of this shape.
	const python = isPyFile(ext);
	const pathishNames = python ? collectPathishNames(stripped) : null;

	const divisionRegex = /(?:^|[^\w$])([a-zA-Z_$]\w*)\s+\/\s+([a-zA-Z_$]\w*)/g;

	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);
		// Reset lastIndex defensively for the global regex.
		divisionRegex.lastIndex = 0;
		if (!divisionRegex.test(line)) continue;

		if (shouldSuppressDivisionMatch(line, nonNull(originalLines[i]), strippedLines, i, pathishNames)) {
			continue;
		}

		matches.push({
			line: i + 1,
			text: nonNull(originalLines[i]).trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * Extension gate: cross-language coverage for the division-by-variable
 * check (mirrors `checkLargeFunction`'s allow-list). Markdown, plain-text,
 * config, and unknown extensions short-circuit before the matcher runs.
 */
function isSupportedDivisionFile(ext: string): boolean {
	return (
		isJsTsFile(ext) ||
		isPyFile(ext) ||
		ext === ".go" ||
		ext === ".java" ||
		ext === ".rs" ||
		ext === ".c" ||
		ext === ".cpp" ||
		ext === ".swift"
	);
}

/**
 * Combine every per-line suppression rule for one already-regex-matched
 * division line: same-line zero-guard, a preceding-line guard on the
 * SAME divisor, the Python `Path / "subdir"` join shape, and
 * `os.path.join(...)` calls. Extracted from `checkDivisionByVariable`'s
 * loop body — see that function's per-check comments (139-repo audit,
 * 2026-08 over-firer fix) for the rationale behind each branch.
 */
function shouldSuppressDivisionMatch(
	line: string,
	originalLine: string,
	strippedLines: string[],
	lineIdx: number,
	pathishNames: Set<string> | null,
): boolean {
	// Supermodel mcpbr/analytics shape:
	//   avg = total / count if count > 0 else 0.0
	//   rate = (a / b * 100.0) if b > 0 else 0.0
	// The guard sits on the same line via the Python ternary; in JS/Go
	// it appears as `count > 0 ? a / b : 0` or `count !== 0 && a / b`.
	if (lineHasZeroGuard(line)) return true;

	// Known-FP fix (2026-08): skip when a bounded window of preceding
	// non-blank lines carries an explicit zero/emptiness guard on the
	// SAME divisor identifier — `if (n === 0) return; ... total / n`
	// split across lines used to still fire. Checked against every
	// divisor identifier on this line (matchAll, not just the first).
	if (divisorsOnLine(line).some((divisor) => precedingLinesHaveZeroGuard(strippedLines, lineIdx, divisor))) {
		return true;
	}

	// 139-repo audit: Python `Path / "subdir"` shape — re-run the
	// regex globally to inspect the operands and skip any match
	// whose LHS is annotated/assigned as a Path (or whose
	// neighborhood is a string literal — those are stripped to `""`
	// already, so we look at the original line).
	if (pathishNames && isPathDivisionLine(line, originalLine, pathishNames)) return true;

	// 139-repo audit: skip `os.path.join(...)` shapes — even if the
	// regex matched some inner identifier-pair, the call's outer
	// shape is path-join not division.
	if (/\bos\.path\.join\s*\(/.test(line)) return true;

	return false;
}

/**
 * Detect a same-line zero-guard for the divisor. Heuristic — covers the
 * common Python ternary shape (`x / y if y > 0 else 0`), the JS / Go
 * conditional (`y !== 0 ? x / y : 0`), and the C-style guard
 * (`if (y) result = x / y;`). Each pattern is anchored on the divisor
 * relationship so unrelated `if` statements on the same line don't
 * spuriously suppress.
 *
 * Conservative on purpose: the check is already advisory. Missing a
 * guard that should suppress is fine (FP); falsely suppressing a real
 * division-by-zero (FN) would defeat the check.
 */
function lineHasZeroGuard(line: string): boolean {
	// `... if <id> > 0 else ...` / `... if <id> != 0 else ...` /
	// `... if <id> is not None and <id> != 0 else ...`
	if (/\bif\s+[A-Za-z_$][\w$]*\s*(?:>\s*0|>=\s*1|!=\s*0|!==\s*0|is\s+not\s+None)\b/.test(line)) {
		return true;
	}
	// `... if (<id> > 0)` / `... if (<id> != 0)`  — parenthesized form.
	if (/\bif\s*\(\s*[A-Za-z_$][\w$]*\s*(?:>\s*0|!=\s*0|!==\s*0)\s*\)/.test(line)) {
		return true;
	}
	// JS/Go ternary: `<id> > 0 ? a / <id> : 0` / `<id> ? a / <id> : 0`.
	if (/\b[A-Za-z_$][\w$]*\s*(?:>\s*0|!==?\s*0)\s*\?[^?]*\//.test(line)) return true;
	// `<id> && a / <id>` short-circuit.
	if (/\b[A-Za-z_$][\w$]*\s*&&\s*[A-Za-z_$][\w$]*\s+\/\s+[A-Za-z_$]/.test(line)) return true;
	return false;
}

/** How many preceding non-blank lines `precedingLinesHaveZeroGuard` scans. */
const GUARD_LOOKBACK_LINES = 5;

/**
 * Return every RHS (divisor) identifier captured by the division regex on
 * one line. Used to key the preceding-line guard scan to the ACTUAL
 * divisor rather than any identifier that happens to appear nearby.
 */
function divisorsOnLine(line: string): string[] {
	const re = /(?:^|[^\w$])[a-zA-Z_$]\w*\s+\/\s+([a-zA-Z_$]\w*)/g;
	const divisors: string[] = [];
	for (const m of line.matchAll(re)) divisors.push(nonNull(m[1]));
	return divisors;
}

/**
 * Escape a divisor identifier for interpolation into a `RegExp` source
 * string. Identifiers are already constrained to `[A-Za-z_$][\w$]*` by the
 * capturing regex, but escape defensively rather than assume that holds.
 */
function escapeForRegex(id: string): string {
	return id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Known-FP fix (2026-08, confirmed over-firer): scan a bounded window of
 * `GUARD_LOOKBACK_LINES` preceding NON-BLANK lines for an explicit
 * zero/emptiness guard on `divisor` — the same identifier the flagged
 * division actually divides by. Deliberately narrow and line-based (no
 * brace-walk / indentation-dominance analysis, per the module doc) so it
 * stays deterministic and auditable; a guard elsewhere in the function
 * that doesn't match one of these shapes still leaves the division
 * flagged, which is the safe direction for an advisory check.
 *
 * Recognized shapes, all keyed to `divisor`:
 *  - early-exit: `if (divisor === 0) return;` / `if (divisor == 0) continue`
 *  - Python early-exit: `if divisor == 0: return`
 *  - enclosing guard open: `if (divisor !== 0) {` / `if (divisor > 0) {`
 *  - Python enclosing guard: `if divisor > 0:` / `if divisor != 0:`
 *  - falsy guard: `if (!divisor) return;` / `if not divisor: return`
 *  - fallback default: `divisor = divisor || 1` / `divisor ||= 1` /
 *    `divisor = divisor or 1`
 */
function precedingLinesHaveZeroGuard(lines: string[], matchLineIdx: number, divisor: string): boolean {
	const id = escapeForRegex(divisor);
	const earlyExit = new RegExp(`\\bif\\s*\\(?\\s*${id}\\s*===?\\s*0\\s*\\)?\\s*:?\\s*(?:return|continue)\\b`);
	const enclosingOpen = new RegExp(
		`\\bif\\s*\\(\\s*${id}\\s*(?:!==?\\s*0|>\\s*0)\\s*\\)\\s*\\{`,
	);
	const enclosingPy = new RegExp(`\\bif\\s+${id}\\s*(?:!=\\s*0|>\\s*0)\\s*:\\s*$`);
	const falsyGuard = new RegExp(`\\bif\\s*\\(?\\s*(?:!|not\\s+)${id}\\s*\\)?\\s*:?\\s*(?:return|continue)\\b`);
	const fallbackDefault = new RegExp(
		`\\b${id}\\s*(?:=\\s*${id}\\s*(?:\\|\\||or)|\\|\\|=)\\s*[\\w."'-]`,
	);

	let scanned = 0;
	for (let i = matchLineIdx - 1; i >= 0 && scanned < GUARD_LOOKBACK_LINES; i--) {
		const candidate = nonNull(lines[i]).trim();
		if (candidate === "") continue;
		scanned++;
		if (
			earlyExit.test(candidate) ||
			enclosingOpen.test(candidate) ||
			enclosingPy.test(candidate) ||
			falsyGuard.test(candidate) ||
			fallbackDefault.test(candidate)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Walk a Python file's stripped content and collect every identifier
 * that's annotated as `Path` / `pathlib.Path` or assigned the result of
 * `Path(...)` / `pathlib.Path(...)`. These names participate in
 * `__truediv__` overloads and `name / "subdir"` is NOT division.
 *
 * Conservative: a name that's BOTH a Path and a number (rare) will be
 * suppressed even when a real division could happen. The check is
 * advisory.
 */
function collectPathishNames(strippedSrc: string): Set<string> {
	const names = new Set<string>();
	// `name: Path` / `name: pathlib.Path` annotations (function args
	// AND assignment annotations).
	const annotRe = /\b([A-Za-z_$][\w$]*)\s*:\s*(?:pathlib\s*\.\s*)?Path\b/g;
	for (const m of strippedSrc.matchAll(annotRe)) names.add(nonNull(m[1]));
	// `name = Path(...)` / `name = pathlib.Path(...)`.
	const assignRe = /\b([A-Za-z_$][\w$]*)\s*=\s*(?:pathlib\s*\.\s*)?Path\s*\(/g;
	for (const m of strippedSrc.matchAll(assignRe)) names.add(nonNull(m[1]));
	return names;
}

/**
 * Return true when the matched division shape is actually a
 * `pathlib.Path` __truediv__ join — either the LHS is a known
 * Path-typed name, or the `/` is followed by a string literal in the
 * ORIGINAL line (which got stripped to `""` in the analyzed line, but
 * is still visible in the original).
 */
function isPathDivisionLine(
	strippedLine: string,
	originalLine: string,
	pathishNames: Set<string>,
): boolean {
	// Re-run the regex globally to inspect every match.
	const re = /(?:^|[^\w$])([a-zA-Z_$]\w*)\s+\/\s+([a-zA-Z_$]\w*)/g;
	let anyNonPathDivision = false;
	let foundAnyMatch = false;
	for (const m of strippedLine.matchAll(re)) {
		foundAnyMatch = true;
		const lhs = nonNull(m[1]);
		if (pathishNames.has(lhs)) continue; // pathlib join — skip
		anyNonPathDivision = true;
	}
	if (!foundAnyMatch) return false;
	// If every match has a Path-typed LHS, this is a path-join line.
	if (!anyNonPathDivision) return true;
	// Path / "literal" shape: stripped line shows `name / ""` because
	// the literal was stripped. Inspect the original to confirm.
	if (/\b[A-Za-z_$][\w$]*\s+\/\s+(?:["'`])/.test(originalLine)) return true;
	return false;
}
