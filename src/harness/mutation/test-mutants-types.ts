// ===========================================
// Test-side mutants — shared types, kinds, ids
// ===========================================
// A SOURCE mutant that survives says a test is blind to that change. A TEST
// mutant (a small edit to the test file itself) that leaves the kill matrix
// unchanged says the edited assertion did no work. Steps 5b/5c of
// scratch/CAMPAIGN-mutation-rl.md re-run each test mutant against the source
// mutants its test previously killed; this module only ENUMERATES and APPLIES
// the test mutants — it never runs anything.

import { createHash } from "node:crypto";

export const TEST_MUTANT_KINDS = [
	"assertion_negate",
	"assertion_delete",
	"matcher_loosen",
	"expected_perturb",
	"expect_assertions_remove",
	"timeout_widen",
	"await_drop",
	"mock_to_real",
] as const;

export type TestMutantKind = (typeof TEST_MUTANT_KINDS)[number];

const KIND_DESCRIPTIONS: Record<TestMutantKind, string> = {
	assertion_negate: "toggle .not on an expect(...) matcher chain",
	assertion_delete: "delete one whole expect(...) statement from a test that has at least two",
	matcher_loosen: "replace a specific matcher with a weaker one (toBe/toEqual -> toBeDefined, ...)",
	expected_perturb: "change a literal inside the expected argument (n+1, string+x, boolean flip)",
	expect_assertions_remove: "drop expect.assertions(n) / expect.hasAssertions()",
	timeout_widen: "multiply a literal test timeout by 10",
	await_drop: "remove the await before expect(p).rejects/resolves",
	mock_to_real: "remove a vi.mock(<relative module>) statement so the real module loads",
};

/** One-line human description of a mutant kind. */
export function describeKind(kind: TestMutantKind): string {
	return KIND_DESCRIPTIONS[kind];
}

export interface TestMutant {
	/** Stable sha (16 hex) of file + kind + start + replacement. */
	id: string;
	kind: TestMutantKind;
	/** Title of the enclosing it()/test(); "" for file-level sites (vi.mock, setConfig). */
	testName: string;
	/** Offsets into the ORIGINAL content: replace [start, end) with `replacement`. */
	start: number;
	end: number;
	original: string;
	replacement: string;
	/** 1-based line of `start`. */
	line: number;
	/** Kind-specific note (mock_to_real: the module specifier). */
	detail?: string;
}

/** What an operator proposes, before id / line / original are attached. */
export interface RawTestMutant {
	kind: TestMutantKind;
	start: number;
	end: number;
	replacement: string;
	/** Overrides the walker's enclosing-test title (a test call's own timeout). */
	testName?: string;
	detail?: string;
}

/** Walker state: the innermost enclosing it()/test(), if any. */
export interface TestContext {
	testName: string | null;
	/** expect(...) statements in that test's body (not counting nested tests). */
	expectStatementCount: number;
}

export interface TestMutantEnumeration {
	mutants: TestMutant[];
	/** Non-null when enumeration could not run (typescript absent). */
	unavailableReason: string | null;
}

/** applyTestMutant found the text at [start,end) is not the mutant's original. */
export class TestMutantDriftError extends Error {
	readonly mutantId: string;
	readonly expected: string;
	readonly actual: string;
	constructor(mutantId: string, expected: string, actual: string) {
		super(`test mutant ${mutantId} drifted: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
		this.name = "TestMutantDriftError";
		this.mutantId = mutantId;
		this.expected = expected;
		this.actual = actual;
	}
}

export function testMutantId(filePath: string, kind: TestMutantKind, start: number, replacement: string): string {
	return createHash("sha256").update([filePath, kind, String(start), replacement].join("\0")).digest("hex").slice(0, 16);
}
