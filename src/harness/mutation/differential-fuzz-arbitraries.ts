// ===========================================
// Differential fuzz — fast-check arbitraries derived from DECLARED parameter types
// ===========================================
// Syntax-only (no type checker): a parameter's annotation is read off the AST and
// mapped onto fast-check. Supported in v0:
//   string, number, boolean, null/undefined, string/number/boolean literals,
//   T[] / Array<T> / ReadonlyArray<T> / readonly T[], tuples, object literal types
//   (optional members allowed), unions, and non-generic same-file `type` aliases /
//   `interface`s without `extends`. Optional params and defaulted params may be
//   omitted. EVERYTHING else is unsupported, and the reason names the parameter.
//
// Search quality: a plain `fc.integer()` almost never lands on the exact boundary
// of `x < 1234`. Numbers and strings are therefore also drawn from a DICTIONARY of
// the literals in the function body (numbers with ±1 neighbours, strings bare and
// as prefix/suffix) — the standard dictionary trick of fuzzers.

import type * as TS from "typescript";
import {
	type CorpusSeeds,
	type CorpusShape,
	corpusLinesArb,
	corpusParamShape,
	corpusTextArb,
} from "./differential-fuzz-corpus.js";
import type { TsModule } from "./differential-fuzz-deps.js";
import type { FnNode, Located } from "./differential-fuzz-locate.js";
import type { ParamArbitrarySpec } from "./differential-fuzz-types.js";

/** Opaque fast-check arbitrary. */
export interface Arb {
	map: (fn: (value: never) => unknown) => Arb;
}

export interface RunDetails {
	failed: boolean;
	interrupted: boolean;
	numRuns: number;
	seed: number;
	counterexample: unknown[] | null;
	error: unknown;
}

/** The slice of fast-check the engine uses, runtime-checked by {@link asFcApi}. */
export interface FcApi {
	string: (constraints?: { maxLength?: number }) => Arb;
	integer: (constraints?: { min?: number; max?: number }) => Arb;
	double: () => Arb;
	boolean: () => Arb;
	constant: (value: unknown) => Arb;
	constantFrom: (...values: unknown[]) => Arb;
	oneof: (...arbs: unknown[]) => Arb;
	array: (arb: unknown, constraints?: { maxLength?: number }) => Arb;
	tuple: (...arbs: unknown[]) => Arb;
	record: (model: Record<string, unknown>, constraints?: { requiredKeys?: string[] }) => Arb;
	sample: (arb: unknown, params: { numRuns: number; seed: number }) => unknown[];
	asyncProperty: (...args: unknown[]) => unknown;
	check: (property: unknown, params: Record<string, unknown>) => Promise<RunDetails>;
}

const FC_FUNCTIONS = [
	"string", "integer", "double", "boolean", "constant", "constantFrom", "oneof",
	"array", "tuple", "record", "sample", "asyncProperty", "check",
] as const;

/** Prove the dynamically imported module has every function the engine calls. */
export function asFcApi(mod: unknown): FcApi | null {
	if (typeof mod !== "object" || mod === null) return null;
	const missing = FC_FUNCTIONS.some((name) => typeof Reflect.get(mod, name) !== "function");
	// SAFETY: every member the engine calls was just verified to be a function.
	return missing ? null : (mod as FcApi);
}

export interface Dictionary {
	numbers: number[];
	strings: string[];
}

const DICTIONARY_CAP = 24;

/** Numeric / string literals inside the function (neighbours added for numbers). */
export function collectDictionary(ts: TsModule, fn: FnNode): Dictionary {
	const numbers = new Set<number>();
	const strings = new Set<string>();
	const visit = (node: TS.Node): void => {
		if (ts.isNumericLiteral(node)) for (const d of [-1, 0, 1]) numbers.add(Number(node.text) + d);
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) strings.add(node.text);
		ts.forEachChild(node, visit);
	};
	if (fn.body !== undefined) visit(fn.body);
	return {
		numbers: [...numbers].filter(Number.isFinite).slice(0, DICTIONARY_CAP),
		strings: [...strings].slice(0, DICTIONARY_CAP),
	};
}

class UnsupportedType extends Error {}

interface Ctx {
	ts: TsModule;
	sf: TS.SourceFile;
	fc: FcApi;
	dict: Dictionary;
	declared: Map<string, TS.TypeAliasDeclaration | TS.InterfaceDeclaration>;
	active: Set<string>;
	depth: number;
	/** Corpus seeds, when the run has any; absent ⇒ type-driven generation only. */
	seeds?: CorpusSeeds;
	/** While set, every `string` keyword in the current parameter draws from the corpus. */
	stringOverride?: Arb | undefined;
}

const MAX_DEPTH = 5;
const MAX_ARRAY = 6;

function numberArb(ctx: Ctx): Arb {
	const { fc, dict } = ctx;
	const parts: unknown[] = [
		{ weight: 5, arbitrary: fc.integer({ min: -10, max: 10 }) },
		{ weight: 2, arbitrary: fc.integer({ min: -1000, max: 1000 }) },
		{ weight: 1, arbitrary: fc.double() },
	];
	if (dict.numbers.length > 0) parts.push({ weight: 4, arbitrary: fc.constantFrom(...dict.numbers) });
	return fc.oneof(...parts);
}

function stringArb(ctx: Ctx): Arb {
	const { fc, dict } = ctx;
	const parts: unknown[] = [
		{ weight: 4, arbitrary: fc.string({ maxLength: 12 }) },
		{ weight: 1, arbitrary: fc.constantFrom("", " ") },
	];
	if (dict.strings.length > 0) {
		const word = fc.constantFrom(...dict.strings);
		const tail = fc.string({ maxLength: 4 });
		parts.push({ weight: 3, arbitrary: word });
		parts.push({ weight: 2, arbitrary: fc.tuple(word, tail).map(([a, b]: [string, string]) => a + b) });
		parts.push({ weight: 1, arbitrary: fc.tuple(tail, word).map(([a, b]: [string, string]) => a + b) });
	}
	return fc.oneof(...parts);
}

function keywordArb(ctx: Ctx, kind: TS.SyntaxKind): Arb | undefined {
	const { ts, fc } = ctx;
	switch (kind) {
		case ts.SyntaxKind.StringKeyword:
			return ctx.stringOverride ?? stringArb(ctx);
		case ts.SyntaxKind.NumberKeyword:
			return numberArb(ctx);
		case ts.SyntaxKind.BooleanKeyword:
			return fc.boolean();
		case ts.SyntaxKind.UndefinedKeyword:
			return fc.constant(undefined);
		default:
			return undefined;
	}
}

function literalArb(ctx: Ctx, node: TS.LiteralTypeNode): Arb {
	const { ts, fc } = ctx;
	const lit = node.literal;
	if (ts.isStringLiteral(lit)) return fc.constant(lit.text);
	if (ts.isNumericLiteral(lit)) return fc.constant(Number(lit.text));
	if (ts.isPrefixUnaryExpression(lit) && ts.isNumericLiteral(lit.operand)) return fc.constant(-Number(lit.operand.text));
	if (lit.kind === ts.SyntaxKind.TrueKeyword) return fc.constant(true);
	if (lit.kind === ts.SyntaxKind.FalseKeyword) return fc.constant(false);
	if (lit.kind === ts.SyntaxKind.NullKeyword) return fc.constant(null);
	throw new UnsupportedType(`literal type ${node.getText(ctx.sf)}`);
}

function memberName(ts: TsModule, name: TS.PropertyName): string {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
	throw new UnsupportedType("computed or numeric property name");
}

function recordArb(ctx: Ctx, members: readonly TS.TypeElement[]): Arb {
	const { ts, fc } = ctx;
	const model: Record<string, unknown> = {};
	const required: string[] = [];
	for (const m of members) {
		if (!ts.isPropertySignature(m) || m.type === undefined) {
			throw new UnsupportedType(`object member ${m.getText(ctx.sf).slice(0, 40)}`);
		}
		const name = memberName(ts, m.name);
		model[name] = arbFor(ctx, m.type);
		if (m.questionToken === undefined) required.push(name);
	}
	return fc.record(model, { requiredKeys: required });
}

function declaredArb(ctx: Ctx, name: string, decl: TS.TypeAliasDeclaration | TS.InterfaceDeclaration): Arb {
	const { ts } = ctx;
	if (ctx.active.has(name)) throw new UnsupportedType(`recursive type ${name}`);
	ctx.active.add(name);
	try {
		if (ts.isTypeAliasDeclaration(decl)) {
			if (decl.typeParameters !== undefined) throw new UnsupportedType(`generic type ${name}`);
			return arbFor(ctx, decl.type);
		}
		if (decl.typeParameters !== undefined || decl.heritageClauses !== undefined) {
			throw new UnsupportedType(`interface ${name} with type parameters or extends`);
		}
		return recordArb(ctx, decl.members);
	} finally {
		ctx.active.delete(name);
	}
}

function referenceArb(ctx: Ctx, node: TS.TypeReferenceNode): Arb {
	const { ts, fc } = ctx;
	const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.getText(ctx.sf);
	const arg = node.typeArguments?.[0];
	if ((name === "Array" || name === "ReadonlyArray") && arg !== undefined && node.typeArguments?.length === 1) {
		return fc.array(arbFor(ctx, arg), { maxLength: MAX_ARRAY });
	}
	const decl = ctx.declared.get(name);
	if (decl !== undefined && node.typeArguments === undefined) return declaredArb(ctx, name, decl);
	throw new UnsupportedType(`type ${node.getText(ctx.sf)} (not a supported shape)`);
}

function compositeArb(ctx: Ctx, node: TS.TypeNode): Arb | undefined {
	const { ts, fc } = ctx;
	if (ts.isParenthesizedTypeNode(node)) return arbFor(ctx, node.type);
	if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) return arbFor(ctx, node.type);
	if (ts.isArrayTypeNode(node)) return fc.array(arbFor(ctx, node.elementType), { maxLength: MAX_ARRAY });
	if (ts.isUnionTypeNode(node)) return fc.oneof(...node.types.map((t) => arbFor(ctx, t)));
	if (ts.isTupleTypeNode(node)) {
		const elems = node.elements.map((e) => {
			if (ts.isOptionalTypeNode(e) || ts.isRestTypeNode(e)) throw new UnsupportedType("optional or rest tuple element");
			return arbFor(ctx, ts.isNamedTupleMember(e) ? e.type : e);
		});
		return fc.tuple(...elems);
	}
	return ts.isTypeLiteralNode(node) ? recordArb(ctx, node.members) : undefined;
}

function arbFor(ctx: Ctx, node: TS.TypeNode): Arb {
	const { ts } = ctx;
	if (ctx.depth > MAX_DEPTH) throw new UnsupportedType("type nesting deeper than 5");
	ctx.depth++;
	try {
		const keyword = keywordArb(ctx, node.kind);
		if (keyword !== undefined) return keyword;
		if (ts.isLiteralTypeNode(node)) return literalArb(ctx, node);
		if (ts.isTypeReferenceNode(node)) return referenceArb(ctx, node);
		const composite = compositeArb(ctx, node);
		if (composite !== undefined) return composite;
		throw new UnsupportedType(`type ${node.getText(ctx.sf).slice(0, 60)} (${ts.SyntaxKind[node.kind]})`);
	} finally {
		ctx.depth--;
	}
}

function declaredTypes(ts: TsModule, sf: TS.SourceFile): Ctx["declared"] {
	const map: Ctx["declared"] = new Map();
	for (const stmt of sf.statements) {
		if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) map.set(stmt.name.text, stmt);
	}
	return map;
}

/** The annotation's arbitrary, drawing strings from the corpus when `shape` says so. */
function typedArb(ctx: Ctx, type: TS.TypeNode, shape: CorpusShape | null): Arb {
	const seeds = ctx.seeds?.texts ?? [];
	if (shape === "lines") return corpusLinesArb(ctx.fc, seeds, ctx.fc.array(stringArb(ctx), { maxLength: MAX_ARRAY }));
	if (shape === null) return arbFor(ctx, type);
	ctx.stringOverride = corpusTextArb(ctx.fc, seeds, stringArb(ctx));
	try {
		return arbFor(ctx, type);
	} finally {
		ctx.stringOverride = undefined;
	}
}

/** Arbitrary for one parameter: its annotation, or a literal initializer's type. */
function paramArb(ctx: Ctx, param: TS.ParameterDeclaration, shape: CorpusShape | null): Arb {
	const { ts, fc } = ctx;
	if (param.dotDotDotToken !== undefined) throw new UnsupportedType("rest parameter");
	let base: Arb;
	if (param.type !== undefined) base = typedArb(ctx, param.type, shape);
	else if (param.initializer !== undefined && ts.isNumericLiteral(param.initializer)) base = numberArb(ctx);
	else if (param.initializer !== undefined && ts.isStringLiteral(param.initializer)) base = stringArb(ctx);
	else if (param.initializer?.kind === ts.SyntaxKind.TrueKeyword || param.initializer?.kind === ts.SyntaxKind.FalseKeyword) {
		base = fc.boolean();
	} else throw new UnsupportedType("no type annotation");
	const omittable = param.questionToken !== undefined || param.initializer !== undefined;
	return omittable ? fc.oneof(base, fc.constant(undefined)) : base;
}

function corpusNote(shape: CorpusShape, seeds: CorpusSeeds | undefined): string {
	const n = seeds?.texts.length ?? 0;
	return `corpus-seeded ${shape} (${n} seeds: ${seeds?.fromTests ?? 0} from tests, ${seeds?.fromRepo ?? 0} from repo) plus type-driven fallback`;
}

function paramSpec(
	sf: TS.SourceFile,
	param: TS.ParameterDeclaration,
	name: string,
	shape: CorpusShape | null,
	seeds: CorpusSeeds | undefined,
): ParamArbitrarySpec {
	const typeText = (param.type?.getText(sf) ?? param.initializer?.getText(sf) ?? "").slice(0, 80);
	if (shape === null) return { name, typeText, weak: false, note: "derived from the declared type" };
	return { name, typeText, weak: false, note: corpusNote(shape, seeds), corpusSeeded: true };
}

export interface ArbitrarySet {
	arbs: Arb[];
	specs: ParamArbitrarySpec[];
}

/** Derive one arbitrary per declared parameter, or name the first one that cannot be. */
export function deriveArbitraries(
	ts: TsModule,
	sf: TS.SourceFile,
	fc: FcApi,
	fn: FnNode,
	dict: Dictionary,
	seeds?: CorpusSeeds,
): Located<ArbitrarySet> {
	const ctx: Ctx = { ts, sf, fc, dict, declared: declaredTypes(ts, sf), active: new Set(), depth: 0 };
	if (seeds !== undefined && seeds.texts.length > 0) ctx.seeds = seeds;
	const arbs: Arb[] = [];
	const specs: ParamArbitrarySpec[] = [];
	for (const param of fn.parameters) {
		const name = param.name.getText(sf);
		if (name === "this") continue;
		const shape = ctx.seeds === undefined ? null : corpusParamShape(ts, param, fn.body, name);
		try {
			arbs.push(paramArb(ctx, param, shape));
		} catch (err) {
			if (!(err instanceof UnsupportedType)) throw err;
			return { ok: false, reason: `parameter "${name}": ${err.message}` };
		}
		specs.push(paramSpec(sf, param, name, shape, ctx.seeds));
	}
	return { ok: true, arbs, specs };
}
