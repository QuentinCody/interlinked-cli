// ===========================================
// Test portability — env-divergent test detection (finding 2026-06)
// ===========================================
// Born from a red CI run that local validation could not see: two tests passed
// on the dev Mac and failed on every CI runner. Both had a deterministic
// as-written signature this family catches at edit time:
//
//   1. PLATFORM-CONDITIONAL NARRATION — a comment admits the fixture behaves
//      differently per platform ("On platforms where the temp dir lives under
//      a symlink…", "macOS-only") while the NARRATED TEST never gates on it.
//      The assertion then encodes ONE platform's outcome and fails on the
//      others (the config-loosening test leaned on macOS's /tmp symlink; on
//      Linux the gate legitimately fired). Fix: construct the condition
//      explicitly (own symlink / fixture) or gate the test it describes.
//
//   2. SILENT DEPENDENCY SKIP — `if (!X_AVAILABLE) return;` (bare, braced, or
//      multi-line) at the top of a test records a PASS where the external
//      binary is missing. On CI (no ripgrep) nine such tests "passed" while
//      running nothing — coverage theater that hid the dependency gap until
//      an unguarded sibling failed. Fix: `it.skipIf(!X_AVAILABLE)(…)` so the
//      skip is REPORTED and visible in every run's summary.
//
// Hardened per two review rounds (2026-06), each a reproducible FP/FN class:
//   - Evidence is tied to the NARRATED test via test-structure block spans —
//     a `.skipIf` on an unrelated sibling no longer vouches for the file, and
//     a `process.platform` mention in prose no longer counts as a gate.
//   - A gate only counts when its CONDITION is platform-related: an inline
//     platform API, a constant derived from one in this file, or a
//     platform-named flag (IS_NOT_LINUX, onMac). `it.skipIf(!dockerAvailable)`
//     does not address platform divergence — the test still runs on every
//     platform where docker exists. `.skip`/`.todo`/`.fails` always count
//     (the case never runs, so the narration is acknowledged). The same rule
//     applies to RUNTIME skips: `if (!dockerAvailable) ctx.skip()` is judged
//     by its condition, only an unconditional `ctx.skip()` counts by itself.
//   - Both detectors scan MASKED source (stripAllLiterals): comments, fixture
//     strings, templates, and regex literals can neither trigger a finding
//     nor suppress one. Narration is read from the complementary mask
//     (stripLiteralsKeepComments): claims live in comments, evidence in code.
//   - The silent-skip consequent is analyzed structurally (braced and
//     multi-line forms match; consequents that skip/throw/assert are
//     handled), and a guard only fires INSIDE a test callback span — an
//     early return in a module-level helper or lifecycle hook is not a test
//     skip and must not get the "records a PASS" message.
//   - Gating uses isStrictTestFile per the shared-helper contract: these are
//     test-hygiene checks, so the harness-internal data-file exemption in the
//     broad isTestFile must not drag detector/registry sources into scope.
//     Both checks are JS/TS-scoped — their gating idioms (skipIf, vitest
//     ctx.skip) and callsite shapes are JS test-runner conventions.

import { nonNull } from "../../lib/non-null.js";
import { stripAllLiterals, stripLiteralsKeepComments } from "../strip-helpers.js";
import { isJsTs, lineIdxForOffset } from "../taste-checks-shared.js";
import { type InlineMatch, isStrictTestFile } from "./shared.js";
import {
	blockStartingWithin,
	extractTestBlocks,
	gatedByChain,
	innermostBlockAt,
	inTestBlock,
	type TestBlock,
} from "./test-structure.js";

const MAX_MATCHES = 10;

/** Comment phrases that admit platform-variant behavior. Deliberately tight —
 *  neutral mentions ("works on every platform") must not fire. */
const PLATFORM_NARRATION_RES: readonly RegExp[] = [
	/\bon platforms? where\b/i,
	/\bplatform-(?:dependent|specific)\b/i,
	/\b(?:macos|os x|darwin|linux|windows)[- ]only\b/i,
	/\bonly on (?:macos|os x|darwin|linux|windows)\b/i,
];

/** A comment-ish line: `//`, `*` continuation, or `/*` opener. Tested against
 *  the literals-stripped view, so a comment-shaped line inside a template or
 *  string fixture (already blanked there) can never narrate. */
const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|\/\*)/;

/** How far below an out-of-block narration comment to look for the test it
 *  introduces (the comment-above-`it(` convention). */
const NARRATION_LOOKDOWN_LINES = 5;

/** Platform APIs that count as the test actually branching on environment.
 *  Matched against MASKED code only — a mention in a comment or string is
 *  prose, not evidence. */
const PLATFORM_REF_RE =
	/process\.platform|process\.arch|\bos\.(?:platform|type|arch|release|version)\s*\(|navigator\.platform/;

/** Runtime skip calls: vitest `ctx.skip()`, mocha `this.skip()`, node:test
 *  `t.skip()`. A runtime skip is platform evidence only when UNCONDITIONAL
 *  (the test never runs — like `.skip`, the narration is acknowledged). A skip
 *  guarded by `if (cond)` speaks only through its condition: a platform-related
 *  guard's identifiers already satisfy the identifier scan, while
 *  `if (!dockerAvailable) ctx.skip()` is NOT platform evidence — that test
 *  still runs, ungated, on every platform where docker exists (review round 3). */
const RUNTIME_SKIP_RE = /\b(?:ctx|context|t|this)\s*\.\s*skip\s*\(/g;

/** Generic `if (…)` matcher (one nesting level in the condition) used to map
 *  which runtime skips are condition-guarded. A condition too nested to match
 *  leaves its skip looking unconditional — the suppression-safe direction for
 *  this heuristic-tier check. */
const IF_CONDITION_RE = /\bif\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;

/** The [start, end) span of an `if`'s consequent on masked source: a braced
 *  block, or the bare statement up to `;` / end-of-line. */
function consequentSpan(masked: string, afterCond: number): [number, number] {
	let j = afterCond;
	while (j < masked.length && /\s/.test(nonNull(masked[j]))) j++;
	if (masked[j] === "{") {
		const close = findConsequentClose(masked, j);
		return [j, close === -1 ? masked.length : close + 1];
	}
	let end = j;
	while (end < masked.length && masked[end] !== ";" && masked[end] !== "\n") end++;
	return [j, end + 1];
}

/** True when the slice contains a runtime skip call that is NOT inside any
 *  `if` consequent — an always-skipped test, the runtime spelling of `.skip`. */
function hasUnconditionalRuntimeSkip(maskedSlice: string): boolean {
	const skipOffsets = [...maskedSlice.matchAll(RUNTIME_SKIP_RE)].map((m) => m.index);
	if (skipOffsets.length === 0) return false;
	const consequents: Array<[number, number]> = [];
	for (const m of maskedSlice.matchAll(IF_CONDITION_RE)) {
		consequents.push(consequentSpan(maskedSlice, m.index + m[0].length));
	}
	return skipOffsets.some((k) => !consequents.some(([s, e]) => k >= s && k < e));
}

/** Module-level platform constants (`const onMac = process.platform === …`):
 *  a gate condition or body referencing one of these names is platform-aware
 *  even though the `process.platform` text lives in the declaration. */
const PLATFORM_CONST_DECL_RE =
	/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*?process\.platform/g;

/** Identifier name segments that read as platform flags. Catches constants
 *  imported from helper modules (IS_WINDOWS, onMac, ciIsWsl) whose
 *  declarations this single-file scan cannot see. Segment-exact on split
 *  camelCase/snake_case words, so `twinCache` or `dockerAvailable` never
 *  match. Generic-but-platform-adjacent words (`os`, `platform`, `arch`) are
 *  included on purpose: suppression is the safe direction for this
 *  heuristic-tier check. */
const PLATFORM_NAME_SEGMENTS = new Set([
	"mac",
	"macos",
	"osx",
	"darwin",
	"linux",
	"windows",
	"win32",
	"wsl",
	"unix",
	"posix",
	"platform",
	"arch",
	"os",
]);

const IDENTIFIER_RE = /[A-Za-z_$][\w$]*/g;

function identifierHasPlatformSegment(id: string): boolean {
	const segments = id
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/);
	return segments.some((s) => PLATFORM_NAME_SEGMENTS.has(s));
}

function platformConstantNames(masked: string): string[] {
	const names: string[] = [];
	for (const m of masked.matchAll(PLATFORM_CONST_DECL_RE)) names.push(nonNull(m[1]));
	return names;
}

/** Is this masked code slice platform-aware: an inline platform API, a
 *  platform-derived constant from this file, a platform-named identifier, or
 *  an UNCONDITIONAL runtime skip (the test never runs)? A condition-guarded
 *  skip is judged by its condition's identifiers, not by the skip itself. */
function hasPlatformEvidence(maskedSlice: string, constNames: readonly string[]): boolean {
	if (PLATFORM_REF_RE.test(maskedSlice)) return true;
	const ids = maskedSlice.match(IDENTIFIER_RE) ?? [];
	if (ids.some((id) => constNames.includes(id) || identifierHasPlatformSegment(id))) return true;
	return hasUnconditionalRuntimeSkip(maskedSlice);
}

/** A `.skipIf`/`.runIf` condition gates PLATFORM divergence only when it
 *  references the platform (review round 2): `!dockerAvailable` leaves the
 *  test running on every platform where docker exists, so it is not
 *  evidence against platform narration. */
function isPlatformCondition(condition: string, constNames: readonly string[]): boolean {
	if (PLATFORM_REF_RE.test(condition)) return true;
	const ids = condition.match(IDENTIFIER_RE) ?? [];
	return ids.some((id) => constNames.includes(id) || identifierHasPlatformSegment(id));
}

/** The block a narration comment is ABOUT: the test containing it, else the
 *  first block starting just below it (comment-above-test), else whatever
 *  suite contains it. -1 means file-level prose. */
function subjectBlockFor(blocks: TestBlock[], line: number): number {
	const inner = innermostBlockAt(blocks, line);
	if (inner !== -1 && nonNull(blocks[inner]).kind === "test") return inner;
	const below = blockStartingWithin(blocks, line + 1, line + NARRATION_LOOKDOWN_LINES);
	return below !== -1 ? below : inner;
}

/** Comment-view lines (index-aligned with `content`) whose text narrates
 *  platform-conditional behavior. */
function findNarratedLines(content: string): number[] {
	const commentView = stripLiteralsKeepComments(content).split("\n");
	const narrated: number[] = [];
	for (let i = 0; i < commentView.length; i++) {
		const line = nonNull(commentView[i]);
		if (!COMMENT_LINE_RE.test(line)) continue;
		if (PLATFORM_NARRATION_RES.some((re) => re.test(line))) narrated.push(i);
	}
	return narrated;
}

/** Shared read-only context for evidence lookups across narrated lines. */
interface NarrationContext {
	blocks: TestBlock[];
	mLines: string[];
	masked: string;
	constNames: readonly string[];
	platformGates: (condition: string) => boolean;
}

/** Whether the test/suite that narrated line `i` is ABOUT already has
 *  platform evidence (a gate, a platform reference, or an unconditional
 *  skip) — see `subjectBlockFor` for how the subject block is chosen. */
function isNarrationEvidenced(ctx: NarrationContext, i: number): boolean {
	const subject = subjectBlockFor(ctx.blocks, i);
	if (subject === -1) {
		// File-level prose: accept platform awareness anywhere in real code.
		return hasPlatformEvidence(ctx.masked, ctx.constNames);
	}
	const b = nonNull(ctx.blocks[subject]);
	const slice = ctx.mLines.slice(b.startLine, b.endLine + 1).join("\n");
	return gatedByChain(ctx.blocks, subject, ctx.platformGates) || hasPlatformEvidence(slice, ctx.constNames);
}

/**
 * Flag test files whose comments NARRATE platform-conditional behavior while
 * the test they describe never branches on it — the assertions silently
 * encode one platform's outcome. Evidence must be associated with the
 * narrated test AND be platform-related: a platform-conditioned gate on the
 * test or an enclosing suite, a platform reference in its body, or an
 * unconditional .skip/.todo. One match per narrating line.
 */
export function checkPlatformConditionalAssertion(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!isStrictTestFile(filePath) || !isJsTs(filePath)) return [];
	const narrated = findNarratedLines(content);
	if (narrated.length === 0) return [];

	const masked = stripAllLiterals(content);
	const mLines = masked.split("\n");
	const blocks = extractTestBlocks(mLines);
	const constNames = platformConstantNames(masked);
	const platformGates = (condition: string): boolean => isPlatformCondition(condition, constNames);
	const originalLines = content.split("\n");
	const ctx: NarrationContext = { blocks, mLines, masked, constNames, platformGates };

	const matches: InlineMatch[] = [];
	for (const i of narrated) {
		if (matches.length >= MAX_MATCHES) break;
		if (isNarrationEvidenced(ctx, i)) continue;
		matches.push({
			line: i + 1,
			text:
				"[comment narrates platform-conditional behavior but the narrated test never gates on it — " +
				"the assertions encode ONE platform's outcome and will fail on the others (CI). " +
				"Construct the condition explicitly in the fixture, or gate THIS test with " +
				`skipIf/process.platform] ${(originalLines[i] ?? "").trim().slice(0, 100)}`,
		});
	}
	return matches;
}

/** The silent availability guard condition: `if (!X_AVAILABLE)` (also the
 *  `=== null` / `=== false` spellings, flag or nullary call). The IDENTIFIER
 *  is the discriminator — only names ending in `_AVAILABLE`/`Available`
 *  match, so ordinary data-shaped early returns (`if (!result) return;`)
 *  never fire. The consequent is analyzed separately so bare, braced, and
 *  multi-line forms are all covered. */
const AVAILABILITY_GUARD_RE =
	/\bif\s*\(\s*(?:!\s*[A-Za-z_$][\w$]*(?:_AVAILABLE|Available)\s*(?:\(\s*\)\s*)?|[A-Za-z_$][\w$]*(?:_AVAILABLE|Available)\s*(?:\(\s*\)\s*)?===?\s*(?:null|false)\s*)\)/g;

/** A consequent containing any of these HANDLES the missing dependency
 *  visibly (reported skip, loud failure, or an assertion about the absence)
 *  rather than silently passing. */
const CONSEQUENT_HANDLED_RE =
	/\b(?:ctx|context|t|this)\s*\.\s*skip\b|\bexpect\s*\(|\bassert\w*\s*[.(]|\bthrow\b|\bfail\s*\(/;

/** A braced consequent whose last statement is a bare `return` — the block
 *  bypasses the rest of the test and still reports PASS. */
const TRAILING_BARE_RETURN_RE = /(?:^|[;{}\n])\s*return\s*;?\s*$/;

/** Bare `return` at `returnIdx`: only `;`, `}` or end-of-line may follow on
 *  the same line (ASI makes a newline end it). `return someValue` is not an
 *  early skip. */
function isBareReturn(masked: string, returnIdx: number): boolean {
	const lineEnd = masked.indexOf("\n", returnIdx);
	const rest =
		lineEnd === -1 ? masked.slice(returnIdx + 6) : masked.slice(returnIdx + 6, lineEnd);
	return /^[ \t]*(?:[;}]|$)/.test(rest);
}

/** Matching `}` for the `{` at `openBrace`, on masked source (string/template
 *  braces are blanked there, so counting is structural). -1 if unbalanced. */
function findConsequentClose(masked: string, openBrace: number): number {
	let depth = 0;
	for (let k = openBrace; k < masked.length; k++) {
		const c = masked[k];
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return k;
		}
	}
	return -1;
}

/** True iff the guard's consequent silently bypasses the test: a bare
 *  `return` (inline or as the braced block's final statement) with no skip /
 *  assertion / throw anywhere in the block. */
function consequentIsSilentSkip(masked: string, afterCond: number): boolean {
	let j = afterCond;
	while (j < masked.length && /\s/.test(nonNull(masked[j]))) j++;
	if (masked.startsWith("return", j)) return isBareReturn(masked, j);
	if (masked[j] === "{") {
		const close = findConsequentClose(masked, j);
		if (close === -1) return false; // unbalanced — fail open
		const body = masked.slice(j + 1, close);
		if (CONSEQUENT_HANDLED_RE.test(body)) return false;
		return TRAILING_BARE_RETURN_RE.test(body);
	}
	return false;
}

/**
 * Flag the silent early-return availability guard INSIDE test callbacks. The
 * guard records a PASS where the dependency is absent — every environment
 * without the binary reports green while running nothing. `it.skipIf(...)`
 * reports the skip instead, so a dependency gap is visible in the run summary
 * (the runtime catch CI needs). Guards in module-level helpers or lifecycle
 * hooks are not test skips and are exempt (review round 2). One match per
 * guard, bare or braced, inline or multi-line.
 */
export function checkSilentDependencySkip(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath) || !isJsTs(filePath)) return [];
	const masked = stripAllLiterals(content);
	const mLines = masked.split("\n");
	const blocks = extractTestBlocks(mLines);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];
	for (const m of masked.matchAll(AVAILABILITY_GUARD_RE)) {
		if (matches.length >= MAX_MATCHES) break;
		const idx = m.index;
		if (!consequentIsSilentSkip(masked, idx + m[0].length)) continue;
		const lineIdx = lineIdxForOffset(masked, idx);
		if (!inTestBlock(blocks, lineIdx)) continue; // helper / hook, not a test skip
		matches.push({
			line: lineIdx + 1,
			text:
				"[silent dependency skip — this early return records a PASS wherever the " +
				"dependency is missing (CI included), hiding the gap. Use it.skipIf(...)/" +
				`describe.skipIf(...) so the skip is REPORTED] ${(originalLines[lineIdx] ?? "").trim().slice(0, 100)}`,
		});
	}
	return matches;
}
