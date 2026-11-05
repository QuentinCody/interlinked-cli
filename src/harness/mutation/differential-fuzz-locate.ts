// ===========================================
// Differential fuzz — locate the mutant site and its enclosing exported function
// ===========================================
// Two jobs, both syntax-only (no type checker, no program):
//   1. Resolve WHERE in the source the mutant sits. A target either carries a
//      `startOffset`, or it carries the manifest's identity (`mutantId`,
//      `qualifiedName`, `ordinalWithinSymbol`) and the offset is re-derived by
//      running identity.ts's OWN `deriveIdentities` over every node whose text
//      equals the lexeme — so the ordinal rule is never re-implemented here.
//      The ordinal is trusted only while it ranks the SAME population it was
//      measured against: when the target carries the manifest's `symbolHash`
//      and the symbol's body changed AND the lexeme's site count inside it
//      changed, the re-location is ambiguous and refused (a newly inserted
//      identical lexeme earlier in the body takes ordinal 0 — and with it the
//      mutant id — so neither lookup can tell the sites apart;
//      docs/reviews/kill-proof-manifest-route.md §3).
//   2. Find the top-level function the site lives in and the name the module
//      exports it under (a non-exported one gets a synthetic export, see below). A mutant nested in a closure is fuzzed through its
//      outermost top-level function (the closure is not callable by itself).

import type * as TS from "typescript";
import type { TsModule } from "./differential-fuzz-deps.js";
import type { FuzzMutantTarget } from "./differential-fuzz-types.js";
import { computeSymbolHashes, deriveIdentities, type SymbolHashEntry } from "./identity.js";

export type FnNode = TS.FunctionDeclaration | TS.ArrowFunction | TS.FunctionExpression;

export type Located<T> = ({ ok: true } & T) | { ok: false; reason: string };

export interface FunctionTarget {
	fn: FnNode;
	/** Name of the function in its own module scope, e.g. "computeScore". */
	localName: string;
	/** Name the module exports it under (differs only for `export { a as b }`).
	 *  For a non-exported function it is {@link FUZZ_TARGET_EXPORT}: the name the
	 *  synthetic re-export (see {@link syntheticExportSuffix}) gives it. */
	exportName: string;
	/** True when the module itself exports the function; false when the engine must add a synthetic export. */
	exported: boolean;
}

/** Export name of the synthetic re-export appended to a non-exported target's module. */
export const FUZZ_TARGET_EXPORT = "__fuzz_target__";

/**
 * Source appended to BOTH the pristine and the mutant module so a non-exported
 * top-level function can be called. A leading newline keeps it clear of a
 * trailing `//` comment; it sits after every statement, so no offset moves.
 */
export function syntheticExportSuffix(localName: string): string {
	return `\nexport { ${localName} as ${FUZZ_TARGET_EXPORT} };\n`;
}

export function parseSource(ts: TsModule, file: string, content: string): TS.SourceFile {
	return ts.createSourceFile(file, content, ts.ScriptTarget.Latest, /* setParentNodes */ true);
}

/** Every distinct start offset of a node (token included) whose text is exactly `lexeme`. */
export function lexemeCandidates(sf: TS.SourceFile, content: string, lexeme: string): number[] {
	if (lexeme.length === 0) return [];
	const starts = new Set<number>();
	const visit = (node: TS.Node): void => {
		const start = node.getStart(sf);
		if (node.getEnd() - start === lexeme.length && content.startsWith(lexeme, start)) starts.add(start);
		for (const child of node.getChildren(sf)) visit(child);
	};
	visit(sf);
	return [...starts].sort((a, b) => a - b);
}

function driftReason(target: FuzzMutantTarget, detail: string): string {
	return `source drift: ${detail} (mutant ${target.mutantId} in ${target.qualifiedName})`;
}

/** The target's symbol as the CURRENT source hashes it: by `symbolId` (file,
 *  qualified name, arity), else by qualified name alone — an arity change
 *  re-keys the symbol while its body may still hold the site. `undefined` when
 *  no symbol of that name exists any more (renamed / deleted); `null` when the
 *  TypeScript API is unavailable. */
function currentSymbol(target: FuzzMutantTarget, content: string): SymbolHashEntry | null | undefined {
	const hashes = computeSymbolHashes(target.file, content);
	if (hashes === null) return null;
	const byId = hashes.get(target.symbolId);
	if (byId !== undefined) return byId;
	for (const entry of hashes.values()) if (entry.qualifiedName === target.qualifiedName) return entry;
	return undefined;
}

/** The ambiguity refusal (header note). `null` ⇒ the ordinal rule still ranks
 *  the population it was measured against (same body, or a body edit that left
 *  the lexeme's site count alone — an unrelated statement, a comment), or the
 *  target carries nothing to compare. A count of 0 is not ambiguity: the site is
 *  gone, and the ordinal lookup below reports that as drift. */
function ambiguousRelocation(target: FuzzMutantTarget, symbol: SymbolHashEntry, sitesNow: number): string | null {
	const was = target.measuredSites;
	if (target.symbolHash === undefined || was === undefined) return null;
	if (target.symbolHash === symbol.symbolHash || sitesNow === 0 || sitesNow === was) return null;
	const times = (n: number): string => `${n} time${n === 1 ? "" : "s"}`;
	return `ambiguous re-location: ${target.originalLexeme} now occurs ${times(sitesNow)} in ${target.qualifiedName} (was ${was}); re-measure the file`;
}

/** Resolve the mutated token's offset: explicit, else re-derived from identity. */
export function locateMutantOffset(
	ts: TsModule,
	target: FuzzMutantTarget,
	content: string,
): Located<{ offset: number }> {
	const lexeme = target.originalLexeme;
	const explicit = target.startOffset;
	if (explicit !== undefined) {
		if (!content.startsWith(lexeme, explicit)) {
			return { ok: false, reason: driftReason(target, `lexeme not at offset ${explicit}`) };
		}
		return { ok: true, offset: explicit };
	}
	const symbol = currentSymbol(target, content);
	if (symbol === null) return { ok: false, reason: "typescript unavailable for identity derivation" };
	if (symbol === undefined) return { ok: false, reason: `source drift: symbol ${target.qualifiedName} not found (mutant ${target.mutantId})` };
	const candidates = lexemeCandidates(parseSource(ts, target.file, content), content, lexeme);
	const raws = candidates.map((startOffset) => ({
		file: target.file,
		mutator: target.mutator,
		originalLexeme: lexeme,
		replacement: target.replacement,
		startOffset,
	}));
	const identities = deriveIdentities(target.file, content, raws);
	if (identities === null) return { ok: false, reason: "typescript unavailable for identity derivation" };
	const sitesNow = identities.filter((id) => id.qualifiedName === target.qualifiedName).length;
	const ambiguous = ambiguousRelocation(target, symbol, sitesNow);
	if (ambiguous !== null) return { ok: false, reason: ambiguous };
	const byId = identities.findIndex((id) => id.mutantId === target.mutantId);
	const byOrdinal = identities.findIndex(
		(id) => id.qualifiedName === target.qualifiedName && id.ordinalWithinSymbol === target.ordinalWithinSymbol,
	);
	const offset = candidates[byId !== -1 ? byId : byOrdinal];
	if (offset === undefined) {
		return { ok: false, reason: driftReason(target, `no site among ${candidates.length} candidate token(s)`) };
	}
	return { ok: true, offset };
}

function hasExportModifier(ts: TsModule, node: TS.Node): boolean {
	const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
	return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function asFnNode(ts: TsModule, node: TS.Node | undefined): FnNode | undefined {
	if (node === undefined) return undefined;
	const isFn = ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
	return isFn ? node : undefined;
}

/** `export { local as alias }` specifiers with no `from` clause: local → export name. */
function exportedAliases(ts: TsModule, sf: TS.SourceFile): Map<string, string> {
	const map = new Map<string, string>();
	for (const stmt of sf.statements) {
		if (!ts.isExportDeclaration(stmt) || stmt.moduleSpecifier !== undefined || stmt.isTypeOnly) continue;
		if (stmt.exportClause === undefined || !ts.isNamedExports(stmt.exportClause)) continue;
		for (const el of stmt.exportClause.elements) {
			if (!el.isTypeOnly) map.set((el.propertyName ?? el.name).text, el.name.text);
		}
	}
	return map;
}

interface Candidate {
	fn: FnNode;
	localName: string;
}

function candidateIn(ts: TsModule, sf: TS.SourceFile, stmt: TS.Statement, offset: number): Candidate | undefined {
	if (ts.isFunctionDeclaration(stmt)) {
		return stmt.name !== undefined && stmt.body !== undefined ? { fn: stmt, localName: stmt.name.text } : undefined;
	}
	if (!ts.isVariableStatement(stmt)) return undefined;
	const decl = stmt.declarationList.declarations.find((d) => offset >= d.getStart(sf) && offset < d.getEnd());
	const fn = asFnNode(ts, decl?.initializer);
	return decl !== undefined && ts.isIdentifier(decl.name) && fn !== undefined
		? { fn, localName: decl.name.text }
		: undefined;
}

/**
 * The top-level function containing `offset`, and how the module exports it.
 * A non-exported top-level function is still a target (`exported: false`); a
 * function nested in another function or class never is.
 */
export function findExportedFunction(ts: TsModule, sf: TS.SourceFile, offset: number): Located<FunctionTarget> {
	const stmt = sf.statements.find((s) => offset >= s.getStart(sf) && offset < s.getEnd());
	if (stmt === undefined) return { ok: false, reason: "mutant is outside every top-level statement" };
	const found = candidateIn(ts, sf, stmt, offset);
	if (found === undefined) {
		return { ok: false, reason: `mutant is not inside a named top-level function (${ts.SyntaxKind[stmt.kind]})` };
	}
	const { fn, localName } = found;
	if (offset < fn.getStart(sf) || offset >= fn.getEnd()) {
		return { ok: false, reason: `mutant is outside the body of ${localName}` };
	}
	if (fn.asteriskToken !== undefined) return { ok: false, reason: "generator functions are not supported" };
	if (hasExportModifier(ts, stmt)) return { ok: true, fn, localName, exportName: localName, exported: true };
	const alias = exportedAliases(ts, sf).get(localName);
	if (alias === undefined) {
		if (sf.text.includes(FUZZ_TARGET_EXPORT)) {
			return { ok: false, reason: `${localName} is not exported and the file already uses "${FUZZ_TARGET_EXPORT}"` };
		}
		return { ok: true, fn, localName, exportName: FUZZ_TARGET_EXPORT, exported: false };
	}
	return { ok: true, fn, localName, exportName: alias, exported: true };
}

/** Replace the lexeme at `offset` with `replacement`. */
export function applyMutant(content: string, offset: number, lexeme: string, replacement: string): string {
	return content.slice(0, offset) + replacement + content.slice(offset + lexeme.length);
}
