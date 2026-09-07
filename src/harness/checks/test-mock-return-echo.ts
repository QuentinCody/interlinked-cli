// CLASS: a test's expected literals coincide with values configured on its mocks.
// FIRES WHEN: every recognized value assertion uses only mock-supplied literals
// from the test or same-describe beforeEach. Supported suppliers are return/resolved
// value methods, expression-bodied implementations, vi.fn, and vi.mocked chains.
// DOES NOT FIRE: unmatched/computed values, a transformed subject, negation,
// thrown/rejected assertions, unresolved matchers, or an independent call-argument
// pin. Companion-SUT mock suppliers are excluded. Coarse literals (booleans,
// null/undefined/zero/empty strings/containers) contribute only when exactly one
// mock target is discovered; coarse-only evidence also requires one assertion.
// Quoted object keys do not contribute supplied values.
// CALIBRATION (2026-09-07, this tree; historical passes differ in corpus scope):
// | pass | hits/files | inspected precision | correction |
// | prototype | 52/31 | unmeasured | block-local suppliers |
// | builder 1/2 | 97/53 -> 88/48 | 2/3 reviewed TP | unrelated coarse boolean FP |
// | review | 79/43 | not independently measured | coarse, negation, throw, quoted-key fixes |
// KNOWN GAPS: flat literal sets are not dataflow proof; equal literals can be
// coincidental or a valid forwarding contract. Scope is one describe level;
// mock aliases, unnamed supplier identity and reassignment are incomplete.
// HOW TO EXTEND: update supplier extraction or assertion classification with P/N
// cases and recalibrate. Census: scripts/scan-test-discrimination.ts.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripComments,
} from "./shared.js";
import { findCallSpan, IT_TEST_OPEN_RE } from "./test-hygiene-shared.js";
import { isSkippedOrTodoCall, maskCommentsAndStrings } from "./test-hygiene-masking.js";
import { collectFilterKeyLiterals, evaluateItBlock } from "./test-mock-return-echo-assert.js";
import { buildImportMap, collectMockLiteralsInSpan, sutBaseFromPath } from "./test-mock-return-echo-mocks.js";
import type { Block } from "./test-mock-return-echo-types.js";

const MAX_MATCHES = 12;

const DESCRIBE_OPEN_RE = /\bdescribe(?:\.(?:only|skip|each|concurrent|sequential))?\s*\(/g;
const BEFORE_EACH_OPEN_RE = /\bbeforeEach\s*\(/g;

/** Collect every brace-balanced callsite of `re` as a `Block`, skipping
 *  `.skip`/`.todo` variants when `honorSkip` is set (describe/it only). */
function collectBlocks(masked: string, re: RegExp, kind: Block["kind"], honorSkip: boolean): Block[] {
	const out: Block[] = [];
	re.lastIndex = 0;
	let m: RegExpExecArray | null = re.exec(masked);
	while (m !== null) {
		if (!(honorSkip && isSkippedOrTodoCall(m[0]))) {
			const argsStart = m.index + m[0].length;
			const span = findCallSpan(masked, argsStart);
			if (span !== null) out.push({ kind, keywordStart: m.index, argsStart, end: span.end });
		}
		m = re.exec(masked);
	}
	return out;
}

/** Every `describe`/`it`/`beforeEach` block in the masked file, unordered
 *  within each kind but complete. */
function findBlocks(masked: string): { describes: Block[]; its: Block[]; beforeEaches: Block[] } {
	return {
		describes: collectBlocks(masked, DESCRIBE_OPEN_RE, "describe", true),
		its: collectBlocks(masked, IT_TEST_OPEN_RE, "it", true),
		beforeEaches: collectBlocks(masked, BEFORE_EACH_OPEN_RE, "beforeEach", false),
	};
}

/** The innermost `describe` block that textually contains `block` (never
 *  `block` itself), or null when `block` sits at the top level. */
function enclosingDescribe(describes: Block[], block: Block): Block | null {
	let best: Block | null = null;
	for (const d of describes) {
		if (d === block) continue;
		if (d.argsStart <= block.keywordStart && block.end <= d.end) {
			if (best === null || d.end - d.argsStart < best.end - best.argsStart) best = d;
		}
	}
	return best;
}

/** Evaluate one `it`/`test` block against the mocks reachable in its scope
 *  (its own body plus any same-describe-level `beforeEach`), returning a
 *  warning when the mock-return-echo shape is confirmed. */
function evaluateBlock(
	content: string,
	masked: string,
	itBlock: Block,
	describes: Block[],
	beforeEaches: Block[],
	importMap: Map<string, string>,
	sutBase: string,
): InlineMatch | null {
	const enclosing = enclosingDescribe(describes, itBlock);
	const siblingBeforeEaches = beforeEaches.filter((be) => enclosingDescribe(describes, be) === enclosing);
	const spans = [itBlock, ...siblingBeforeEaches];
	const { literals, targets } = collectMockLiteralsInSpan(content, masked, spans, importMap, sutBase);
	const filterKeyLiterals = collectFilterKeyLiterals(content, masked, itBlock.argsStart, itBlock.end);
	for (const lit of filterKeyLiterals) literals.delete(lit);
	if (literals.size === 0) return null;
	const verdict = evaluateItBlock(content, masked, itBlock, literals);
	if (verdict === null) return null;
	const mockName = targets.values().next().value ?? "the mock";
	const text =
		`mock_return_echo: the only asserted value ("${verdict.display}") is the literal this test fed to ${mockName} — a pass-through stub passes. Assert what the SUT computes: a transformed field, a call argument, or a side effect.`.slice(
			0,
			200,
		);
	const lineIdx = (masked.slice(0, itBlock.keywordStart).match(/\n/g) ?? []).length;
	return { line: lineIdx + 1, text };
}

/**
 * Flags `it()`/`test()` blocks where every value assertion merely echoes a
 * literal already fed into a same-scope mock — proving pass-through, not
 * computation. See the module header for the full contract.
 */
export function checkMockReturnEcho(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const masked = maskCommentsAndStrings(content);
	const stripped = stripComments(content);
	const sutBase = sutBaseFromPath(filePath);
	const importMap = buildImportMap(stripped);
	const { describes, its, beforeEaches } = findBlocks(masked);

	const matches: InlineMatch[] = [];
	for (const itBlock of its) {
		if (matches.length >= MAX_MATCHES) break;
		const match = evaluateBlock(content, masked, itBlock, describes, beforeEaches, importMap, sutBase);
		if (match !== null) matches.push(match);
	}
	return matches;
}
