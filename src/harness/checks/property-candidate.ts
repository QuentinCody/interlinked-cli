// interlinked-tdd: exempt
// Property-test candidates: pure ALGORITHMIC functions with no property test.
//
// Part of the verification-density program, Track A lane 2
// (docs/design/verification-density-program.md).
//
// Complements `property-testing.ts`, which finds inverse PAIRS whose round-trip
// law is untested. This finds the other half of the gap: a single exported
// function that is pure and branch-heavy — the shape where example-based tests
// reliably miss edge cases and a property test pays for itself — living in a
// module whose tests use no property testing at all.
//
// Precision-first, following the `introverted_test` model: every condition
// below narrows, and anything untraceable stays silent. The threshold is
// calibrated against the real corpus rather than against fixtures — the first
// draft of `halstead_difficulty` fired on 2226 real functions because it was
// tuned on toy inputs, and this check is built to avoid repeating that.
//
// VERIFY-ONLY. The detector reads the module's companion test files, so it is
// NOT a pure function of (content, filePath) — the registry's PostToolUse
// contract requires purity, and `determinism-conformance.integration.test.ts`
// enforces it by running the inline pipeline twice and comparing bit-for-bit.
// Registering it inline made that conformance test flap (green alone, red in
// the full suite, where other tests were creating and removing files
// concurrently). Same standing as `gitignored_written_config` and
// `readme_script_drift`: filesystem-dependent detectors run in `verify`, never
// on the hook path. Keeping it off the hook path is also correct on latency
// grounds — an extra file read per edited file buys nothing per-keystroke.
//
// Deterministic given a fixed tree: TS AST + a bounded read of the module's own
// test files. No execution, no model.

import { readFileSync } from "node:fs";
import type * as TS from "typescript";
import {
	functionName,
	isImplementationFunction,
	parseTsSource,
	type TsModule,
} from "./cyclomatic-ast.js";
import { getExtension, type InlineMatch, isTestFile, JS_TS_EXTS } from "./shared.js";

/**
 * Minimum branch count before a function is worth a property test.
 *
 * Below this the example-based tests almost certainly cover the whole input
 * space, and a property test adds ceremony rather than coverage. Calibrated
 * from the repo corpus: this sits near the 90th percentile of cyclomatic
 * complexity, keeping the check to genuinely algorithmic code.
 */
export const PROPERTY_CANDIDATE_MIN_CYCLOMATIC = 8;

/** Markers that a test file already does property testing. */
const PROPERTY_TEST_MARKERS = [
	"fast-check",
	"fc.assert",
	"fc.property",
	"jsverify",
	"@fast-check",
	"testProp",
];

/**
 * Call/expression names that make a function IMPURE for this check's purposes.
 * Presence of any one silences the candidate: property testing a function with
 * side effects needs a harness this check cannot reason about.
 */
const IMPURITY_MARKERS = [
	"readFileSync",
	"writeFileSync",
	"readFile",
	"writeFile",
	"existsSync",
	"execSync",
	"spawn",
	"fetch",
	"console.",
	"process.",
	"Date.now",
	"Math.random",
	"require(",
	"import(",
	"await ",
	"globalThis",
];

/** True when the source text shows the module's tests already use properties. */
export function usesPropertyTesting(testSource: string): boolean {
	return PROPERTY_TEST_MARKERS.some((m) => testSource.includes(m));
}

/** True when a function body shows any impurity marker. */
export function looksImpure(bodyText: string): boolean {
	return IMPURITY_MARKERS.some((m) => bodyText.includes(m));
}

/** Cyclomatic complexity, counted the same way the gates count it. */
function cyclomaticOf(ts: TsModule, node: TS.Node): number {
	let count = 1;
	const walk = (n: TS.Node): void => {
		switch (n.kind) {
			case ts.SyntaxKind.IfStatement:
			case ts.SyntaxKind.ConditionalExpression:
			case ts.SyntaxKind.CaseClause:
			case ts.SyntaxKind.ForStatement:
			case ts.SyntaxKind.ForInStatement:
			case ts.SyntaxKind.ForOfStatement:
			case ts.SyntaxKind.WhileStatement:
			case ts.SyntaxKind.DoStatement:
			case ts.SyntaxKind.CatchClause:
				count++;
				break;
			default:
				break;
		}
		ts.forEachChild(n, walk);
	};
	walk(node);
	return count;
}

/**
 * TS's own `.d.ts` types `Node.parent` as a non-optional `Node`, but that is a
 * lie for the SourceFile root — it never gets a `.parent` assigned, so
 * dereferencing `.parent` ON a SourceFile crashes at runtime despite the
 * type's promise. Rather than compare a "non-optional" value to `undefined`
 * (which the type checker would call unreachable, defeating the point), this
 * walks up structurally: `ts.isSourceFile` is a real, narrowing type guard,
 * so bailing on it BEFORE the next `.parent` read never touches the lie.
 */
function nthParent(ts: TsModule, node: TS.Node, depth: number): TS.Node | undefined {
	let current: TS.Node = node;
	for (let i = 0; i < depth; i++) {
		if (ts.isSourceFile(current)) return undefined;
		current = current.parent;
	}
	return current;
}

/** Whether a node carries an `export` modifier. */
function isExported(ts: TsModule, node: TS.Node): boolean {
	const mods = (node as { modifiers?: readonly TS.ModifierLike[] }).modifiers;
	if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
	// `export const foo = () => {}` puts the modifier on the statement.
	const parent = nthParent(ts, node, 3);
	const parentMods = (parent as { modifiers?: readonly TS.ModifierLike[] } | undefined)?.modifiers;
	return parentMods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** Parameter count, ignoring `this` parameters. */
function parameterCount(_ts: TsModule, node: TS.Node): number {
	const params = (node as { parameters?: readonly TS.ParameterDeclaration[] }).parameters;
	if (!params) return 0;
	return params.filter((p) => p.name.getText() !== "this").length;
}

/** One function that would benefit from a property test. */
export interface PropertyCandidate {
	name: string;
	line: number;
	cyclomatic: number;
	params: number;
}

/** Find pure, algorithmic, multi-argument exported functions in one source. */
export function findPropertyCandidates(content: string, filePath: string): PropertyCandidate[] {
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return [];
	const { ts, sf } = parsed;
	const out: PropertyCandidate[] = [];

	const walk = (node: TS.Node): void => {
		if (isImplementationFunction(ts, node) && isExported(ts, node)) {
			const params = parameterCount(ts, node);
			const cyclomatic = cyclomaticOf(ts, node);
			if (params >= 2 && cyclomatic >= PROPERTY_CANDIDATE_MIN_CYCLOMATIC && !looksImpure(node.getText(sf))) {
				out.push({
					name: functionName(ts, node, sf),
					line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
					cyclomatic,
					params,
				});
			}
		}
		ts.forEachChild(node, walk);
	};
	walk(sf);
	return out;
}

/** Companion test paths for a module, in the conventions this repo uses. */
export function companionTestPaths(filePath: string): string[] {
	const ext = getExtension(filePath);
	const base = filePath.slice(0, filePath.length - ext.length);
	return [`${base}.test${ext}`, `${base}.spec${ext}`, `${base}.integration.test${ext}`];
}

/** Read whichever companion tests exist, concatenated; empty when none do. */
function readCompanionTests(filePath: string): string {
	let combined = "";
	for (const candidate of companionTestPaths(filePath)) {
		try {
			combined += readFileSync(candidate, "utf8");
		} catch {
			// No such companion; the other conventions may still match.
			combined += "";
		}
	}
	return combined;
}

/**
 * Detector: pure algorithmic exported functions in a module whose own tests use
 * no property testing.
 *
 * Silent when the module has no companion test at all — that is
 * `no_test_file`'s finding, and reporting it here would double-count.
 */
export function propertyCandidateCheck(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath)) || isTestFile(filePath)) return [];

	const candidates = findPropertyCandidates(content, filePath);
	if (candidates.length === 0) return [];

	const tests = readCompanionTests(filePath);
	if (!tests) return [];
	if (usesPropertyTesting(tests)) return [];

	return candidates.map((c) => ({
		line: c.line,
		text: `${c.name} — pure, ${c.params} args, ${c.cyclomatic} branches, and no property test in this module`,
	}));
}
