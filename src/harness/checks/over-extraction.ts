// Over-extraction detection — the counterweight to the complexity caps.
//
// Every metric gate in this harness pushes in ONE direction: extract. The
// cyclomatic cap, the cognitive cap, the CRAP gate and the line cap are all
// satisfied by moving code into another function, and nothing pushes back. A
// census of this tree found 4538 private single-call-site helpers, 1118 of
// them <= 6 lines. Most are fine. What is missing is a signal that separates a
// helper which EARNED its name from one that bought a metric point and charged
// the reader a hop.
//
// `single_use_trivial_helper` flags the second kind only, and only where all
// three signals coincide:
//   1. the function is NOT exported (an exported helper has call sites this
//      file cannot see, so single-use is unknowable here),
//   2. it has exactly one call site in its own file (and that reference is a
//      CALL, not a value passed elsewhere),
//   3. its body is <= 3 statements AND its name carries no information the
//      call site does not already have — either a generic verb+collection
//      shape (`processItems`, `handleData`, `buildResult`), or a name that
//      merely restates the single call it wraps (`parseJson` -> `JSON.parse`).
//
// Deliberately ADVISORY and never a block. It must never oppose a legitimate
// extraction — a helper that names a domain rule the call site lacks
// (`isEligibleForRefund`), or one long enough that inlining would re-inflate
// the caller, is silent by construction. Determinism `heuristic`: the name
// test is a judgement about information, not a proof.

import { createRequire } from "node:module";
import type * as TS from "typescript";
import { parseTsSourceWith } from "./cyclomatic-ast.js";
import { getExtension, type InlineMatch, isStrictTestFile, JS_TS_EXTS } from "./shared.js";

type TsModule = typeof TS;

// Self-contained `typescript` loader — same idiom as cyclomatic-ast.ts /
// introverted-test.ts (`typescript` is an optionalDependency, so a
// `--omit=optional` install has no AST and the check no-ops rather than throws).
let tsCache: TsModule | null | undefined;
function loadTs(): TsModule | null {
	if (tsCache !== undefined) return tsCache;
	try {
		// SAFETY: `require("typescript")` returns that module's namespace object;
		// the cast only names it, and a load failure lands in the catch below.
		tsCache = createRequire(import.meta.url)("typescript") as TsModule;
	} catch {
		tsCache = null;
	}
	return tsCache;
}

/** Body statements above this many mean inlining would re-inflate the caller. */
const MAX_TRIVIAL_STATEMENTS = 3;
/** A callee name shorter than this is too generic for the restatement test. */
const MIN_CALLEE_NAME_LEN = 4;
/** How much of the longer name the shorter one must cover to count as a restatement. */
const MIN_NAME_OVERLAP_RATIO = 0.5;
const MAX_MATCHES = 10;

/** Verb prefixes that describe *doing something* without saying what. */
const GENERIC_VERB_RE = /^(process|handle|do|run|apply|make|build)([A-Z]\w*)$/;

/** Nouns that name a shape or a container, never a domain concept. */
const GENERIC_NOUNS = new Set([
	"all", "arg", "args", "array", "arrays", "config", "content", "contents",
	"data", "each", "element", "elements", "entries", "entry", "event", "events",
	"file", "files", "info", "input", "inputs", "it", "item", "items", "line",
	"lines", "list", "lists", "map", "message", "messages", "node", "nodes",
	"number", "object", "objects", "one", "option", "options", "output",
	"outputs", "param", "params", "payload", "record", "records", "request",
	"response", "result", "results", "row", "rows", "set", "string", "stuff",
	"task", "tasks", "them", "thing", "things", "value", "values",
]);

/** `processItems` / `handleData` — a generic verb over a shape word. */
function hasGenericShape(name: string): boolean {
	const m = GENERIC_VERB_RE.exec(name);
	return m?.[2] !== undefined && GENERIC_NOUNS.has(m[2].toLowerCase());
}

/** The identifier a call expression targets: `f()` -> f, `a.b()` -> b. */
function calleeName(ts: TsModule, expr: TS.Expression): string | null {
	if (ts.isIdentifier(expr)) return expr.text;
	if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text;
	return null;
}

/** The single expression a one-statement body evaluates, if there is one. */
function soleExpression(ts: TsModule, body: TS.Block): TS.Expression | undefined {
	const [st] = body.statements;
	if (!st || body.statements.length !== 1) return undefined;
	if (ts.isReturnStatement(st)) return st.expression;
	if (ts.isExpressionStatement(st)) return st.expression;
	return undefined;
}

/**
 * `parseJson` wrapping `JSON.parse` — the helper's name is contained in the
 * callee's, or vice versa, so the hop tells the reader nothing new.
 */
function restatesCallee(ts: TsModule, name: string, body: TS.Block): boolean {
	const expr = soleExpression(ts, body);
	if (!expr || !ts.isCallExpression(expr)) return false;
	const callee = calleeName(ts, expr.expression);
	if (!callee || callee.length < MIN_CALLEE_NAME_LEN) return false;
	const a = name.toLowerCase();
	const b = callee.toLowerCase();
	if (!a.includes(b) && !b.includes(a)) return false;
	// The shorter name must cover most of the longer one. Without this, any
	// helper wrapping a bare collection method restates it by construction
	// (`applySinceFilter` -> `.filter`, `sortTasksForDisplay` -> `.sort`) even
	// though "since" and "for display" are exactly the information the call
	// site lacks. Measured over 3470 tracked files in this tree
	// (`scratch/over-extraction-census.mts`): the ratio drops the finding count
	// from 16 to 9, and all 7 it removed were of exactly that shape.
	// `longer` is the length of an identifier that already passed the
	// containment test above, so it is >= MIN_CALLEE_NAME_LEN — never zero.
	const shorter = Math.min(a.length, b.length);
	const longer = Math.max(a.length, b.length);
	return shorter / longer >= MIN_NAME_OVERLAP_RATIO;
}

interface Candidate {
	name: string;
	body: TS.Block;
	/** The whole declaration statement — references inside it are self-references. */
	decl: TS.Node;
}

function hasExportModifier(ts: TsModule, node: TS.Node): boolean {
	// SAFETY: getCombinedModifierFlags only reads `modifiers`, and tolerates a
	// node that has none (it returns ModifierFlags.None), so widening a
	// statement to Declaration here cannot read a field that is absent.
	const flags = ts.getCombinedModifierFlags(node as TS.Declaration);
	return (flags & ts.ModifierFlags.Export) !== 0;
}

/** Arrow / function-expression initializer with a block body, if present. */
function initializerBody(ts: TsModule, init: TS.Expression | undefined): TS.Block | undefined {
	if (!init) return undefined;
	if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) return undefined;
	return ts.isBlock(init.body) ? init.body : undefined;
}

/** Top-level `function f() {}` and `const f = () => {}` declarations. */
function collectCandidates(ts: TsModule, sf: TS.SourceFile): Candidate[] {
	const out: Candidate[] = [];
	for (const st of sf.statements) {
		if (hasExportModifier(ts, st)) continue;
		if (ts.isFunctionDeclaration(st) && st.name && st.body) {
			out.push({ name: st.name.text, body: st.body, decl: st });
			continue;
		}
		if (!ts.isVariableStatement(st)) continue;
		for (const d of st.declarationList.declarations) {
			const body = initializerBody(ts, d.initializer);
			if (body && ts.isIdentifier(d.name)) out.push({ name: d.name.text, body, decl: st });
		}
	}
	return out;
}

/** Names re-exported via `export { f }` / `export default f`. */
function exportListNames(ts: TsModule, sf: TS.SourceFile): Set<string> {
	const names = new Set<string>();
	for (const st of sf.statements) {
		if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) {
			names.add(st.expression.text);
			continue;
		}
		if (!ts.isExportDeclaration(st) || !st.exportClause) continue;
		if (!ts.isNamedExports(st.exportClause)) continue;
		for (const el of st.exportClause.elements) names.add((el.propertyName ?? el.name).text);
	}
	return names;
}

/** An identifier in a member/property NAME position refers to a key, not our function. */
function isPropertyNamePosition(ts: TsModule, id: TS.Identifier): boolean {
	const p = id.parent;
	if (!p) return false;
	if (ts.isPropertyAccessExpression(p)) return p.name === id;
	if (ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) return p.name === id;
	if (ts.isMethodDeclaration(p) || ts.isMethodSignature(p)) return p.name === id;
	return false;
}

/** Every value-position identifier in the file, grouped by text. */
function indexIdentifiers(ts: TsModule, sf: TS.SourceFile): Map<string, TS.Identifier[]> {
	const byName = new Map<string, TS.Identifier[]>();
	const visit = (node: TS.Node): void => {
		if (ts.isIdentifier(node) && !isPropertyNamePosition(ts, node)) {
			const list = byName.get(node.text);
			if (list) list.push(node);
			else byName.set(node.text, [node]);
		}
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(sf, visit);
	return byName;
}

/** True when the file references `name` exactly once, and that use is a call. */
function hasExactlyOneCallSite(ts: TsModule, refs: TS.Identifier[], decl: TS.Node): boolean {
	const outside = refs.filter((id) => id.getStart() < decl.getStart() || id.end > decl.end);
	const [only] = outside;
	if (!only || outside.length !== 1) return false;
	const p = only.parent;
	return p !== undefined && ts.isCallExpression(p) && p.expression === only;
}

/** Whole-file facts every candidate is judged against. */
interface FileFacts {
	/** Names re-exported through an export list — not private after all. */
	exported: Set<string>;
	/** Every value-position identifier in the file, grouped by text. */
	identifiers: Map<string, TS.Identifier[]>;
}

/** All three signals present: private, trivial, uninformative name, one call. */
function boughtNothing(ts: TsModule, c: Candidate, facts: FileFacts): boolean {
	if (facts.exported.has(c.name)) return false;
	if (c.body.statements.length > MAX_TRIVIAL_STATEMENTS) return false;
	if (!hasGenericShape(c.name) && !restatesCallee(ts, c.name, c.body)) return false;
	return hasExactlyOneCallSite(ts, facts.identifiers.get(c.name) ?? [], c.decl);
}

function message(name: string, statements: number): string {
	const plural = statements === 1 ? "statement" : "statements";
	return `single-use trivial helper "${name}" — one call site, ${statements} ${plural}, and a name the call site already implies. Inline it, or rename it to state the rule it encodes.`;
}

/**
 * Flag non-exported, single-call-site, <=3-statement helpers whose names carry
 * no information the call site lacks. Advisory: it never opposes a legitimate
 * extraction, only one that bought nothing.
 */
export function checkSingleUseTrivialHelper(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath)) || isStrictTestFile(filePath)) return [];
	const ts = loadTs();
	if (!ts) return [];

	const sf = parseTsSourceWith(ts, content, filePath);
	const candidates = collectCandidates(ts, sf);
	if (candidates.length === 0) return [];

	const facts: FileFacts = {
		exported: exportListNames(ts, sf),
		identifiers: indexIdentifiers(ts, sf),
	};
	const matches: InlineMatch[] = [];
	for (const c of candidates) {
		if (matches.length >= MAX_MATCHES) break;
		if (!boughtNothing(ts, c, facts)) continue;
		const line = sf.getLineAndCharacterOfPosition(c.decl.getStart()).line + 1;
		matches.push({ line, text: message(c.name, c.body.statements.length) });
	}
	return matches;
}
