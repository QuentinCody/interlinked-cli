// ===========================================
// Test-side mutants — enumerate and apply
// ===========================================
// `enumerateTestMutants` walks a test file with the TypeScript compiler API and
// returns every mutant the eight operators (test-mutants-operators.ts) find.
// `applyTestMutant` produces the mutated text for ONE mutant. Neither runs a
// test: step 5b/5c of scratch/CAMPAIGN-mutation-rl.md owns execution.
//
// `typescript` is an optionalDependency; when it cannot load, enumeration
// returns no mutants and says why (`enumerateTestMutantsDetailed`).

import type * as TS from "typescript";
import { loadTsModule, type TsModule } from "./differential-fuzz-deps.js";
import { countExpectStatements, isTestCall, testTitle } from "./test-mutants-chain.js";
import { collectRawMutants } from "./test-mutants-operators.js";
import {
	type RawTestMutant,
	type TestContext,
	type TestMutant,
	TestMutantDriftError,
	type TestMutantEnumeration,
	testMutantId,
} from "./test-mutants-types.js";

export {
	describeKind,
	TEST_MUTANT_KINDS,
	type TestMutant,
	TestMutantDriftError,
	type TestMutantEnumeration,
	type TestMutantKind,
} from "./test-mutants-types.js";

const TS_ABSENT_REASON = "typescript is not installed (optionalDependency); test mutants cannot be enumerated";

function toMutant(filePath: string, content: string, sf: TS.SourceFile, raw: RawTestMutant, ctx: TestContext): TestMutant {
	const mutant: TestMutant = {
		id: testMutantId(filePath, raw.kind, raw.start, raw.replacement),
		kind: raw.kind,
		testName: raw.testName ?? ctx.testName ?? "",
		start: raw.start,
		end: raw.end,
		original: content.slice(raw.start, raw.end),
		replacement: raw.replacement,
		line: sf.getLineAndCharacterOfPosition(raw.start).line + 1,
	};
	return raw.detail === undefined ? mutant : { ...mutant, detail: raw.detail };
}

function walkFile(ts: TsModule, filePath: string, content: string): TestMutant[] {
	const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, /* setParentNodes */ true);
	const seen = new Map<string, TestMutant>();
	const visit = (node: TS.Node, ctx: TestContext): void => {
		for (const raw of collectRawMutants(ts, sf, node, ctx)) {
			const mutant = toMutant(filePath, content, sf, raw, ctx);
			if (!seen.has(mutant.id)) seen.set(mutant.id, mutant);
		}
		const inner: TestContext =
			ts.isCallExpression(node) && isTestCall(ts, node)
				? { testName: testTitle(ts, node), expectStatementCount: countExpectStatements(ts, node) }
				: ctx;
		ts.forEachChild(node, (child) => visit(child, inner));
	};
	visit(sf, { testName: null, expectStatementCount: 0 });
	return [...seen.values()].sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
}

/** Like `enumerateTestMutants`, but reports why nothing was enumerated.
 *  `tsModule` is injectable so the typescript-absent path is testable. */
export function enumerateTestMutantsDetailed(
	filePath: string,
	content: string,
	tsModule: TsModule | null = loadTsModule(),
): TestMutantEnumeration {
	if (tsModule === null) return { mutants: [], unavailableReason: TS_ABSENT_REASON };
	return { mutants: walkFile(tsModule, filePath, content), unavailableReason: null };
}

/** Every test-side mutant of one test file, in source order. [] when typescript is absent. */
export function enumerateTestMutants(filePath: string, content: string): TestMutant[] {
	return enumerateTestMutantsDetailed(filePath, content).mutants;
}

/** The mutated file text. Throws TestMutantDriftError when [start, end) no longer holds the original. */
export function applyTestMutant(content: string, mutant: TestMutant): string {
	const actual = content.slice(mutant.start, mutant.end);
	if (mutant.end > content.length || actual !== mutant.original) {
		throw new TestMutantDriftError(mutant.id, mutant.original, actual);
	}
	return content.slice(0, mutant.start) + mutant.replacement + content.slice(mutant.end);
}
