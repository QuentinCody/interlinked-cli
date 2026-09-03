// test_contract_annotation (Plan 25 lane 7,
// docs/plans/25-refactor-readiness-program.md). ADOPTION-TRIGGERED: this
// check is silent for every repo that has never used the `test-contract:`
// comment convention. The convention is documented in
// docs/design/session-2026-08-11-synthesis.md, scoped explicitly to
// "a mutation-directed JS/TS test file (`*.mutation-kill.*`,
// `*.mutation-hardening.*`, or `*.survivor(s).*`)" — e.g.
// `hook-entry-cold-gates.mutation-kill.test.ts`. Once a MUTATION-DIRECTED
// test file already carries at least one `test-contract:` marker, this check
// starts holding every `it()`/`test()` block in that same file to the same
// standard — a newly added block with no marker in the 3 lines above it is
// the gap. Zero-FP by construction for non-adopters: the file-shape gate and
// the adoption gate below both run before any block scanning.
//
// CALIBRATED (2026-08-17, scratch/plan25-lanes-6-8-calibration.mts): the
// first cut scoped only to `isStrictTestFile` (every test file, not just
// mutation-directed ones) fired 745 times across 87 files — ordinary test
// files that happen to carry a single spot `test-contract:` comment (not
// real adopters of the "every case gets one" discipline) dominated. Adding
// the mutation-directed file-shape gate below cut it to 220 across 29 files
// — still noisy. Per-file inspection showed a clean bimodal split: files
// like agent-safety-deps.mutation-kill.test.ts (36 markers / 36 it() blocks,
// 100%) and coordination.mutation-kill.test.ts (21/21, 100%) genuinely
// committed to the discipline, while files like
// supermodel-graph.mutation-kill.test.ts (1 marker / 39 blocks, 2.5%) and
// assert-side-effects.mutation-kill.test.ts (3/41, 7%) used the marker once
// as a spot annotation, not systematic adoption. MIN_ADOPTION_RATIO below
// (0.5) sits cleanly between those two clusters — it is a measured split
// point, not an arbitrary threshold cut.
//
// A THIRD calibration fix: a fixed "3 lines above" window (the original
// spec) still under-credited real coverage — agent-safety-deps.mutation-
// kill.test.ts's own markers are real multi-line rationale comments (e.g.
// "// test-contract: public-api — the module's own doc comment: \"...\"" /
// "// built-in module names..." / "// Every one of the 34 names..." / then
// `it(`, 4 lines below the marker's own first line). A block IS covered
// when `test-contract:` appears ANYWHERE in the CONTIGUOUS comment block
// immediately above it — regardless of that block's length — not only
// within a fixed line count. {@link isCoveredByAdjacentComment} walks
// backward through unbroken comment lines (a blank line or a code line ends
// the block, so isolation between adjacent it() blocks is preserved) up to
// MAX_COMMENT_WALKBACK_LINES.

import { stripLiteralsKeepComments } from "../strip-helpers.js";
import { getExtension, type InlineMatch, isStrictTestFile, JS_TS_ALL_EXTS } from "./shared.js";

const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 150;
/** Upper bound on how far back {@link isCoveredByAdjacentComment} walks
 *  through a contiguous comment block — generous, but not unbounded. */
const MAX_COMMENT_WALKBACK_LINES = 20;
const ADOPTION_MARKER = "test-contract:";
/** `*.mutation-kill.*` / `*.mutation-hardening.*` / `*.survivor(s).*` — the
 *  convention's own documented scope (session-2026-08-11-synthesis.md). */
const MUTATION_DIRECTED_PATH_RE = /\.(?:mutation-kill|mutation-hardening|survivors?)\.[^/]*$/;
/** A file must already mark at least HALF its it()/test() blocks before this
 *  check holds the rest to the same standard — see CALIBRATED note above. */
const MIN_ADOPTION_RATIO = 0.5;

/** `it(`, `test(`, and their `.only`/`.skip`/`.todo`/`.each(...)` modifiers.
 *  Matched against comment-aware, string/template-blanked text (see
 *  {@link stripLiteralsKeepComments}) so a fixture string containing the
 *  literal text "it(" never counts as a real block opener. Comment LINES are
 *  excluded separately by {@link isCommentOnlyLine} — this regex alone can't
 *  tell "it(" the call from "it()" mentioned in prose.
 *
 *  The leading `(?<![.\w$])` excludes a DOTTED `.test(` — CALIBRATED
 *  (2026-08-17): `/pattern/.test(f)` (RegExp.prototype.test, a totally
 *  unrelated built-in) matched the bare `\btest\(` form, since `\b` only
 *  guards against "test" being a substring of a longer identifier, not
 *  against a preceding `.`. Vitest/Jest's `it`/`test` are always called
 *  bare (`it(...)`, `test(...)`), never as `<receiver>.it(...)`. */
const TEST_BLOCK_RE =
	/(?<![.\w$])(?:it|test)(?:\.(?:only|skip|todo|each(?:\([^)]*\))?))?\s*\(/;

/**
 * True for a line that is ENTIRELY a comment (after trimming). CALIBRATED
 * (2026-08-17): before this guard, a prose comment like
 * "// or network — every `it()` below is annotated..." matched TEST_BLOCK_RE
 * and was reported as an uncovered block opener. `stripLiteralsKeepComments`
 * deliberately keeps comment text intact (this check needs to read
 * `test-contract:` markers), so a mention of "it()" inside a comment is
 * textually indistinguishable from a real call unless comment LINES are
 * excluded from block-opener candidacy directly.
 */
function isCommentOnlyLine(trimmed: string): boolean {
	return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/** Count real (non-comment-line) it()/test( block openers in `scanLines`. */
function countTestBlockOpeners(scanLines: string[]): number {
	let n = 0;
	for (const line of scanLines) {
		if (isCommentOnlyLine(line.trim())) continue;
		if (TEST_BLOCK_RE.test(line)) n++;
	}
	return n;
}

/** Count `test-contract:` occurrences across the whole file. */
function countAdoptionMarkers(content: string): number {
	return (content.match(/test-contract:/g) ?? []).length;
}

/** True once the file's marker-to-block ratio clears {@link MIN_ADOPTION_RATIO}
 *  — see the CALIBRATED note in the file header for why this exists. */
function hasSystematicAdoption(content: string, scanLines: string[]): boolean {
	const totalBlocks = countTestBlockOpeners(scanLines);
	if (totalBlocks === 0) return false;
	return countAdoptionMarkers(content) / totalBlocks >= MIN_ADOPTION_RATIO;
}

/**
 * True when `test-contract:` appears anywhere in the CONTIGUOUS run of
 * comment lines directly above `blockLineIdx` — a blank line or a code line
 * ends the block (so an unrelated marker further up, or a PRECEDING it()
 * block's own marker, can never leak across). See the file header's THIRD
 * calibration fix for why this replaced a fixed line-count window.
 */
function isCoveredByAdjacentComment(scanLines: string[], blockLineIdx: number): boolean {
	const floor = Math.max(0, blockLineIdx - MAX_COMMENT_WALKBACK_LINES);
	for (let i = blockLineIdx - 1; i >= floor; i--) {
		const line = scanLines[i];
		if (line === undefined) break;
		const trimmed = line.trim();
		if (trimmed === "" || !isCommentOnlyLine(trimmed)) break;
		if (trimmed.includes(ADOPTION_MARKER)) return true;
	}
	return false;
}

/**
 * Detect an `it()`/`test()` block with no `test-contract:` comment in the
 * contiguous comment block directly above it (see
 * {@link isCoveredByAdjacentComment}), but ONLY in a mutation-directed test
 * file (`*.mutation-kill.*`, `*.mutation-hardening.*`, `*.survivor(s).*`)
 * that has SYSTEMATICALLY adopted the convention (see
 * {@link hasSystematicAdoption}) — the convention's own documented scope,
 * see file header.
 */
/**
 * Build the finding for one scan line if it is an `it()`/`test()` block with
 * no `test-contract:` comment directly above it, or `null` when the line
 * doesn't qualify (not a test block, comment-only, or already covered).
 */
function matchUnannotatedTestBlock(
	scanLines: string[],
	rawLines: string[],
	lineIdx: number,
): InlineMatch | null {
	const line = scanLines[lineIdx];
	if (line === undefined) return null;
	if (isCommentOnlyLine(line.trim()) || !TEST_BLOCK_RE.test(line)) return null;
	if (isCoveredByAdjacentComment(scanLines, lineIdx)) return null;

	const text = (rawLines[lineIdx] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
	return {
		line: lineIdx + 1,
		text: `test_contract_annotation: it(/test( block has no test-contract: comment directly above it — ${text}`,
	};
}

export function detectTestContractAnnotation(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!MUTATION_DIRECTED_PATH_RE.test(filePath.replace(/\\/g, "/"))) return [];
	if (!JS_TS_ALL_EXTS.includes(getExtension(filePath))) return [];
	if (content.length === 0) return [];
	if (!content.includes(ADOPTION_MARKER)) return [];

	const scanLines = stripLiteralsKeepComments(content).split("\n");
	if (!hasSystematicAdoption(content, scanLines)) return [];

	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < scanLines.length; i++) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		const match = matchUnannotatedTestBlock(scanLines, rawLines, i);
		if (match) matches.push(match);
	}

	return matches;
}
