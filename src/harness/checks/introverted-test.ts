// Introverted-test detection — test-quality family.
//
// An *introverted* test never traces its assertions back to the system under
// test (SUT): every `expect()` / `assert()` subject is a literal, a test-local
// value, a known global, or a MOCKED symbol's return, and the test never calls
// the SUT — so it passes or fails independently of production behaviour (green
// theatre; a guaranteed mutation survivor). *Extroverted* = at least one
// assertion's value derives from a non-mocked SUT call/read.
//
// The dataflow layer beneath `mock_only_test` (matcher kind) and
// `test_missing_sut_import` (the import). Concept + provenance:
// `docs/external-pulse/deintroverter.md` (Uncle Bob's deintroverter4clj, ported
// from Clojure/Speclj). Determinism `partially_deterministic` (static AST
// trace) → `[heuristic]` tag.
//
// Precision-first (advisory v0): SUT = the COMPANION module only (no companion
// import → bail); mocked deps are tracked; if the SUT is exercised in the body
// (directly or via a file-local factory helper) we don't flag; anything
// untraceable is UNCERTAIN → silent. Recall is traded for precision.

import { createRequire } from "node:module";
import type * as TS from "typescript";
import { parseTsSourceWith } from "./cyclomatic-ast.js";
import { getExtension, type InlineMatch, isStrictTestFile, JS_TS_EXTS } from "./shared.js";

type TsModule = typeof TS;

// Self-contained `typescript` loader — same idiom as cyclomatic-ast.ts /
// exhaustiveness.ts / type-smuggling.ts (the dep is an optionalDependency; a
// `--omit=optional` install has no AST, so the check no-ops rather than throws).
// A fresh module instance (vitest `resetModules` + dynamic import) starts with
// an empty cache, so the dep-absent path is exercised without a reset hook.
let tsCache: TsModule | null | undefined;
function loadTs(): TsModule | null {
	if (tsCache !== undefined) return tsCache;
	try {
		tsCache = createRequire(import.meta.url)("typescript") as TsModule;
	} catch {
		tsCache = null;
	}
	return tsCache;
}

// Reach lattice: REACHED > UNCERTAIN > NONE. REACHED short-circuits.
const NONE = 0;
const UNCERTAIN = 1;
const REACHED = 2;
type Rank = typeof NONE | typeof UNCERTAIN | typeof REACHED;

const MAX_BINDING_DEPTH = 3;
const MAX_MATCHES = 10;

const TEST_FN_NAMES = new Set(["it", "test", "specify"]);
// Modifiers that mean "don't actually run this body" — skip the block entirely.
const SKIP_MODIFIERS = new Set(["skip", "todo", "failing", "skipIf", "runIf"]);

// Globals + assertion libs that are definitively NOT the SUT (NONE, not
// UNCERTAIN, so a literal-shaped `expect(Math.PI)` resolves). vi/jest/sinon are
// intentionally absent — a spy/mock reads as UNCERTAIN (mock-interaction is
// `mock_only_test`'s job). Args are still recursed, so `Object.keys(f())` works.
const KNOWN_NON_SUT = new Set([
	"Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "Date", "RegExp",
	"Map", "Set", "WeakMap", "WeakSet", "Symbol", "Promise", "BigInt", "Error",
	"parseInt", "parseFloat", "isNaN", "isFinite", "structuredClone", "console", "expect",
]);

// Relative specifiers that look like test / mock / fixture / asset, not SUT source.
const NON_SUT_SPEC_RE =
	/\.(test|spec)\.|(^|\/)__(mocks|fixtures)__\/|\.(json|css|scss|less|html|svg|png|jpe?g|gif|md)$/i;

/** A relative, in-project, non-test/mock/fixture/asset import — i.e. a SUT source. */
function isSutSpecifier(spec: string): boolean {
	if (!spec.startsWith("./") && !spec.startsWith("../")) return false; // bare / node: dep
	return !NON_SUT_SPEC_RE.test(spec);
}

/** Strip a trailing module extension so `vi.mock("./p")` matches `from "./p.js"`. */
function normalizeSpec(spec: string): string {
	return spec.replace(/\.(js|ts|tsx|jsx|mjs|cjs|mts|cts)$/, "");
}

/** Strip a module specifier to its basename (no dir, no extension). */
function importBasename(spec: string): string {
	const last = spec.split("/").pop() ?? "";
	return last.replace(/\.(js|ts|tsx|jsx|mjs|cjs|mts|cts)$/, "");
}

/** Companion SUT basename for a test path (`foo.test.ts` → `foo`); "" if none. */
function sutBaseFromPath(filePath: string): string {
	const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
	const base = fileName.replace(/\.(test|spec)\.(tsx?|jsx?|mjs|cjs|mts|cts)$/, "");
	return base === fileName ? "" : base;
}

interface SutSymbols {
	/** non-mocked named/default imports from the COMPANION module — reaching one reaches SUT */
	reachable: Set<string>;
	/** non-mocked `import * as ns` namespace names from the COMPANION — `ns.x` reaches SUT */
	namespaces: Set<string>;
	/** symbols whose source module is mocked — calling one runs the mock, not the SUT */
	mocked: Set<string>;
}

/** Gather every `vi.mock(...)` / `jest.mock(...)` module specifier in the file. */
function collectMockedModules(ts: TsModule, sf: TS.SourceFile): Set<string> {
	const mocked = new Set<string>();
	const visit = (node: TS.Node): void => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const obj = node.expression.expression;
			if (
				ts.isIdentifier(obj) &&
				(obj.text === "vi" || obj.text === "jest") &&
				node.expression.name.text === "mock"
			) {
				const arg = node.arguments[0];
				if (arg && ts.isStringLiteralLike(arg)) mocked.add(normalizeSpec(arg.text));
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return mocked;
}

interface ClassifiedImport {
	mocked: boolean;
	names: string[];
	nsNames: string[];
}

/**
 * Classify one statement as a companion-SUT or mocked import worth tracking, or
 * null to skip. Companion = a SUT-source specifier whose basename === `sutBase`;
 * mocked = its module was `vi.mock`'d (any module, including a dependency).
 */
function classifyCompanionImport(
	ts: TsModule,
	stmt: TS.Statement,
	sutBase: string,
	mockedModules: Set<string>,
): ClassifiedImport | null {
	if (!ts.isImportDeclaration(stmt) || !stmt.importClause) return null;
	const specNode = stmt.moduleSpecifier;
	const spec = ts.isStringLiteralLike(specNode) ? specNode.text : "";
	const mocked = mockedModules.has(normalizeSpec(spec));
	const isCompanion = isSutSpecifier(spec) && sutBase !== "" && importBasename(spec) === sutBase;
	if (!mocked && !isCompanion) return null;
	const clause = stmt.importClause;
	const names: string[] = [];
	const nsNames: string[] = [];
	if (clause.name) names.push(clause.name.text); // default import
	const nb = clause.namedBindings;
	if (nb && ts.isNamespaceImport(nb)) nsNames.push(nb.name.text);
	if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) names.push(el.name.text);
	return { mocked, names, nsNames };
}

/** Collect SUT symbols (companion reachable/namespaces + any-module mocked). */
function collectSutSymbols(ts: TsModule, sf: TS.SourceFile, sutBase: string): SutSymbols {
	const mockedModules = collectMockedModules(ts, sf);
	const reachable = new Set<string>();
	const namespaces = new Set<string>();
	const mocked = new Set<string>();
	for (const stmt of sf.statements) {
		const c = classifyCompanionImport(ts, stmt, sutBase, mockedModules);
		if (!c) continue;
		const valueSet = c.mocked ? mocked : reachable;
		const nsSet = c.mocked ? mocked : namespaces;
		for (const n of c.names) valueSet.add(n);
		for (const n of c.nsNames) nsSet.add(n);
	}
	return { reachable, namespaces, mocked };
}

/** True for primitive literal nodes that bottom out a trace at NONE. */
function isPrimitiveLiteral(ts: TsModule, node: TS.Node): boolean {
	return (
		ts.isStringLiteralLike(node) ||
		ts.isNumericLiteral(node) ||
		node.kind === ts.SyntaxKind.TrueKeyword ||
		node.kind === ts.SyntaxKind.FalseKeyword ||
		node.kind === ts.SyntaxKind.NullKeyword ||
		ts.isRegularExpressionLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node)
	);
}

interface TraceCtx {
	ts: TsModule;
	sut: SutSymbols;
	bindings: Map<string, TS.Expression>;
}

function combine(ranks: Rank[]): Rank {
	let r: Rank = NONE;
	for (const x of ranks) {
		if (x === REACHED) return REACHED;
		if (x === UNCERTAIN) r = UNCERTAIN;
	}
	return r;
}

/** Classify a called name (the callee identifier of a CallExpression). */
function rankCalleeIdent(name: string, ctx: TraceCtx): Rank {
	if (ctx.sut.reachable.has(name)) return REACHED;
	if (ctx.sut.mocked.has(name) || KNOWN_NON_SUT.has(name)) return NONE;
	// A local helper var, a spy, or an unknown free function — we don't inline
	// helpers here, so we can't prove it doesn't reach the SUT: uncertain.
	return UNCERTAIN;
}

/** Dynamic `import("./sut")` reaches the SUT module's surface, else null (not applicable). */
function rankDynamicImport(node: TS.CallExpression, ctx: TraceCtx): Rank | null {
	const { ts } = ctx;
	if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
	const spec = node.arguments[0];
	if (spec && ts.isStringLiteralLike(spec) && isSutSpecifier(spec.text)) return REACHED;
	return null;
}

/** Rank a CallExpression: dynamic-import special case, then callee + args. */
function rankCallExpressionValue(
	node: TS.CallExpression,
	ctx: TraceCtx,
	depth: number,
	seen: Set<string>,
): Rank {
	const { ts } = ctx;
	const dynamicImport = rankDynamicImport(node, ctx);
	if (dynamicImport === REACHED) return REACHED;
	const callee = node.expression;
	const calleeRank = ts.isIdentifier(callee)
		? rankCalleeIdent(callee.text, ctx)
		: rankValue(callee, ctx, depth, seen); // PropertyAccess etc. → value rule (handles ns)
	if (calleeRank === REACHED) return REACHED;
	const args = node.arguments.map((a) => rankValue(a, ctx, depth, seen));
	return combine([calleeRank, ...args]);
}

/** Rank a PropertyAccessExpression: `ns.foo` on a non-mocked namespace → REACHED, else recurse object. */
function rankPropertyAccessValue(
	node: TS.PropertyAccessExpression,
	ctx: TraceCtx,
	depth: number,
	seen: Set<string>,
): Rank {
	const { ts } = ctx;
	// `ns.foo` where `ns` is a non-mocked namespace import → reaches SUT.
	if (ts.isIdentifier(node.expression) && ctx.sut.namespaces.has(node.expression.text)) {
		return REACHED;
	}
	return rankValue(node.expression, ctx, depth, seen); // recurse object; ignore .name
}

/** Rank an Identifier: SUT export, mocked/known-non-SUT, a traceable local binding, or unresolved. */
function rankIdentifierValue(node: TS.Identifier, ctx: TraceCtx, depth: number, seen: Set<string>): Rank {
	const n = node.text;
	if (ctx.sut.reachable.has(n)) return REACHED; // reading a SUT export value
	if (ctx.sut.mocked.has(n) || KNOWN_NON_SUT.has(n)) return NONE;
	const bound = ctx.bindings.get(n);
	if (!bound) return UNCERTAIN; // param / module const / unresolved — cannot prove non-SUT
	if (depth >= MAX_BINDING_DEPTH || seen.has(n)) return UNCERTAIN;
	return rankValue(bound, ctx, depth + 1, new Set(seen).add(n));
}

/** await / paren / binary / conditional / element-access / array & object literals:
 *  recurse children — a SUT call nested anywhere makes it reachable. */
function rankChildrenValue(node: TS.Node, ctx: TraceCtx, depth: number, seen: Set<string>): Rank {
	const { ts } = ctx;
	const childRanks: Rank[] = [];
	ts.forEachChild(node, (c) => {
		childRanks.push(rankValue(c, ctx, depth, seen));
	});
	return combine(childRanks);
}

/** Does this expression's value provably reach a non-mocked SUT symbol? */
function rankValue(node: TS.Node, ctx: TraceCtx, depth: number, seen: Set<string>): Rank {
	const { ts } = ctx;

	if (isPrimitiveLiteral(ts, node)) return NONE;
	if (ts.isCallExpression(node)) return rankCallExpressionValue(node, ctx, depth, seen);
	if (ts.isPropertyAccessExpression(node)) return rankPropertyAccessValue(node, ctx, depth, seen);
	if (ts.isIdentifier(node)) return rankIdentifierValue(node, ctx, depth, seen);
	return rankChildrenValue(node, ctx, depth, seen);
}

/** Build the local `name -> initializer` map for a test body (incl. destructuring). */
function collectBindings(ts: TsModule, body: TS.Node): Map<string, TS.Expression> {
	const bindings = new Map<string, TS.Expression>();
	const visit = (node: TS.Node): void => {
		if (ts.isVariableDeclaration(node) && node.initializer) {
			const init = node.initializer;
			if (ts.isIdentifier(node.name)) {
				bindings.set(node.name.text, init);
			} else if (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) {
				// `const { a } = sut.f()` / `const [x] = sut.f()` — each bound name
				// inherits the RHS provenance (matches deintroverter's destructure rule).
				for (const el of node.name.elements) {
					if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) bindings.set(el.name.text, init);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(body);
	return bindings;
}

/** Collect the asserted-value subjects from `expect(X)` / `assert(...)` in a body. */
function collectAssertionSubjects(ts: TsModule, body: TS.Node): TS.Expression[] {
	const subjects: TS.Expression[] = [];
	const visit = (node: TS.Node): void => {
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			if (ts.isIdentifier(callee) && callee.text === "expect" && node.arguments[0]) {
				subjects.push(node.arguments[0]);
			} else if (ts.isIdentifier(callee) && callee.text === "assert" && node.arguments.length > 0) {
				subjects.push(...node.arguments);
			} else if (
				ts.isPropertyAccessExpression(callee) &&
				ts.isIdentifier(callee.expression) &&
				callee.expression.text === "assert" &&
				node.arguments.length > 0
			) {
				subjects.push(...node.arguments); // assert.equal(a, b) / assert.deepEqual(...)
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(body);
	return subjects;
}

/** True when the test body references the companion SUT anywhere (call/value/ns). */
function bodyReferencesCompanion(ts: TsModule, body: TS.Node, sut: SutSymbols): boolean {
	let found = false;
	const visit = (node: TS.Node): void => {
		if (found) return;
		if (ts.isIdentifier(node) && sut.reachable.has(node.text)) {
			found = true;
			return;
		}
		if (
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			sut.namespaces.has(node.expression.text)
		) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(body);
	return found;
}

/** A file-level helper (function decl or arrow/function const) whose body
 *  references the companion SUT — calling it counts as exercising the SUT. */
function declaredHelperName(ts: TsModule, stmt: TS.Statement, sut: SutSymbols): string | null {
	if (
		ts.isFunctionDeclaration(stmt) &&
		stmt.name &&
		stmt.body &&
		bodyReferencesCompanion(ts, stmt.body, sut)
	) {
		return stmt.name.text;
	}
	if (ts.isVariableStatement(stmt)) {
		for (const decl of stmt.declarationList.declarations) {
			const init = decl.initializer;
			if (
				ts.isIdentifier(decl.name) &&
				init &&
				(ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
				bodyReferencesCompanion(ts, init.body, sut)
			) {
				return decl.name.text;
			}
		}
	}
	return null;
}

/** Names of file-level helpers that transitively reach the companion SUT (1 level). */
function collectCompanionHelpers(ts: TsModule, sf: TS.SourceFile, sut: SutSymbols): Set<string> {
	const helpers = new Set<string>();
	for (const stmt of sf.statements) {
		const name = declaredHelperName(ts, stmt, sut);
		if (name) helpers.add(name);
	}
	return helpers;
}

/** True when the body calls one of the named (companion-reaching) helpers. */
function bodyCallsHelper(ts: TsModule, body: TS.Node, helpers: Set<string>): boolean {
	let found = false;
	const visit = (node: TS.Node): void => {
		if (found) return;
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helpers.has(node.expression.text)) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(body);
	return found;
}

interface TestBlock {
	name: string;
	line: number;
	body: TS.Node;
}

/** Unwrap the base callee of an it()/test() call, tracking skip modifiers. */
function testCallInfo(ts: TsModule, call: TS.CallExpression): { skipped: boolean } | null {
	let expr: TS.Expression = call.expression;
	let skipped = false;
	// `it.each(table)('n', fn)` — callee is itself a call; descend to it.each.
	while (ts.isCallExpression(expr)) expr = expr.expression;
	while (ts.isPropertyAccessExpression(expr)) {
		if (SKIP_MODIFIERS.has(expr.name.text)) skipped = true;
		expr = expr.expression;
	}
	if (ts.isIdentifier(expr) && TEST_FN_NAMES.has(expr.text)) return { skipped };
	return null;
}

/** Find every (non-skipped) string-named it()/test()/specify() block with a body. */
function findTestBlocks(ts: TsModule, sf: TS.SourceFile): TestBlock[] {
	const blocks: TestBlock[] = [];
	const visit = (node: TS.Node): void => {
		if (ts.isCallExpression(node)) {
			const info = testCallInfo(ts, node);
			if (info && !info.skipped) {
				const fnArg = node.arguments.find(
					(a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
				);
				const nameArg = node.arguments[0];
				if (fnArg?.body && nameArg && ts.isStringLiteralLike(nameArg)) {
					blocks.push({
						name: nameArg.text,
						line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
						body: fnArg.body,
					});
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return blocks;
}

/**
 * Flag test blocks whose every assertion is decoupled from the SUT (introverted).
 * Returns [] when the file is not a strict JS/TS test file, has no companion SUT
 * import, or the optional `typescript` dep is absent.
 */
export function checkIntrovertedTest(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const ts = loadTs();
	if (!ts) return [];

	const sf = parseTsSourceWith(ts, content, filePath);

	const sut = collectSutSymbols(ts, sf, sutBaseFromPath(filePath));
	// No non-mocked companion SUT symbol → no companion import (meta-test /
	// utility-only / differently-named SUT) or a fully self-mocked companion
	// (defer to mocking_the_sut_self). Either way bail, keeping FPs at zero.
	if (sut.reachable.size === 0 && sut.namespaces.size === 0) return [];

	const helpers = collectCompanionHelpers(ts, sf, sut);
	const matches: InlineMatch[] = [];
	for (const block of findTestBlocks(ts, sf)) {
		if (matches.length >= MAX_MATCHES) break;
		const subjects = collectAssertionSubjects(ts, block.body);
		if (subjects.length === 0) continue; // assertion-free is a different check

		const ctx: TraceCtx = { ts, sut, bindings: collectBindings(ts, block.body) };
		const ranks = subjects.map((s) => rankValue(s, ctx, 0, new Set()));
		// REACHED (grounds in the SUT) and UNCERTAIN (can't prove) both stay
		// silent; only the all-NONE pole is a candidate.
		if (combine(ranks) !== NONE) continue;
		// If the SUT is exercised in the body — directly or via a file-local
		// factory helper — the assertion likely checks its effect. Don't flag.
		if (bodyReferencesCompanion(ts, block.body, sut) || bodyCallsHelper(ts, block.body, helpers)) {
			continue;
		}
		matches.push({
			line: block.line,
			text: `introverted test "${block.name.slice(0, 80)}": no assertion traces to the system under test — every assertion checks a literal, a test-local value, or a mocked result, and the test never calls the code under test, so it stays green even if that code is broken. Assert on a value returned by (or state changed by) a real SUT call.`,
		});
	}
	return matches;
}
