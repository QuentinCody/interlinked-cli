// CLASS: loop-only assertions can execute zero times for an empty collection.
// FIRES WHEN: every expect in an active test lies in a recognized for-of/in,
// indexed for, forEach/map/every loop, and any innermost enclosing collection
// lacks a recognized non-empty pin or literal binding.
// DOES NOT FIRE: assertions outside loops; each rows; literal collections;
// recognized length/size/whole-array pins (including C.map(fn).toEqual(nonempty));
// same-file one-hop aliases; a positive literal expect.assertions count or
// hasAssertions; an in-block empty-length throw guard. A throw/fail inside the
// loop is also an intentional low-recall exemption, not proof of non-emptiness.
// CALIBRATION (2026-09-07, this tree; historical passes differ in corpus scope):
// | pass | hits/files | inspected precision | correction |
// | builder 1/2/3 | 124/75 -> 112/68 -> 105/61 | claimed 8/8; at most 6/8 | two known mapped-pin FPs |
// | review | 85/54 | not independently measured | mapped pins; assertions(0) is not a guard |
// The earlier 8/8 claim counted recognized detector shapes as correct findings,
// despite node-fetch and quality-frontier having mapped collection pins.
// KNOWN GAPS: file-wide textual identity can conflate local names; aliasing a
// filtered collection to its input does not guarantee non-emptiness. Nested
// outer loops, while loops and property-test generators are incompletely modeled.
// HOW TO EXTEND: add loop/pin shapes to the respective helpers with labeled P/N
// companions. Census: scripts/scan-test-discrimination.ts; never call a known FP a TP.

import { nonNull } from "../../lib/non-null.js";
import { stripAllLiterals } from "../strip-helpers.js";
import { getExtension, type InlineMatch, isTestFile, JS_TS_EXTS } from "./shared.js";
import { findLoopSpans, innermostLoopIndex, type RawLoopSpan } from "./test-vacuous-loop-loops.js";
import {
	blockHasLengthThrowGuard,
	blockHasWideGuard,
	classifyTarget,
	fileAliasBases,
	fileLiteralCollections,
	isProvenNonEmpty,
	loopBodyHasThrowOrFail,
} from "./test-vacuous-loop-pins.js";
import { extractTestBlocks, type TestBlock } from "./test-structure.js";

const MAX_MATCHES = 10;

// `expect(` assertion openings — deliberately excludes `expect.assertions(`
// / `expect.hasAssertions(` (those require a literal `.` before the paren,
// which this pattern's immediate `\(` cannot match).
const EXPECT_CALL_RE = /\bexpect\(/g;

/** Offsets of every `expect(` assertion opening in a masked block body. */
function findExpectPositions(body: string): number[] {
	const positions: number[] = [];
	EXPECT_CALL_RE.lastIndex = 0;
	let m: RegExpExecArray | null = EXPECT_CALL_RE.exec(body);
	while (m !== null) {
		positions.push(m.index);
		m = EXPECT_CALL_RE.exec(body);
	}
	return positions;
}

const EACH_START_RE = /^\s*(?:it|test)\s*\.\s*each\b/;
const EACH_WINDOW_LINES = 8;

/** True when `block`'s own opening line(s) are an `it.each`/`test.each`
 *  callsite — the row table is the loop, exempted outright (exemption d). */
function isEachBlock(mLines: string[], block: TestBlock): boolean {
	const window = mLines.slice(block.startLine, block.startLine + EACH_WINDOW_LINES).join("\n");
	return EACH_START_RE.test(window);
}

/** True when `block` or any enclosing ancestor carries an unconditional
 *  skip/todo/fails gate — the case never runs, so it can't be vacuous. */
function isGatedOut(blocks: TestBlock[], blockIdx: number): boolean {
	let idx: number = blockIdx;
	while (idx !== -1) {
		const b = blocks[idx];
		if (!b) return false;
		if (b.unconditionalGate) return true;
		idx = b.parent;
	}
	return false;
}

/** File-wide state shared by every block's proof lookup: the masked file
 *  text (for `isProvenNonEmpty`), the file-level literal collections, and
 *  the one-hop alias map. Bundled so the per-block helpers below take one
 *  object instead of a long positional tail. */
interface FileProofContext {
	fileMasked: string;
	literals: Map<string, boolean>;
	aliasBases: Map<string, string>;
}

/** Whether every assertion-enclosing loop (keyed by `enclosingIdxs`) is
 *  proven safe, and the first loop's raw collection text (used in the
 *  finding's message). */
function evaluateEnclosingLoops(
	loops: RawLoopSpan[],
	enclosingIdxs: Set<number>,
	blockBody: string,
	ctx: FileProofContext,
): { anyUnproven: boolean; firstTargetRaw: string } {
	let firstTargetRaw = "";
	let anyUnproven = false;
	for (const idx of enclosingIdxs) {
		const loop = nonNull(loops[idx]);
		if (firstTargetRaw === "") firstTargetRaw = loop.targetRaw;
		const classified = classifyTarget(loop.targetRaw, ctx.literals);
		const guarded =
			classified.provenSafe ||
			isProvenNonEmpty(ctx.fileMasked, classified.key, ctx.aliasBases) ||
			loopBodyHasThrowOrFail(blockBody.slice(loop.start, loop.end)) ||
			blockHasLengthThrowGuard(blockBody, classified.key);
		if (!guarded) anyUnproven = true;
	}
	return { anyUnproven, firstTargetRaw };
}

/** Build the finding for one qualifying block, or null when it doesn't
 *  qualify: no assertions, an assertion outside every loop, or every
 *  enclosing loop is proven non-empty. */
function matchForBlock(mLines: string[], block: TestBlock, ctx: FileProofContext): InlineMatch | null {
	const body = mLines.slice(block.startLine, block.endLine + 1).join("\n");
	if (blockHasWideGuard(body)) return null;

	const expectPositions = findExpectPositions(body);
	if (expectPositions.length === 0) return null;

	const loops = findLoopSpans(body);
	const enclosingIdxs = new Set<number>();
	for (const pos of expectPositions) {
		const idx = innermostLoopIndex(pos, loops);
		if (idx === -1) return null; // some assertion is outside every loop
		enclosingIdxs.add(idx);
	}

	const { anyUnproven, firstTargetRaw } = evaluateEnclosingLoops(loops, enclosingIdxs, body, ctx);
	if (!anyUnproven) return null;

	const text =
		`vacuous_loop_assertion: every assertion runs inside a loop over \`${firstTargetRaw}\` and nothing proves it non-empty — an empty result passes. Pin it first: expect(${firstTargetRaw}).toHaveLength(n) or expect(${firstTargetRaw}.length).toBeGreaterThan(0).`.slice(
			0,
			200,
		);
	return { line: block.startLine + 1, text };
}

/**
 * Flag it()/test() blocks whose every `expect(...)` assertion runs inside a
 * loop over a collection nothing proves non-empty. Returns [] when the file
 * is not a test file, is not JS/TS, or holds no such block.
 */
export function checkVacuousLoopAssertion(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const masked = stripAllLiterals(content);
	const mLines = masked.split("\n");
	const blocks = extractTestBlocks(mLines);
	const fileMasked = mLines.join("\n");
	const ctx: FileProofContext = {
		fileMasked,
		literals: fileLiteralCollections(fileMasked),
		aliasBases: fileAliasBases(fileMasked),
	};

	const matches: InlineMatch[] = [];
	for (let i = 0; i < blocks.length && matches.length < MAX_MATCHES; i++) {
		const block = blocks[i];
		if (!block || block.kind !== "test" || isGatedOut(blocks, i)) continue;
		if (isEachBlock(mLines, block)) continue;
		const found = matchForBlock(mLines, block, ctx);
		if (found) matches.push(found);
	}
	return matches;
}
