// Test doubles — deterministic "stands_in_for" extraction (AST only).
//
// Step 8a of scratch/CAMPAIGN-mutation-rl.md. A test that replaces a real module
// with a canned-answer stand-in cannot notice when the real module drifts. Step 8b
// swaps the stand-in for the real module and records which tests notice; this file
// finds the swap sites. It reads one test file's text with the TypeScript parser
// (no type check, no module graph, no model, no network) and reports every double.
// Kinds: module_mock and module_mock_factory (the vi.mock, vi.doMock and jest.mock
// calls); spy (vi.spyOn, target is object.method); fn (vi.fn bound to a named
// variable); global_stub (vi.stubGlobal); env_stub (vi.stubEnv).
//
// Known gaps (a gap is a miss, never a wrong edge): a non-literal module
// specifier, `vi.mock` through an alias of `vi` (`const { vi: v } = …`),
// `__mocks__/` directory auto-mocks (no call in the test file names them),
// `vi.hoisted`, and doubles created inside helper files the test imports.
// `typescript` is an optionalDependency: when it is absent every function here
// returns an empty array — `testDoublesAvailable()` tells the caller apart.

import { posix } from "node:path";
import type * as TS from "typescript";
import { loadTsModule } from "./differential-fuzz-deps.js";
import {
	IMPLEMENTATION_METHODS,
	isCannedExpression,
	isCannedFunctionBody,
	MOCK_NAMESPACES,
} from "./test-doubles-canned.js";

type Ts = typeof TS;

export type TestDoubleKind = "module_mock" | "module_mock_factory" | "spy" | "fn" | "global_stub" | "env_stub";

export interface TestDouble {
	kind: TestDoubleKind;
	/** Module specifier exactly as written (module mocks only). */
	specifier?: string | undefined;
	/** Relative specifier resolved against the test file, repo-relative, extension as written. Bare packages stay undefined. */
	resolvedPath?: string | undefined;
	/** spy: `object.method`; fn: the const name; global_stub / env_stub: the global or variable name. */
	target?: string | undefined;
	/** 1-based line of the call. */
	line: number;
	/** A replacement is supplied: a mock factory, a chained `mock*` implementation, or a stub value. */
	hasFactory: boolean;
	/** HEURISTIC: the replacement only yields literals / `vi.fn()` chains (see test-doubles-canned.ts). False when none is supplied. */
	factoryReturnsCanned: boolean;
}

export interface ImportedModule {
	specifier: string;
	resolvedPath?: string | undefined;
	line: number;
	kind: "static" | "dynamic" | "reexport";
}

interface Ctx {
	ts: Ts;
	sf: TS.SourceFile;
	filePath: string;
}

export function testDoublesAvailable(): boolean {
	return loadTsModule() !== null;
}

/** `src/x/foo.js`, `src/x/foo.ts`, `src/x/foo/index.ts` → `src/x/foo`. Other extensions are kept. */
export function moduleKey(path: string): string {
	const stem = path.replace(/\\/g, "/").replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, "");
	return stem.endsWith("/index") ? stem.slice(0, -"/index".length) : stem;
}

function resolveSpecifier(filePath: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	return posix.normalize(posix.join(posix.dirname(filePath.replace(/\\/g, "/")), specifier));
}

function sameModule(filePath: string, left: string, right: string): boolean {
	if (left === right) return true;
	const a = resolveSpecifier(filePath, left);
	const b = resolveSpecifier(filePath, right);
	return a !== undefined && b !== undefined && moduleKey(a) === moduleKey(b);
}

function parse(ts: Ts, filePath: string, content: string): TS.SourceFile {
	const kind = /\.[jt]sx$/.test(filePath)
		? ts.ScriptKind.TSX
		: /\.[cm]?js$/.test(filePath)
			? ts.ScriptKind.JS
			: ts.ScriptKind.TS;
	return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, kind);
}

function lineOf(ctx: Ctx, node: TS.Node): number {
	return ctx.sf.getLineAndCharacterOfPosition(node.getStart(ctx.sf)).line + 1;
}

function isImportCall(ts: Ts, node: TS.Node): node is TS.CallExpression {
	return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/** `"./x"` or `import("./x")` (vitest accepts both as the first argument of vi.mock). */
function specifierText(ts: Ts, arg: TS.Node | undefined): string | undefined {
	if (arg === undefined) return undefined;
	if (ts.isStringLiteralLike(arg)) return arg.text;
	if (isImportCall(ts, arg)) return specifierText(ts, arg.arguments[0]);
	return undefined;
}

function literalText(ts: Ts, arg: TS.Node | undefined): string | undefined {
	return arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

/** Walks `.mockX(...)` links above a call; returns the outermost call and every replacement argument. */
function climbChain(ts: Ts, call: TS.CallExpression): { outer: TS.CallExpression; impls: TS.Expression[] } {
	let outer = call;
	const impls: TS.Expression[] = [];
	for (;;) {
		const access = outer.parent;
		if (!ts.isPropertyAccessExpression(access) || access.expression !== outer) break;
		const next = access.parent;
		if (!ts.isCallExpression(next) || next.expression !== access) break;
		if (IMPLEMENTATION_METHODS.has(access.name.text)) impls.push(...next.arguments);
		outer = next;
	}
	return { outer, impls };
}

function replacementFacts(ts: Ts, impls: readonly TS.Expression[]): { hasFactory: boolean; factoryReturnsCanned: boolean } {
	return {
		hasFactory: impls.length > 0,
		factoryReturnsCanned: impls.length > 0 && impls.every((impl) => isCannedExpression(ts, impl)),
	};
}

function moduleMock(ctx: Ctx, call: TS.CallExpression): TestDouble | null {
	const { ts } = ctx;
	const specifier = specifierText(ts, call.arguments[0]);
	if (specifier === undefined) return null;
	const factory = call.arguments[1];
	const isFn = factory !== undefined && (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory));
	const canned = factory === undefined ? false : isFn ? isCannedFunctionBody(ts, factory.body) : isCannedExpression(ts, factory);
	return {
		kind: factory === undefined ? "module_mock" : "module_mock_factory",
		specifier,
		resolvedPath: resolveSpecifier(ctx.filePath, specifier),
		line: lineOf(ctx, call),
		hasFactory: factory !== undefined,
		factoryReturnsCanned: canned,
	};
}

function compactText(ctx: Ctx, node: TS.Node): string {
	return node.getText(ctx.sf).replace(/\s+/g, " ").slice(0, 80);
}

function spy(ctx: Ctx, call: TS.CallExpression): TestDouble | null {
	const owner = call.arguments[0];
	if (owner === undefined) return null;
	const method = literalText(ctx.ts, call.arguments[1]);
	const target = method === undefined ? undefined : `${compactText(ctx, owner)}.${method}`;
	return {
		kind: "spy",
		target,
		line: lineOf(ctx, call),
		...replacementFacts(ctx.ts, climbChain(ctx.ts, call).impls),
	};
}

/** Parent skipping `as` / `satisfies` / `!` / parentheses wrappers. */
function boundVariable(ts: Ts, outer: TS.CallExpression): string | undefined {
	let node: TS.Node = outer;
	while (
		ts.isParenthesizedExpression(node.parent) ||
		ts.isAsExpression(node.parent) ||
		ts.isSatisfiesExpression(node.parent) ||
		ts.isNonNullExpression(node.parent)
	) {
		node = node.parent;
	}
	const decl = node.parent;
	if (!ts.isVariableDeclaration(decl) || decl.initializer !== node || !ts.isIdentifier(decl.name)) return undefined;
	return decl.name.text;
}

function fnDouble(ctx: Ctx, call: TS.CallExpression): TestDouble | null {
	const { outer, impls } = climbChain(ctx.ts, call);
	const target = boundVariable(ctx.ts, outer);
	if (target === undefined) return null;
	const direct = call.arguments[0];
	const all = direct === undefined ? impls : [direct, ...impls];
	return { kind: "fn", target, line: lineOf(ctx, call), ...replacementFacts(ctx.ts, all) };
}

function valueStub(ctx: Ctx, call: TS.CallExpression, kind: "global_stub" | "env_stub"): TestDouble | null {
	const target = literalText(ctx.ts, call.arguments[0]);
	if (target === undefined) return null;
	const value = call.arguments[1];
	return {
		kind,
		target,
		line: lineOf(ctx, call),
		hasFactory: value !== undefined,
		factoryReturnsCanned: isCannedExpression(ctx.ts, value),
	};
}

function classifyCall(ctx: Ctx, call: TS.CallExpression): TestDouble | null {
	const callee = call.expression;
	if (!ctx.ts.isPropertyAccessExpression(callee) || !ctx.ts.isIdentifier(callee.expression)) return null;
	if (!MOCK_NAMESPACES.has(callee.expression.text)) return null;
	switch (callee.name.text) {
		case "mock":
		case "doMock":
			return moduleMock(ctx, call);
		case "spyOn":
			return spy(ctx, call);
		case "fn":
			return fnDouble(ctx, call);
		case "stubGlobal":
			return valueStub(ctx, call, "global_stub");
		case "stubEnv":
			return valueStub(ctx, call, "env_stub");
		default:
			return null;
	}
}

/** Every test double in one test file, in source order. `filePath` should be repo-relative so `resolvedPath` is too. */
export function extractTestDoubles(filePath: string, content: string): TestDouble[] {
	const ts = loadTsModule();
	if (ts === null) return [];
	const ctx: Ctx = { ts, sf: parse(ts, filePath, content), filePath };
	const out: TestDouble[] = [];
	const visit = (node: TS.Node): void => {
		if (ts.isCallExpression(node)) {
			const double = classifyCall(ctx, node);
			if (double !== null) out.push(double);
		}
		ts.forEachChild(node, visit);
	};
	visit(ctx.sf);
	return out;
}

/** Static imports, re-exports and literal dynamic imports of one file, in source order. Type-only forms are skipped. */
export function importedModules(filePath: string, content: string): ImportedModule[] {
	const ts = loadTsModule();
	if (ts === null) return [];
	const ctx: Ctx = { ts, sf: parse(ts, filePath, content), filePath };
	const out: ImportedModule[] = [];
	const add = (specifier: string, node: TS.Node, kind: ImportedModule["kind"]): void => {
		out.push({ specifier, resolvedPath: resolveSpecifier(filePath, specifier), line: lineOf(ctx, node), kind });
	};
	const visit = (node: TS.Node): void => {
		if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
			add(node.moduleSpecifier.text, node, "static");
		} else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier !== undefined) {
			if (ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text, node, "reexport");
		} else if (isImportCall(ts, node)) {
			const specifier = specifierText(ts, node.arguments[0]);
			if (specifier !== undefined) add(specifier, node, "dynamic");
		}
		ts.forEachChild(node, visit);
	};
	visit(ctx.sf);
	return out;
}

function collectImportLocals(ts: Ts, decl: TS.ImportDeclaration, locals: Map<string, string>): void {
	const clause = decl.importClause;
	if (clause === undefined || clause.isTypeOnly) return;
	if (clause.name !== undefined) locals.set(clause.name.text, "default");
	const bindings = clause.namedBindings;
	if (bindings === undefined) return;
	if (ts.isNamespaceImport(bindings)) {
		locals.set(bindings.name.text, "*");
		return;
	}
	for (const el of bindings.elements) {
		if (!el.isTypeOnly) locals.set(el.name.text, (el.propertyName ?? el.name).text);
	}
}

function dynamicImportNames(ts: Ts, decl: TS.VariableDeclaration, ctx: Ctx, specifier: string): string[] {
	if (!ts.isObjectBindingPattern(decl.name) || decl.initializer === undefined) return [];
	let init: TS.Expression = decl.initializer;
	while (ts.isAwaitExpression(init)) init = init.expression;
	if (!isImportCall(ts, init)) return [];
	const written = specifierText(ts, init.arguments[0]);
	if (written === undefined || !sameModule(ctx.filePath, specifier, written)) return [];
	const names: string[] = [];
	for (const el of decl.name.elements) {
		if (el.dotDotDotToken !== undefined) continue;
		const imported = el.propertyName ?? el.name;
		if (ts.isIdentifier(imported) || ts.isStringLiteralLike(imported)) names.push(imported.text);
	}
	return names;
}

/** The `name` side of `obj.name` is never a reference to a local binding. Only identifiers reach here, so `parent` is set. */
function isPropertyNameSide(ts: Ts, id: TS.Identifier): boolean {
	return ts.isPropertyAccessExpression(id.parent) && id.parent.name === id;
}

/**
 * For a module mock: the names exported by the mocked module that this file imports AND references
 * (`default` and `*` for default / namespace imports; destructured `await import()` names count).
 * HEURISTIC: a reference is any identifier equal to the local binding that is not the name side of
 * a property access, so a shadowing local would over-report. Empty for non-module doubles.
 */
export function mockedSymbols(double: TestDouble, content: string, filePath = "test.ts"): string[] {
	const specifier = double.specifier;
	if ((double.kind !== "module_mock" && double.kind !== "module_mock_factory") || specifier === undefined) return [];
	const ts = loadTsModule();
	if (ts === null) return [];
	const ctx: Ctx = { ts, sf: parse(ts, filePath, content), filePath };
	const locals = new Map<string, string>();
	const used = new Set<string>();
	const names = new Set<string>();
	const visit = (node: TS.Node): void => {
		if (ts.isImportDeclaration(node)) {
			if (ts.isStringLiteral(node.moduleSpecifier) && sameModule(filePath, specifier, node.moduleSpecifier.text)) {
				collectImportLocals(ts, node, locals);
			}
			return;
		}
		if (ts.isVariableDeclaration(node)) for (const n of dynamicImportNames(ts, node, ctx, specifier)) names.add(n);
		if (ts.isIdentifier(node) && !isPropertyNameSide(ts, node)) used.add(node.text);
		ts.forEachChild(node, visit);
	};
	visit(ctx.sf);
	for (const [local, imported] of locals) if (used.has(local)) names.add(imported);
	return [...names].sort();
}
