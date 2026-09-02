// ===========================================
// metrics split-plan — intra-file reference graph (TS AST)
// ===========================================
// One file → its named top-level declarations ("units"), the reference edges
// between them (a call, a type use, a constant read — one mechanism for all
// three), and the external import bindings each unit actually uses. The
// clusterer (`metrics-split-plan-cluster.ts`) groups units on this graph; the
// command renders the proposed modules. Read-only; shares the cached parse in
// `checks/cyclomatic-ast.ts` and its per-function complexity pass.
//
// Heuristic, not a binder: a local variable that shadows a top-level name reads
// as a reference. That is the right side to err on for a split plan — a false
// edge keeps two units together, a missed one creates a cross-module import.

import type * as TS from "typescript";
import {
	computeCyclomaticAst,
	parseTsSource,
	type TsModule,
} from "../harness/checks/cyclomatic-ast.js";
import { countLines } from "../harness/large-file-policy.js";

type SplitUnitKind = "function" | "class" | "type" | "value";

export interface SplitUnit {
	/** Index in source order; edges refer to units by this id. */
	id: number;
	name: string;
	kind: SplitUnitKind;
	exported: boolean;
	/** 1-based; includes an attached leading doc comment. */
	startLine: number;
	endLine: number;
	lines: number;
	/** Σ cyclomatic of every implementation function inside the unit's range. */
	cyclomatic: number;
	/** Module specifiers whose bindings the unit references (sorted). */
	imports: string[];
}

export interface SplitEdge {
	from: number;
	to: number;
}

export interface SplitGraph {
	filePath: string;
	totalLines: number;
	/** Lines owned by no unit: header, imports, expression statements. */
	preambleLines: number;
	units: SplitUnit[];
	/** Deduplicated, sorted by (from, to); never a self-edge. */
	edges: SplitEdge[];
}

interface RawUnit {
	name: string;
	kind: SplitUnitKind;
	exported: boolean;
	/** The statement node (for comment attachment and export detection). */
	statement: TS.Statement;
	/** The declaration whose body is walked for references. */
	body: TS.Node;
}

function hasExportModifier(ts: TsModule, stmt: TS.Statement): boolean {
	const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
	return (mods ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function addImportClause(
	ts: TsModule,
	clause: TS.ImportClause,
	spec: string,
	out: Map<string, string>,
): void {
	if (clause.name) out.set(clause.name.text, spec);
	const bindings = clause.namedBindings;
	if (!bindings) return;
	if (ts.isNamespaceImport(bindings)) {
		out.set(bindings.name.text, spec);
		return;
	}
	for (const el of bindings.elements) out.set(el.name.text, spec);
}

/** Local binding name → module specifier, for every import form with a binding. */
function importBindings(ts: TsModule, sf: TS.SourceFile): Map<string, string> {
	const out = new Map<string, string>();
	for (const stmt of sf.statements) {
		if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
		if (stmt.importClause) addImportClause(ts, stmt.importClause, stmt.moduleSpecifier.text, out);
	}
	return out;
}

function kindOfVariable(ts: TsModule, decl: TS.VariableDeclaration): SplitUnitKind {
	const init = decl.initializer;
	if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return "function";
	return "value";
}

function namedStatementUnit(ts: TsModule, stmt: TS.Statement): RawUnit | null {
	const exported = hasExportModifier(ts, stmt);
	if (ts.isFunctionDeclaration(stmt) && stmt.name) {
		return { name: stmt.name.text, kind: "function", exported, statement: stmt, body: stmt };
	}
	if (ts.isClassDeclaration(stmt) && stmt.name) {
		return { name: stmt.name.text, kind: "class", exported, statement: stmt, body: stmt };
	}
	if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
		return { name: stmt.name.text, kind: "type", exported, statement: stmt, body: stmt };
	}
	return null;
}

function variableUnits(ts: TsModule, stmt: TS.VariableStatement): RawUnit[] {
	const exported = hasExportModifier(ts, stmt);
	const out: RawUnit[] = [];
	for (const decl of stmt.declarationList.declarations) {
		if (!ts.isIdentifier(decl.name)) continue;
		out.push({ name: decl.name.text, kind: kindOfVariable(ts, decl), exported, statement: stmt, body: decl });
	}
	return out;
}

function collectRawUnits(ts: TsModule, sf: TS.SourceFile): RawUnit[] {
	const out: RawUnit[] = [];
	for (const stmt of sf.statements) {
		if (ts.isVariableStatement(stmt)) {
			out.push(...variableUnits(ts, stmt));
			continue;
		}
		const unit = namedStatementUnit(ts, stmt);
		if (unit) out.push(unit);
	}
	return out;
}

/**
 * Start position of the unit including a leading comment that sits directly
 * above it (no blank line in between). A comment separated by a blank line is
 * a stray remark on the previous region, not this unit's doc.
 */
function attachedStart(ts: TsModule, sf: TS.SourceFile, stmt: TS.Statement): number {
	const nodeStart = stmt.getStart(sf);
	const ranges = ts.getLeadingCommentRanges(sf.text, stmt.getFullStart()) ?? [];
	let start = nodeStart;
	for (let i = ranges.length - 1; i >= 0; i--) {
		const range = ranges[i];
		if (!range) break;
		const gap = sf.text.slice(range.end, start);
		if (/\n[ \t]*\n/.test(gap)) break;
		start = range.pos;
	}
	return start;
}

/** True for an identifier position that names a property, not a reference. */
function isPropertyNamePosition(ts: TsModule, node: TS.Identifier): boolean {
	const parent = node.parent;
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
	if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
	if (ts.isPropertySignature(parent) && parent.name === node) return true;
	if (ts.isMethodSignature(parent) && parent.name === node) return true;
	return false;
}

/** Every identifier text used inside `node` as a reference (not a property name). */
function referencedNames(ts: TsModule, node: TS.Node): Set<string> {
	const names = new Set<string>();
	const visit = (n: TS.Node): void => {
		if (ts.isIdentifier(n) && !isPropertyNamePosition(ts, n)) names.add(n.text);
		ts.forEachChild(n, visit);
	};
	ts.forEachChild(node, visit);
	return names;
}

function lineOf(sf: TS.SourceFile, pos: number): number {
	return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function sumCyclomaticIn(entries: { line: number; cyclomatic: number }[], start: number, end: number): number {
	let total = 0;
	for (const e of entries) if (e.line >= start && e.line <= end) total += e.cyclomatic;
	return total;
}

interface UnitContext {
	ts: TsModule;
	sf: TS.SourceFile;
	bindings: Map<string, string>;
	complexity: { line: number; cyclomatic: number }[];
}

function toSplitUnit(ctx: UnitContext, raw: RawUnit, id: number): { unit: SplitUnit; refs: Set<string> } {
	const { ts, sf } = ctx;
	const startLine = lineOf(sf, attachedStart(ts, sf, raw.statement));
	const endLine = lineOf(sf, raw.statement.getEnd());
	const refs = referencedNames(ts, raw.body);
	const imports = new Set<string>();
	for (const name of refs) {
		const spec = ctx.bindings.get(name);
		if (spec !== undefined) imports.add(spec);
	}
	const unit: SplitUnit = {
		id,
		name: raw.name,
		kind: raw.kind,
		exported: raw.exported,
		startLine,
		endLine,
		lines: endLine - startLine + 1,
		cyclomatic: sumCyclomaticIn(ctx.complexity, startLine, endLine),
		imports: [...imports].sort(),
	};
	return { unit, refs };
}

function edgesFromRefs(units: SplitUnit[], refsById: Set<string>[]): SplitEdge[] {
	const idByName = new Map<string, number>();
	for (const u of units) if (!idByName.has(u.name)) idByName.set(u.name, u.id);
	const seen = new Set<string>();
	const edges: SplitEdge[] = [];
	units.forEach((u, i) => {
		for (const name of refsById[i] ?? []) {
			const to = idByName.get(name);
			if (to === undefined || to === u.id || seen.has(`${u.id}>${to}`)) continue;
			seen.add(`${u.id}>${to}`);
			edges.push({ from: u.id, to });
		}
	});
	return edges.sort((a, b) => a.from - b.from || a.to - b.to);
}

/**
 * Build the reference graph for one JS/TS file. Returns null only when the
 * optional `typescript` dependency is absent (no regex fallback: a split plan
 * without real scopes would be noise).
 */
export function buildSplitGraph(content: string, filePath: string): SplitGraph | null {
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return null;
	const { ts, sf } = parsed;
	const ctx: UnitContext = {
		ts,
		sf,
		bindings: importBindings(ts, sf),
		complexity: computeCyclomaticAst(content, filePath) ?? [],
	};
	const built = collectRawUnits(ts, sf).map((raw, id) => toSplitUnit(ctx, raw, id));
	const units = built.map((b) => b.unit);
	const totalLines = countLines(content);
	const unitLines = units.reduce((sum, u) => sum + u.lines, 0);
	return {
		filePath,
		totalLines,
		preambleLines: Math.max(0, totalLines - unitLines),
		units,
		edges: edgesFromRefs(units, built.map((b) => b.refs)),
	};
}
