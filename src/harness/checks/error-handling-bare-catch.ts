// Per-line bare-catch helpers, extracted out of error-handling.ts to keep
// checkBareCatchBlock's cyclomatic complexity under the cap without pushing
// the parent past the per-file line cap. Module-private logic surfaced for
// its companion module — never called for "testing" reasons.
import { nonNull } from "../../lib/non-null.js";
import type { InlineMatch } from "./shared.js";

/**
 * Match a same-line `catch (...) { }` / `catch { }` and push a finding.
 * Returns true when it matched, so the caller can `continue` past the other
 * per-line checks (a one-liner bare catch can't also be a comment-only catch).
 */
export function pushBareCatchOneLiner(line: string, i: number, matches: InlineMatch[]): boolean {
	if (!/\bcatch\s*(\([^)]*\))?\s*\{\s*\}/.test(line)) return false;
	matches.push({
		line: i + 1,
		text: `bare catch block silently swallows error: ${line.trim().slice(0, 100)}`,
	});
	return true;
}

/** Match a `catch (...) {` whose body is only a comment (or blank) before its close. */
export function pushCommentOnlyCatch(lines: string[], i: number, matches: InlineMatch[]): void {
	const line = nonNull(lines[i]);
	if (!(/\bcatch\s*(\([^)]*\))?\s*\{/.test(line) && i + 2 < lines.length)) return;
	const next = nonNull(lines[i + 1]).trim();
	const afterNext = nonNull(lines[i + 2]).trim();
	if ((next.startsWith("//") || next.startsWith("/*") || next === "") && afterNext === "}") {
		matches.push({
			line: i + 1,
			text: `catch block with only a comment — error is silently ignored: ${line.trim().slice(0, 100)}`,
		});
	}
}

/** Match a Python `except ...:` immediately followed by `pass` or `...`. */
export function pushBarePythonExcept(lines: string[], i: number, matches: InlineMatch[]): void {
	const line = nonNull(lines[i]);
	if (!(/\bexcept\b.*:\s*$/.test(line) && i + 1 < lines.length)) return;
	const next = nonNull(lines[i + 1]).trim();
	if (next === "pass" || next === "...") {
		matches.push({
			line: i + 1,
			text: `bare except/pass silently swallows error: ${line.trim().slice(0, 100)}`,
		});
	}
}
