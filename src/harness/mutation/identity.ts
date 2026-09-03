// ===========================================
// Per-edit mutation — stable identity derivation (build step 2)
// ===========================================
// Re-anchors an engine's raw line:col mutants to line-shift-invariant identities
// so "is this the same survivor as last run?" is a set-diff, not a guess. The
// crux of docs/design/per-edit-mutation-identity-and-manifest.md (§1–§2): anchor
// to the enclosing symbol + operator + token + ordinal, NEVER raw location.
//
// `typescript` is an optionalDependency (see cyclomatic-ast.ts for the identical
// load dance); absent ⇒ `mutationIdentityAvailable()` is false and the
// derivation returns null so callers degrade rather than crash. Loaded
// synchronously via createRequire; the self-contained hook never imports this.

// Stable mutant identity: the key that lets a manifest compare runs over time,
// across reorderings, and across unrelated edits made elsewhere in that file.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type * as TS from "typescript";
import { isFunctionLike, parseTsSourceWith } from "../checks/cyclomatic-ast.js";
import type { MutantIdentity, RawMutant, StableId } from "./types.js";

type TsModule = typeof TS;

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

/** True when the optional `typescript` dep is resolvable (→ identity available). */
export function mutationIdentityAvailable(): boolean {
	return loadTs() !== null;
}

/** Full digest over a NUL-delimited tuple. The delimiter is part of the
 * identity contract: `["a", "bc"]` must never alias `["ab", "c"]`. */
function sha256Parts(parts: readonly string[]): string {
	return createHash("sha256").update(parts.join("\x00")).digest("hex");
}

/** Unambiguous portable tuple encoding. V1's NUL delimiter is preserved
 * above for manifest compatibility; v2 hashes a JSON string array so a NUL in
 * a raw lexeme/replacement can never move a field boundary. */
function sha256PortableParts(parts: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

/** 16 hex chars — the legacy manifest/display identity. Do not widen this in
 * place: existing manifests are keyed by these exact values. Protocol-v3 wire
 * evidence uses the separately versioned full-width derivation below. */
function sha16(parts: readonly string[]): StableId {
	return sha256Parts(parts).slice(0, 16);
}

function parseFile(ts: TsModule, file: string, content: string): TS.SourceFile {
	return parseTsSourceWith(ts, content, file);
}

/** Token-stream canonicalisation: spacing- and comment-insensitive (spec §2). */
function normalizeTokens(ts: TsModule, text: string): string {
	const scanner = ts.createScanner(
		ts.ScriptTarget.Latest,
		/* skipTrivia */ true,
		ts.LanguageVariant.Standard,
		text,
	);
	const out: string[] = [];
	let tok = scanner.scan();
	while (tok !== ts.SyntaxKind.EndOfFileToken) {
		out.push(scanner.getTokenText());
		tok = scanner.scan();
	}
	return out.join(" ");
}

/** Best-effort local name for a function-like node (mirrors cyclomatic-ast). */
function localName(ts: TsModule, sf: TS.SourceFile, node: TS.Node): string {
	if (ts.isConstructorDeclaration(node)) return "constructor";
	const named = node as { name?: TS.Node };
	if (named.name && (ts.isIdentifier(named.name) || ts.isPrivateIdentifier(named.name))) {
		return named.name.getText(sf);
	}
	// SAFETY: `typescript`'s own .d.ts types `Node.parent` as non-optional
	// `Node`, but at runtime it is `undefined` for the SourceFile root and any
	// node visited before binding — the compiler API's well-known type lie.
	// Cast to the true runtime shape so the null guard below stays live
	// instead of reading as an impossible branch.
	const p = node.parent as TS.Node | undefined;
	if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.getText(sf);
	if (p && ts.isPropertyAssignment(p)) return p.name.getText(sf);
	if (p && ts.isPropertyDeclaration(p)) return p.name.getText(sf);
	return "(anonymous)";
}

/** The pseudo-symbol every mutant with no enclosing function anchors to:
 *  top-level statements, class-property initializers, decorators. Arity is 0 by
 *  construction, so `symbolIdFor(file, MODULE_QUALIFIED_NAME, 0)` is the one key
 *  both the anchoring step and the hash map must agree on. */
const MODULE_QUALIFIED_NAME = "(module)";

/** Qualified name "Outer.method" by walking enclosing classes / functions / namespaces. */
function qualifiedName(ts: TsModule, sf: TS.SourceFile, node: TS.Node): string {
	const parts: string[] = [];
	let cur: TS.Node | undefined = node;
	while (cur) {
		if (isFunctionLike(ts, cur)) parts.unshift(localName(ts, sf, cur));
		else if (ts.isClassDeclaration(cur) && cur.name) parts.unshift(cur.name.getText(sf));
		else if (ts.isModuleDeclaration(cur)) parts.unshift(cur.name.getText(sf));
		// SAFETY: see the `Node.parent` type-lie note in `localName` above —
		// `.parent` is typed `Node` but is `undefined` at the SourceFile root.
		cur = cur.parent as TS.Node | undefined;
	}
	return parts.length > 0 ? parts.join(".") : MODULE_QUALIFIED_NAME;
}

function arityOf(node: TS.Node): number {
	return (node as TS.FunctionLikeDeclaration).parameters.length;
}

function symbolIdFor(file: string, qualified: string, arity: number): StableId {
	return sha16([file, qualified, String(arity)]);
}

/** Deepest function-like node whose span contains `offset`, or null (top level). */
function enclosingFunction(ts: TsModule, sf: TS.SourceFile, offset: number): TS.Node | null {
	let best: TS.Node | null = null;
	const visit = (node: TS.Node): void => {
		if (offset < node.getStart(sf) || offset >= node.getEnd()) return;
		if (isFunctionLike(ts, node)) best = node;
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return best;
}

interface ResolvedSite {
	symbolId: StableId;
	qualifiedName: string;
	symbolContext: string;
	arity: number;
}

function anonymousContextOrdinal(ts: TsModule, sf: TS.SourceFile, target: TS.Node): number {
	let boundary: TS.Node = sf;
	// SAFETY: see the `Node.parent` type-lie note in `localName` above —
	// `.parent` is typed `Node` but is `undefined` at the SourceFile root.
	let cursor = target.parent as TS.Node | undefined;
	while (cursor && cursor !== sf) {
		if (
			(isFunctionLike(ts, cursor) && localName(ts, sf, cursor) !== "(anonymous)") ||
			ts.isClassDeclaration(cursor) ||
			ts.isModuleDeclaration(cursor)
		) {
			boundary = cursor;
			break;
		}
		cursor = cursor.parent;
	}
	let ordinal = 0;
	let answer = 0;
	const visit = (node: TS.Node): void => {
		if (node !== boundary) {
			// A pruned node opens its OWN anonymous-numbering context, so neither
			// it nor its subtree participates in this walk.
			if (prunesOrdinalWalk(ts, sf, node)) return;
			// Anything function-like still standing is anonymous — the named case
			// was pruned above — so this is the next ordinal in the context.
			if (isFunctionLike(ts, node)) {
				if (node === target) answer = ordinal;
				ordinal++;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(boundary);
	return answer;
}

/** Whether `node` and its subtree are excluded from the enclosing context's
 *  anonymous-ordinal walk. A nested class or namespace, and any NAMED
 *  function, starts a numbering context of its own; only anonymous
 *  function-like nodes are counted by the caller. Extracted from `visit` so
 *  the walk reads as prune-then-count instead of three nested conditionals. */
function prunesOrdinalWalk(ts: TsModule, sf: TS.SourceFile, node: TS.Node): boolean {
	if (ts.isClassDeclaration(node) || ts.isModuleDeclaration(node)) return true;
	return isFunctionLike(ts, node) && localName(ts, sf, node) !== "(anonymous)";
}

/** Stable disambiguator for symbols whose display name is not unique. Named
 * symbols keep their established qualified-name anchor. Anonymous/computed
 * symbols gain a preorder ordinal inside the nearest named function/class/
 * namespace; changing that ordinal necessarily changes the containing symbol
 * and therefore belongs to the changed region. */
function portableSymbolContext(ts: TsModule, sf: TS.SourceFile, node: TS.Node | null, qn: string): string {
	if (node === null || localName(ts, sf, node) !== "(anonymous)") return qn;
	return `${qn}#anonymous-${anonymousContextOrdinal(ts, sf, node)}`;
}

function resolveSite(ts: TsModule, sf: TS.SourceFile, file: string, offset: number): ResolvedSite {
	const fn = enclosingFunction(ts, sf, offset);
	const qn = fn ? qualifiedName(ts, sf, fn) : MODULE_QUALIFIED_NAME;
	const arity = fn ? arityOf(fn) : 0;
	return {
		symbolId: symbolIdFor(file, qn, arity),
		qualifiedName: qn,
		symbolContext: portableSymbolContext(ts, sf, fn, qn),
		arity,
	};
}

function groupKey(symbolId: StableId, mutator: string, lexeme: string): string {
	return `${symbolId}\x00${mutator}\x00${lexeme}`;
}

/**
 * Re-anchor a file's raw mutants to stable identities. Ordinal is the rank of a
 * site's DISTINCT UTF-16 code-unit offset within its
 * (symbol, mutator, lexeme) group —
 * so two mutants at one token (same offset, different replacement) share a
 * `siteId` and differ only in `mutantId`. Returns null when typescript is absent.
 */
export function deriveIdentities(
	file: string,
	content: string,
	rawMutants: RawMutant[],
): MutantIdentity[] | null {
	const ts = loadTs();
	if (!ts) return null;
	const sf = parseFile(ts, file, content);

	const resolved = rawMutants.map((raw) => ({ raw, site: resolveSite(ts, sf, file, raw.startOffset) }));

	// ordinal = rank of distinct offset within each (symbol, mutator, lexeme) group
	const offsetsByGroup = new Map<string, Set<number>>();
	for (const r of resolved) {
		const key = groupKey(r.site.symbolId, r.raw.mutator, r.raw.originalLexeme);
		const set = offsetsByGroup.get(key) ?? new Set<number>();
		set.add(r.raw.startOffset);
		offsetsByGroup.set(key, set);
	}
	const rankByGroup = new Map<string, Map<number, number>>();
	for (const [key, set] of offsetsByGroup) {
		const sorted = [...set].sort((a, b) => a - b);
		rankByGroup.set(key, new Map(sorted.map((o, i) => [o, i])));
	}

	return resolved.map((r) => {
		const key = groupKey(r.site.symbolId, r.raw.mutator, r.raw.originalLexeme);
		const ordinal = rankByGroup.get(key)?.get(r.raw.startOffset) ?? 0;
		const siteId = sha16([r.site.symbolId, r.raw.mutator, r.raw.originalLexeme, String(ordinal)]);
		return {
			mutantId: sha16([siteId, r.raw.replacement]),
			siteId,
			symbolId: r.site.symbolId,
			qualifiedName: r.site.qualifiedName,
			mutator: r.raw.mutator,
			originalLexeme: r.raw.originalLexeme,
			replacement: r.raw.replacement,
			ordinalWithinSymbol: ordinal,
		};
	});
}

/**
 * Full-width wire identity used by mutation protocol v3.
 *
 * This is deliberately a NEW algorithm rather than a widening of v1. The
 * local v1 manifest hashes truncated symbol and site identifiers into their
 * descendants, so a 64-character value emitted under the old algorithm name
 * would still inherit a 64-bit intermediate collision boundary. V2 keeps the
 * same semantic tuple and ordinal rules but carries full SHA-256 at every
 * level. The CLI can therefore verify paid/cloud evidence without trusting an
 * engine-local id while continuing to derive the unchanged v1 manifest keys.
 */
export const PORTABLE_IDENTITY_ALGORITHM = "interlinked-site-v2" as const;

export interface PortableMutantIdentity {
	mutantId: string;
	siteId: string;
	symbolId: string;
	qualifiedName: string;
	symbolContext: string;
	mutator: string;
	originalLexeme: string;
	replacement: string;
	ordinalWithinSymbol: number;
}

/** Recompute the portable protocol-v3 identities from LOCAL target content.
 * Returns null when the TypeScript parser is unavailable, matching the legacy
 * derivation's honest-degradation contract. */
export function derivePortableIdentities(
	file: string,
	content: string,
	rawMutants: RawMutant[],
): PortableMutantIdentity[] | null {
	const ts = loadTs();
	if (!ts) return null;
	const sf = parseFile(ts, file, content);
	const resolved = rawMutants.map((raw) => ({ raw, site: resolveSite(ts, sf, file, raw.startOffset) }));

	const offsetsByGroup = new Map<string, Set<number>>();
	for (const row of resolved) {
		const fullSymbolId = sha256PortableParts([file, row.site.symbolContext, String(row.site.arity)]);
		const key = groupKey(fullSymbolId, row.raw.mutator, row.raw.originalLexeme);
		const offsets = offsetsByGroup.get(key) ?? new Set<number>();
		offsets.add(row.raw.startOffset);
		offsetsByGroup.set(key, offsets);
	}
	const rankByGroup = new Map<string, Map<number, number>>();
	for (const [key, offsets] of offsetsByGroup) {
		const sorted = [...offsets].sort((a, b) => a - b);
		rankByGroup.set(key, new Map(sorted.map((offset, ordinal) => [offset, ordinal])));
	}

	return resolved.map((row) => {
		const symbolId = sha256PortableParts([file, row.site.symbolContext, String(row.site.arity)]);
		const key = groupKey(symbolId, row.raw.mutator, row.raw.originalLexeme);
		const ordinal = rankByGroup.get(key)?.get(row.raw.startOffset) ?? 0;
		const siteId = sha256PortableParts([
			symbolId,
			row.raw.mutator,
			row.raw.originalLexeme,
			String(ordinal),
		]);
		return {
			mutantId: sha256PortableParts([siteId, row.raw.replacement]),
			siteId,
			symbolId,
			qualifiedName: row.site.qualifiedName,
			symbolContext: row.site.symbolContext,
			mutator: row.raw.mutator,
			originalLexeme: row.raw.originalLexeme,
			replacement: row.raw.replacement,
			ordinalWithinSymbol: ordinal,
		};
	});
}

export interface SymbolHashEntry {
	qualifiedName: string;
	symbolHash: string;
}

/** The function-like nodes hashed as their own symbol — i.e. exactly the subtrees
 *  module scope must EXCLUDE. A bodiless function-like (an overload / ambient
 *  signature) is not one: it carries no expression an engine can rewrite, so no
 *  mutant anchors inside it. */
function isHashedFunction(ts: TsModule, node: TS.Node): boolean {
	return isFunctionLike(ts, node) && (node as TS.FunctionLikeDeclaration).body !== undefined;
}

/** Half-open spans of the OUTERMOST hashed functions, in source order. Nested
 *  ones live inside these, so excluding the outermost excludes them all. */
function hashedFunctionSpans(ts: TsModule, sf: TS.SourceFile): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	const walk = (node: TS.Node): void => {
		if (isHashedFunction(ts, node)) {
			spans.push([node.getStart(sf), node.getEnd()]);
			return;
		}
		ts.forEachChild(node, walk);
	};
	ts.forEachChild(sf, walk);
	return spans;
}

/** The file's text minus the subtrees hashed as their own symbols — the source a
 *  `(module)` mutant can actually live in. Coarse by design: ONE hash over all of
 *  module scope means any top-level edit re-measures every module-scope mutant,
 *  which is safe (over-invalidation), whereas a missing hash is not (spec §3;
 *  plan 16 §11.1 fix 1). Segments are joined with a newline so excising a
 *  function can never fuse two adjacent tokens into one. */
function moduleScopeText(ts: TsModule, sf: TS.SourceFile): string {
	const full = sf.text;
	const parts: string[] = [];
	let cursor = 0;
	for (const [start, end] of hashedFunctionSpans(ts, sf)) {
		parts.push(full.slice(cursor, start));
		cursor = end;
	}
	parts.push(full.slice(cursor));
	return parts.join("\n");
}

/**
 * Per-symbol normalized-source hashes for a file — the differential-skip /
 * changed-region key (spec §3). Covers every function-like symbol WITH a body,
 * plus the `(module)` pseudo-symbol for whatever top-level source is left over
 * (omitted when that is empty, e.g. a file of nothing but functions).
 *
 * This map is the SYMBOL UNIVERSE the manifest is rebuilt from: `applyMeasuredRun`
 * iterates it, so a measured mutant whose symbolId is missing here is discarded
 * without a trace. Since `resolveSite` anchors every mutant with no enclosing
 * function to `(module)`, omitting that entry silently dropped module-scope
 * mutants (plan 16 §11.1). Returns null when typescript is absent.
 */
export function computeSymbolHashes(
	file: string,
	content: string,
): Map<StableId, SymbolHashEntry> | null {
	const ts = loadTs();
	if (!ts) return null;
	const sf = parseFile(ts, file, content);
	const out = new Map<StableId, SymbolHashEntry>();
	const walk = (node: TS.Node): void => {
		if (isHashedFunction(ts, node)) {
			const qn = qualifiedName(ts, sf, node);
			out.set(symbolIdFor(file, qn, arityOf(node)), {
				qualifiedName: qn,
				symbolHash: sha16([normalizeTokens(ts, node.getText(sf))]),
			});
		}
		ts.forEachChild(node, walk);
	};
	walk(sf);
	const moduleTokens = normalizeTokens(ts, moduleScopeText(ts, sf));
	if (moduleTokens.length > 0) {
		out.set(symbolIdFor(file, MODULE_QUALIFIED_NAME, 0), {
			qualifiedName: MODULE_QUALIFIED_NAME,
			symbolHash: sha16([moduleTokens]),
		});
	}
	return out;
}
