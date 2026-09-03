// interlinked-tdd: exempt
// ===========================================
// Interlinked Harness — Behavioral Checks (assertion density)
// ===========================================
// Delta-based assertion-density detection split out of
// `behavioral-checks-tdd.ts` to keep each module under the per-file line
// cap; the public API is re-exported from `behavioral-checks-tdd.ts` (and
// onward from `behavioral-checks.ts`) so all importers are unchanged.

import { nonNull } from "../lib/non-null.js";
import { stripCommentsAndStrings } from "./checks/shared.js";
import { hasTddExemptDirective } from "./evaluator/tdd-new-file-gate.js";
import type { AssertionCounts, CheckResultEntry, SessionTrajectory } from "./types.js";

const TEST_FILE_RE = /\.(test|spec)\.|__tests__\/|\/tests\//;

// ---- Assertion density (delta-based; called outside runBehavioralChecks) ----

// Matches plain `it(`, `test(`, `specify(` AND the chained variants vitest /
// jest expose: `.each`, `.only`, `.skip`, `.concurrent`, `.skipIf`, `.runIf`,
// `.todo`, `.failing`, `.sequential`. Also accepts the table-form
// `it.each([...])\`...\`(` so each tagged-template case counts as one block.
// Matching is on the call-site, not the chain — `.each` followed by `(...)`
// is one block; without that we'd miss every data-driven test in the repo.
const TEST_BLOCK_RE =
	/\b(?:it|test|specify)(?:\.(?:each|only|skip|concurrent|skipIf|runIf|todo|failing|sequential))*\s*(?:\([^)]*\)\s*)?(?:\(\s*['"`]|`+\s*\()/g;

// Default regex stays narrow on purpose — bare `ok(`, `match(`, `equal(`,
// `fail(` would false-positive on jQuery's `.match()`, lodash's `_.equal`,
// business-logic helpers, etc. Named-import awareness (below) handles
// `node:assert` cases properly without false-positives.
const ASSERTION_RE =
	/\b(?:expect|assert|chai\.assert|should|sinon\.assert|toMatchSnapshot|toMatchInlineSnapshot)\s*[(.]/g;

// Names that are unambiguous as Node:assert calls only when imported from
// `node:assert` / `assert`. Detected from the import statement, then matched
// in the body. Drops the bare-name FP risk.
const NODE_ASSERT_NAMES = [
	"strictEqual",
	"deepStrictEqual",
	"notStrictEqual",
	"notDeepStrictEqual",
	"deepEqual",
	"notEqual",
	"ifError",
	"doesNotThrow",
	"doesNotMatch",
	"throws",
	"rejects",
	"fail",
	"match",
	"ok",
	"equal",
] as const;

const NODE_ASSERT_IMPORT_RE =
	/import\s*(?:type\s+)?\{([^}]+)\}\s*from\s*['"](?:node:)?assert(?:\/strict)?['"]/g;

function importedAssertNames(content: string): Set<string> {
	const out = new Set<string>();
	NODE_ASSERT_IMPORT_RE.lastIndex = 0;
	let m: RegExpExecArray | null = NODE_ASSERT_IMPORT_RE.exec(content);
	while (m !== null) {
		for (const raw of nonNull(m[1]).split(",")) {
			// Handle `strictEqual as eq` rename — credit the local binding.
			const local = (raw.split(/\s+as\s+/i)[1] ?? raw).trim();
			if (
				local &&
				NODE_ASSERT_NAMES.includes(local as (typeof NODE_ASSERT_NAMES)[number])
			) {
				out.add(local);
			} else if (local) {
				const src = raw.split(/\s+as\s+/i)[0]?.trim();
				if (
					src &&
					NODE_ASSERT_NAMES.includes(src as (typeof NODE_ASSERT_NAMES)[number])
				) {
					out.add(local);
				}
			}
		}
		m = NODE_ASSERT_IMPORT_RE.exec(content);
	}
	return out;
}

// Per-file empty-block count, keyed off the exact `AssertionCounts` object
// `countAssertions` hands back for that snapshot. Kept OUT of the
// `AssertionCounts` type/serialization surface on purpose — that shape is
// shared with `session-state.ts` snapshot round-tripping and other call
// sites (`behavioral-diff-checks-oracle.ts`) that assert its exact fields,
// so widening it would ripple into files this check does not own. A
// WeakMap keyed by the returned object self-cleans: once
// `checkAssertionDensity` overwrites `session.assertion_counts.get(file)`
// with a newer snapshot, the old object (and its WeakMap entry) becomes
// unreachable and is collected — no unbounded growth on a long-running
// daemon. A cache miss (object never seen, e.g. a `before` restored from a
// pre-this-fix session snapshot) reads as "0 empty blocks", the safe
// default for the delta comparison below.
const emptyBlocksByCounts = new WeakMap<AssertionCounts, number>();

/** Index positions (into `stripped`) of every test-block header match. */
function testBlockStarts(stripped: string): Array<{ start: number; end: number }> {
	TEST_BLOCK_RE.lastIndex = 0;
	return [...stripped.matchAll(TEST_BLOCK_RE)].map((m) => ({
		start: m.index,
		end: m.index + m[0].length,
	}));
}

/** Index positions of every assertion-call match (built-in + named-import). */
function assertionStarts(stripped: string, rawContent: string): number[] {
	ASSERTION_RE.lastIndex = 0;
	const indices = [...stripped.matchAll(ASSERTION_RE)].map((m) => m.index);

	// Named-import credit — only for names actually imported from node:assert.
	// Use the *raw* content for import detection (strip can mangle import
	// specifier strings); use the *stripped* content for call-site matching.
	const named = importedAssertNames(rawContent);
	if (named.size > 0) {
		const namedRe = new RegExp(`\\b(?:${[...named].join("|")})\\s*\\(`, "g");
		indices.push(...[...stripped.matchAll(namedRe)].map((m) => m.index));
	}
	return indices;
}

/**
 * Count test blocks whose body (from its header to the next block header,
 * or EOF) contains no assertion call. This is the structural signal that
 * lets `checkAssertionDensity` tell "blocks were split and their
 * assertions moved with them" (every new block still has ≥1 assertion)
 * apart from "a genuinely new block was added with none" (it doesn't) —
 * something the pre-fix file-level `blocks`/`assertions` totals alone
 * cannot distinguish, since a pure split conserves the total.
 */
function countEmptyBlocks(stripped: string, rawContent: string): number {
	const blocks = testBlockStarts(stripped);
	const assertions = assertionStarts(stripped, rawContent);
	let empty = 0;
	for (let i = 0; i < blocks.length; i++) {
		const segEnd = i + 1 < blocks.length ? nonNull(blocks[i + 1]).start : stripped.length;
		const segStart = nonNull(blocks[i]).end;
		const hasAssertion = assertions.some((idx) => idx >= segStart && idx < segEnd);
		if (!hasAssertion) empty++;
	}
	return empty;
}

export function countAssertions(rawContent: string): AssertionCounts {
	// Strip comments + strings so a comment that mentions `expect(` or a
	// string containing `assert.ok(` doesn't inflate counts.
	const stripped = stripCommentsAndStrings(rawContent);

	const blocks = testBlockStarts(stripped).length;
	const assertions = assertionStarts(stripped, rawContent).length;

	const result: AssertionCounts = { blocks, assertions };
	emptyBlocksByCounts.set(result, countEmptyBlocks(stripped, rawContent));
	return result;
}

/**
 * True when a zero net assertion delta is fully explained by assertions
 * moving between blocks rather than any block ending up genuinely empty —
 * e.g. one `it()` split into several `it()`s that each keep a share of the
 * original `expect()` calls. Compares the *count of assertion-free blocks*
 * before vs after (via `emptyBlocksByCounts`, keyed off the exact
 * `AssertionCounts` objects involved): a pure split conserves that count
 * (every new block still has ≥1 assertion), while a genuinely new
 * assertion-free block raises it. A cache miss on either side (object
 * never passed through `countAssertions`, e.g. a `before` restored from an
 * older session snapshot) reads as 0 — the same "assume nothing moved,
 * still allow a real positive to fire" default the rest of this check
 * uses for missing history.
 */
function assertionsWereRedistributed(before: AssertionCounts, after: AssertionCounts): boolean {
	const beforeEmpty = emptyBlocksByCounts.get(before) ?? 0;
	const afterEmpty = emptyBlocksByCounts.get(after) ?? 0;
	return afterEmpty - beforeEmpty <= 0;
}

/**
 * Detect test files where the agent added `it()`/`test()` blocks without
 * adding any assertions. Heuristic, warning-severity, session-delta-based:
 * the first sight of any test file silently establishes baseline; the check
 * fires on the *second* same-session edit when blocks grew but assertions
 * did not — unless every added block still carries an assertion, meaning
 * the zero delta is a split/redistribution rather than an empty block (see
 * `assertionsWereRedistributed`).
 *
 * Brand-new assertion-free test files are an accepted blind spot — see
 * `docs/plans/09-local-runtime-quality-hooks.md` (Failure modes table).
 * `tdd_new_file_gate` does NOT cover this case (it exempts test files at
 * `evaluator/tdd-new-file-gate.ts:35-48`); Plan 10 (mutation testing)
 * catches it asynchronously.
 */
export function checkAssertionDensity(
	session: SessionTrajectory,
	filePath: string,
	content: string,
): CheckResultEntry | null {
	if (!TEST_FILE_RE.test(filePath)) return null;
	if (hasTddExemptDirective(content)) return null;

	const after = countAssertions(content);
	const before = session.assertion_counts.get(filePath);

	// Always refresh the cache — every visit becomes the new baseline for
	// the *next* edit's delta.
	session.assertion_counts.set(filePath, after);

	// First time we see this file in the session: silently establish
	// baseline. Firing on `before === undefined` would false-positive on
	// every pre-existing assertion-free test the agent touches.
	if (before === undefined) return null;

	const dBlocks = after.blocks - before.blocks;
	const dAssertions = after.assertions - before.assertions;

	if (dBlocks <= 0 || dAssertions > 0) return null;
	if (dAssertions === 0 && assertionsWereRedistributed(before, after)) return null;

	const assertionPart =
		dAssertions === 0
			? "0 new assertions"
			: `${-dAssertions} fewer assertion${-dAssertions === 1 ? "" : "s"}`;
	return {
		source: "structural",
		name: "assertion_density",
		severity: "warning",
		message: `Added ${dBlocks} test block(s) with ${assertionPart}. Each it()/test() block typically needs at least one expect()/assert*() call.`,
		file: filePath,
		determinism: "heuristic",
	};
}
