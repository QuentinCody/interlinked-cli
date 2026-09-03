// External-input-as-array-index check.
//
// Detects:
//   - Inline: `arr[Number(req.body.idx)]`, `rows[parseInt(req.params.id, 10)]`
//   - Two-step within the same function:
//       const id = parseInt(req.params.id, 10);
//       ...no Number.isFinite / length-bound guard...
//       return rows[id];
//
// JS analog of Firefox 2026305 (16-bit overflow at 65535) — a numeric value
// that came from external input reaches an array subscript without a bounds
// check. The bug shape is amplified at runtime size-class boundaries
// (2^16, 2^31, 2^53) where the coerced value silently wraps or becomes
// non-finite.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

// External-input source pattern. `\b` keeps us from matching `xreq.body`
// while still composing cleanly inside larger patterns (the `(?:^|[^\w$])`
// form fights with greedy `[^]]*`/`[^;]*` quantifiers in front of it).
const EXTERNAL_INPUT = String.raw`(?:\b(?:req|request)\.(?:body|query|params)\.\w+|\bprocess\.argv\b|\bprocess\.env\.\w+)`;

const COERCE_OPENERS = String.raw`\b(?:Number|parseInt|parseFloat)\s*\(`;

// Inline form: <receiver>[ <coerce>( <external-input> ) ]
// Receiver must be an identifier — drops `obj["dynamic"]` (string-keyed).
const INLINE_PATTERN = new RegExp(
	String.raw`\b[A-Za-z_$][\w$]*\s*\[\s*${COERCE_OPENERS}[^\]]*${EXTERNAL_INPUT}[^\]]*\]`,
	"g",
);

// Assignment form: <const|let|var> <name> = <coerce>( ... <external-input> ... )
const ASSIGNMENT_PATTERN = new RegExp(
	String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*\w+)?\s*=\s*${COERCE_OPENERS}[^;]*${EXTERNAL_INPUT}[^;]*\)`,
	"g",
);

/** Lookahead window (lines) within which we treat a later index use as
 * "the same function." Larger than realistic handler bodies, smaller than
 * file size — keeps the scan fast and avoids cross-function false positives. */
const TWO_STEP_LOOKAHEAD_LINES = 60;
/** Cap matches per file to keep reports focused. */
const MAX_MATCHES_PER_FILE = 10;
/** Truncate report line text. */
const REPORT_LINE_TRUNC = 150;

/**
 * Build a regex that matches a known-safe guard against `name`. Guards must
 * appear textually BEFORE the index use to count as protection.
 */
function buildGuardPattern(name: string): RegExp {
	const n = name.replace(/[$]/g, "\\$");
	const parts = [
		// Number.isFinite(name) / Number.isInteger(name) / Number.isSafeInteger(name)
		String.raw`Number\.isFinite\s*\(\s*${n}\s*\)`,
		String.raw`Number\.isInteger\s*\(\s*${n}\s*\)`,
		String.raw`Number\.isSafeInteger\s*\(\s*${n}\s*\)`,
		// name < <ident>.length / name <= <ident>.length
		String.raw`\b${n}\s*<=?\s*[\w$]+\.length\b`,
		// <ident>.length > name / >= name
		String.raw`\b[\w$]+\.length\s*>=?\s*${n}\b`,
		// Range guard: name >= 0 (combined with later upper-bound is enough
		// for our purposes — full range expressions are caught by the
		// other clauses).
		String.raw`\b${n}\s*>=?\s*0\b`,
		// Throw / return on bad value mentioning name
		String.raw`(?:throw|return)\b[^;]*\b${n}\b[^;]*[;\n]`,
	];
	return new RegExp(parts.join("|"));
}

/**
 * Process one two-step assignment match: scan the lookahead window for a
 * later `<receiver>[<name>]` index use with no guard between the assignment
 * and the use, recording each unguarded use found.
 */
function processTwoStepAssignment(
	assignHit: RegExpExecArray,
	stripped: string,
	lineOffsets: number[],
	recordMatch: (offset: number) => void,
	hasCapacity: () => boolean,
): void {
	const name = assignHit[1];
	const assignOffset = assignHit.index;
	const assignLineNo = stripped.slice(0, assignOffset).split("\n").length;

	const windowStart = assignOffset + assignHit[0].length;
	const lookaheadEndLine = assignLineNo + TWO_STEP_LOOKAHEAD_LINES;
	const windowEnd =
		lookaheadEndLine - 1 < lineOffsets.length
			? lineOffsets[lookaheadEndLine - 1]
			: stripped.length;

	const window = stripped.slice(windowStart, windowEnd);
	const escaped = nonNull(name).replace(/[$]/g, "\\$");
	// `<receiver>[<name>]` — index access where the bracket contains
	// only the name (and optional whitespace).
	const indexUseRe = new RegExp(
		String.raw`[A-Za-z_$][\w$]*\s*\[\s*${escaped}\s*\]`,
		"g",
	);
	const guardRe = buildGuardPattern(nonNull(name));

	let useHit: RegExpExecArray | null;
	while ((useHit = indexUseRe.exec(window))) {
		const useAbsoluteOffset = windowStart + useHit.index;
		const between = stripped.slice(windowStart, useAbsoluteOffset);
		if (guardRe.test(between)) continue;
		recordMatch(useAbsoluteOffset);
		if (!hasCapacity()) break;
	}
}

/**
 * Detect external-input numeric values reaching array subscripts without a
 * Number.isFinite or length-bound guard.
 *
 * Scope: TS/JS source only. Up to 10 matches per file.
 */
export function checkIndexBoundsUnchecked(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	const recordMatch = (offset: number) => {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;
		if (seen.has(offset)) return;
		seen.add(offset);
		const lineNo = stripped.slice(0, offset).split("\n").length;
		matches.push({
			line: lineNo,
			text: (lines[lineNo - 1] || "").trim().slice(0, REPORT_LINE_TRUNC),
		});
	};
	const hasCapacity = () => matches.length < MAX_MATCHES_PER_FILE;

	// --- Pass 1: inline coercion-as-index ---
	const inlineRe = new RegExp(INLINE_PATTERN.source, "g");
	let inlineHit: RegExpExecArray | null;
	while ((inlineHit = inlineRe.exec(stripped))) {
		recordMatch(inlineHit.index);
	}

	// Precompute line-start char offsets once: lineOffsets[i] is the char
	// offset where line (i+1) begins (1-based line numbers). Used to
	// translate "line N + 60 lines" into a substring window without
	// re-walking the source per assignment match.
	const lineOffsets: number[] = [0];
	for (let i = 0; i < stripped.length; i++) {
		if (stripped.charAt(i) === "\n") lineOffsets.push(i + 1);
	}

	// --- Pass 2: two-step (assignment ... later index use, no guard between) ---
	const assignRe = new RegExp(ASSIGNMENT_PATTERN.source, "g");
	let assignHit: RegExpExecArray | null;
	while ((assignHit = assignRe.exec(stripped))) {
		if (!hasCapacity()) break;
		processTwoStepAssignment(
			assignHit,
			stripped,
			lineOffsets,
			recordMatch,
			hasCapacity,
		);
	}

	return matches;
}
