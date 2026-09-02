// ===========================================
// Assertion MOVE classifier — GATE 2 companion
// ===========================================
// GATE 2 (mutation_directed_assertion_removal, checks/mutation-directed-
// profile.ts) diffs it()/test()/expect() lines by exact normalized text, so a
// refactor that MOVES an assertion — into a sibling test block, a renamed
// subject, a different file in the same ChangeSet — reads as a removal and
// blocks. This module answers the narrower question the block is really
// asking: did the kill evidence LEAVE the edit, or just change address?
//
// An added line is EQUIVALENT to a removed one when it carries the same
// expect() SUBJECT expression, the same terminal matcher (modifiers `.not` /
// `.resolves` / `.rejects` included — `not.toBe(2)` is not evidence for
// `toBe(2)`) and the same expected-value text, each after whitespace
// normalization (runs of whitespace collapse to one space; nothing else is
// rewritten). The subject IS part of the key: in mutation-kill files the
// modal expected values are low-entropy literals (`toBe(true)`,
// `toHaveLength(0)`, `toThrow()`), so a subject-free key let ANY trivial
// addition anywhere in the edit pay for a deleted kill assertion — silently,
// with no warning. A move that renames the subject (`result.a` → `out.a`)
// is a rewrite the gate cannot verify from text alone; keep the subject, or
// take the campaign waiver. A case declaration (`it("title", …`) is keyed by
// its whole normalized text — a moved case keeps its title.
//
// When the subject or the terminal matcher's argument list is not balanced
// on the line (a multi-line `toEqual({` opener), the key degrades to the
// exact normalized text: the expected value is not on this line, so a looser
// key would let an unrelated opener pay for it.
//
// Cross-file visibility: the ADDED pool comes from the same file plus the
// `siblings` of ONE edit payload (batch-shaped `edits[]` entries with their
// own `file_path`). Claude Code sends one file per PreToolUse call, so a
// cross-file move there is two calls; the second call can only REDEEM a
// waived removal through the ledger (assertion-waiver-log.ts), it cannot
// make the first call pass. Documented in evaluator/mutation-directed-guard.ts.
//
// Pure functions only. The multiset budget mirrors pre-block-gate.ts's
// splitRemoved so two identical removals need two equivalent additions.

import type { InlineMatch } from "../check-registry/types.js";
import { TEST_CASE_LINE } from "./test-legitimacy.js";

export interface MovedAssertionSplit {
	/** Removed lines with NO equivalent addition in the edit — still removed. */
	removed: InlineMatch[];
	/** Removed lines paid for by an equivalent added line — a move, not a loss. */
	moved: InlineMatch[];
}

/** Terminal-matcher candidates: optional modifier chain then `.toXxx(`. */
const MATCHER_RE = /\.((?:(?:not|resolves|rejects)\.)*)(to[A-Z]\w*)\s*\(/g;

/** The expect() opener whose argument is the assertion SUBJECT. `expect.soft`
 *  is an assertion too; `expect.any(...)` is a matcher argument, not one. */
const SUBJECT_RE = /\bexpect(?:\.soft)?\s*\(/;

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Index of the `)` that closes the `(` at `open`, or -1 when unbalanced on
 *  this line. String literals are not parsed — a paren inside a quoted
 *  expected value is rare and only ever makes the key STRICTER (fallback to
 *  exact text), never looser. */
function matchingClose(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return i;
	}
	return -1;
}

/** The LAST balanced `.modifiers.toXxx(args)` in `text` — the terminal
 *  matcher — or null when none is balanced. `text` starts AFTER the expect()
 *  subject, so a `to*`-named call inside the subject (`a.toString()`) is never
 *  a candidate; a `to*` call INSIDE the argument list (`toEqual(y.toFixed(2))`)
 *  loses because its own close paren precedes the outer one, so the outer
 *  candidate is still balanced and still later-or-equal in scan order. */
function terminalMatcher(text: string): { matcher: string; args: string } | null {
	let best: { matcher: string; args: string; end: number } | null = null;
	for (const hit of text.matchAll(MATCHER_RE)) {
		const open = hit.index + hit[0].length - 1;
		const close = matchingClose(text, open);
		if (close === -1) continue;
		if (best && close < best.end) continue; // nested inside the current best's args
		best = { matcher: `${hit[1] ?? ""}${hit[2] ?? ""}`, args: text.slice(open + 1, close), end: close };
	}
	return best ? { matcher: best.matcher, args: best.args } : null;
}

/** The balanced `expect(subject)` opener on the line: the normalized subject
 *  text plus the index just past its closing paren, or null when there is no
 *  expect() call or its parens do not balance on this line. */
function expectSubject(text: string): { subject: string; end: number } | null {
	const hit = SUBJECT_RE.exec(text);
	if (!hit) return null;
	const open = hit.index + hit[0].length - 1;
	const close = matchingClose(text, open);
	if (close === -1) return null;
	return { subject: normalizeWhitespace(text.slice(open + 1, close)), end: close + 1 };
}

/**
 * Equivalence key for one GATE 2 line. `expect(a).toBe(1)` /
 * `expect(r.x).not.toEqual({ a: 1 })` for a balanced assertion (subject,
 * modifier chain, matcher and expected text all whitespace-normalized),
 * `case:<text>` for an it()/test() declaration, `text:<text>` when the
 * subject or the expected value is not balanced on this line.
 */
export function assertionSignature(text: string): string {
	const norm = normalizeWhitespace(text).replace(/;$/, "").trim();
	if (TEST_CASE_LINE.test(norm)) return `case:${norm}`;
	const subject = expectSubject(norm);
	const hit = subject ? terminalMatcher(norm.slice(subject.end)) : null;
	if (!subject || !hit) return `text:${norm}`;
	return `expect(${subject.subject}).${hit.matcher}(${normalizeWhitespace(hit.args)})`;
}

/**
 * Split GATE 2's `removed` lines into still-removed vs moved, where each
 * equivalent line in `added` (lines this edit INTRODUCES, in the same file or
 * any sibling of the same ChangeSet) pays for exactly one removal.
 */
export function partitionMovedAssertions(removed: InlineMatch[], added: InlineMatch[]): MovedAssertionSplit {
	const budget = new Map<string, number>();
	for (const a of added) {
		const k = assertionSignature(a.text);
		budget.set(k, (budget.get(k) ?? 0) + 1);
	}
	const stillRemoved: InlineMatch[] = [];
	const moved: InlineMatch[] = [];
	for (const r of removed) {
		const k = assertionSignature(r.text);
		const n = budget.get(k) ?? 0;
		if (n > 0) {
			budget.set(k, n - 1);
			moved.push(r);
		} else {
			stillRemoved.push(r);
		}
	}
	return { removed: stillRemoved, moved };
}
