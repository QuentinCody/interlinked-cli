// NaN-from-coercion used unguarded in a relational comparison (fail-open).
//
// `Date.parse(x)`, `Number(x)`, `parseInt(x, ...)`, or `parseFloat(x)`
// returns NaN on malformed input. When that result flows into a relational
// comparison (`<`, `>`, `<=`, `>=`) WITHOUT a Number.isFinite / Number.isNaN /
// isNaN guard the comparison is silently `false`, causing the code to fall
// through to a permissive/default branch — a classic fail-open bug.
//
// Real example that motivated this check:
//   `if (Date.parse(rec.expires_at) <= now) return null;`
//   A garbage date → NaN → `NaN <= now` is false → the expired branch is
//   skipped → a stand-down marker is treated as live forever.
//
// Two detection shapes:
//   (a) Inline:  `Date.parse(x) <= now`
//   (b) Two-step: `const n = Number(x); ... if (n < limit)`
//       with no guard on `n` between assignment and use.
//
// Only fires on JS/TS source files.  Equality (`===` / `!==`) is skipped —
// those always evaluate cleanly (NaN !== NaN is arguably correct).

import {
	getExtension,
	type InlineMatch,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";
// Shared offset→line helper (1-based; the comment/string stripper preserves
// line count, so it is valid over stripped text). Direct in-package import —
// shared.ts sits at its line cap and cannot carry another re-export line.
import { buildLineIndex, offsetToLine } from "./shared-text-utils.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const REPORT_LINE_TRUNC = 150;
const MAX_MATCHES_PER_FILE = 10;
/** Lines ahead of a two-step assignment to scan for the relational use. */
const TWO_STEP_LOOKAHEAD_LINES = 60;

// ─── Patterns ─────────────────────────────────────────────────────────────────

/** All four coercion call forms we care about. */
const COERCE_CALLS = String.raw`\b(?:Date\.parse|Number|parseInt|parseFloat)\s*\(`;

/**
 * Inline shape: `<coerce>( ... ) <relational-op> <expr>` or
 *               `<expr> <relational-op> <coerce>( ... )`
 * where <relational-op> is `<=`, `>=`, `<`, `>` but NOT `===` / `!==`.
 *
 * We accept up to 80 chars inside the parens to cover typical argument lists
 * without crossing statement boundaries.
 */
const INLINE_COERCE_THEN_REL_RE = new RegExp(
	String.raw`${COERCE_CALLS}[^)]{0,80}\)\s*(?:<=|>=|<(?!=)|>(?!=))`,
	"g",
);

const INLINE_REL_THEN_COERCE_RE = new RegExp(
	String.raw`(?:<=|>=|<(?!=)|>(?!=))\s*${COERCE_CALLS}`,
	"g",
);

/**
 * Two-step shape: `const|let|var <name> = <coerce>( ... )`.
 * Captures the variable name in group 1.
 */
const TWO_STEP_ASSIGN_RE = new RegExp(
	String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w<>[\]|&\s]+?)?\s*=\s*${COERCE_CALLS}`,
	"g",
);

// ─── Guard detection ──────────────────────────────────────────────────────────

/**
 * Return true when the text contains a finite/NaN guard that covers `name`.
 * Checked against a window BEFORE the relational use so a guard above the
 * comparison is sufficient.
 */
function hasGuardForName(window: string, name: string): boolean {
	const n = escapeForRegex(name);
	const guardRe = new RegExp(
		// Number.isFinite(name), Number.isNaN(name), isNaN(name)
		String.raw`(?:Number\.isFinite\s*\(\s*${n}\s*\)|Number\.isNaN\s*\(\s*${n}\s*\)|(?<!\w)isNaN\s*\(\s*${n}\s*\))`,
	);
	return guardRe.test(window);
}

/**
 * Return true when the inline coercion expression (coerce call + relational
 * operator, already matched) is itself wrapped in a guard call, i.e.
 * `Number.isFinite(…)` or `isNaN(…)` appears in the surrounding 120 chars.
 */
function hasInlineGuard(surrounding: string): boolean {
	return /Number\.isFinite\s*\(|Number\.isNaN\s*\(|(?<!\w)isNaN\s*\(/.test(surrounding);
}

/** Escape special regex metacharacters in a variable name. */
function escapeForRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Match recording ──────────────────────────────────────────────────────────

function recordMatch(
	stripped: string,
	rawLines: string[],
	offset: number,
	message: string,
	matches: InlineMatch[],
	seen: Set<number>,
): void {
	if (matches.length >= MAX_MATCHES_PER_FILE) return;
	const lineNo = offsetToLine(stripped, offset);
	if (seen.has(lineNo)) return;
	seen.add(lineNo);
	const rawText = (rawLines[lineNo - 1] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
	matches.push({ line: lineNo, text: `${message} — ${rawText}` });
}

// ─── Pass 1: inline coerce-then-relational ────────────────────────────────────

function detectInlineShape(
	stripped: string,
	rawLines: string[],
	matches: InlineMatch[],
	seen: Set<number>,
): void {
	// Shape: <coerce>( ... ) <op>
	const reA = new RegExp(INLINE_COERCE_THEN_REL_RE.source, "g");
	let hit: RegExpExecArray | null;
	while ((hit = reA.exec(stripped)) !== null) {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;
		// Look at the surrounding 120 chars for a guard.
		const surroundStart = Math.max(0, hit.index - 80);
		const surroundEnd = Math.min(stripped.length, hit.index + hit[0].length + 40);
		const surround = stripped.slice(surroundStart, surroundEnd);
		if (hasInlineGuard(surround)) continue;
		recordMatch(
			stripped,
			rawLines,
			hit.index,
			"nan_coercion_guard: coercion result used in relational comparison without Number.isFinite / isNaN guard",
			matches,
			seen,
		);
	}

	// Shape: <op> <coerce>( ... )
	const reB = new RegExp(INLINE_REL_THEN_COERCE_RE.source, "g");
	while ((hit = reB.exec(stripped)) !== null) {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;
		const surroundStart = Math.max(0, hit.index - 80);
		const surroundEnd = Math.min(stripped.length, hit.index + hit[0].length + 40);
		const surround = stripped.slice(surroundStart, surroundEnd);
		if (hasInlineGuard(surround)) continue;
		recordMatch(
			stripped,
			rawLines,
			hit.index,
			"nan_coercion_guard: coercion result used in relational comparison without Number.isFinite / isNaN guard",
			matches,
			seen,
		);
	}
}

// ─── Pass 2: two-step (assign then compare) ───────────────────────────────────

/** The text being scanned, plus its precomputed offset→line index. */
interface ScanSource {
	stripped: string;
	rawLines: string[];
	lineIndex: ReturnType<typeof buildLineIndex>;
}

/** Where findings accumulate: the output list plus its dedup-by-line set. */
interface MatchSink {
	matches: InlineMatch[];
	seen: Set<number>;
}

function detectTwoStepShape(
	stripped: string,
	rawLines: string[],
	matches: InlineMatch[],
	seen: Set<number>,
): void {
	// Repeated offset→line lookups over one string plus window slicing off the
	// same table — the precomputed form, not the one-shot scan.
	const source: ScanSource = { stripped, rawLines, lineIndex: buildLineIndex(stripped) };
	const sink: MatchSink = { matches, seen };
	const assignRe = new RegExp(TWO_STEP_ASSIGN_RE.source, "g");

	let assignHit: RegExpExecArray | null;
	while ((assignHit = assignRe.exec(stripped)) !== null) {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;
		const varName = assignHit[1];
		if (varName === undefined) continue;

		scanRelationalUsesOfAssignedVar(source, assignHit, varName, sink);
	}
}

/**
 * For one `const n = coerce(...)` assignment hit, scan the lookahead window
 * for an unguarded relational use of `varName` and record each one found.
 */
function scanRelationalUsesOfAssignedVar(
	source: ScanSource,
	assignHit: RegExpExecArray,
	varName: string,
	sink: MatchSink,
): void {
	const { stripped, rawLines, lineIndex } = source;
	const lineOffsets = lineIndex.lineStarts;
	const assignLineNo = lineIndex.lineAt(assignHit.index);
	const windowStart = assignHit.index + assignHit[0].length;
	const lookaheadEndLine = assignLineNo + TWO_STEP_LOOKAHEAD_LINES;
	const windowEnd =
		lookaheadEndLine - 1 < lineOffsets.length
			? (lineOffsets[lookaheadEndLine - 1] ?? stripped.length)
			: stripped.length;

	const window = stripped.slice(windowStart, windowEnd);
	const escaped = escapeForRegex(varName);

	// Relational comparison using the variable.
	// Must be `<varName> <op>` or `<op> <varName>` — not inside a subscript.
	const relUseRe = new RegExp(
		String.raw`(?:(?<!\[)\b${escaped}\s*(?:<=|>=|<(?!=)|>(?!=))|(?:<=|>=|<(?!=)|>(?!=))\s*${escaped}\b)`,
		"g",
	);

	let useHit: RegExpExecArray | null;
	while ((useHit = relUseRe.exec(window)) !== null) {
		if (sink.matches.length >= MAX_MATCHES_PER_FILE) return;
		const useAbsoluteOffset = windowStart + useHit.index;
		// Everything between the assignment and the use — guards must precede the use.
		const between = stripped.slice(windowStart, useAbsoluteOffset);
		if (hasGuardForName(between, varName)) continue;
		recordMatch(
			stripped,
			rawLines,
			useAbsoluteOffset,
			`nan_coercion_guard: "${varName}" from coercion used in relational comparison without Number.isFinite / isNaN guard`,
			sink.matches,
			sink.seen,
		);
	}
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect NaN-from-coercion used unguarded in a relational comparison.
 *
 * Check id: `nan_coercion_guard`
 *
 * Returns up to 10 `InlineMatch` findings per file (fields: `line`, `text`).
 * The `text` field is prefixed with the check id and the actionable message
 * before the raw line excerpt, matching the convention in neighbouring checks.
 *
 * Only fires on JS/TS source files.
 */
export function detectNaNCoercionGuards(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	detectInlineShape(stripped, rawLines, matches, seen);
	detectTwoStepShape(stripped, rawLines, matches, seen);

	return matches;
}
