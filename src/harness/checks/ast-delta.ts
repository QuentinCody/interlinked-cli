// ===========================================
// AST semantic-delta profile (7c) — structural size of an edit
// ===========================================
// A rename touching 200 lines and a rewritten conditional touching 3 are not
// the same edit; textual line deltas can't tell them apart. This profile
// counts nodes by SyntaxKind so the pulse can report the STRUCTURAL size of
// an edit next to its textual size — and, over time, calibrate the cognitive
// slew constant from observed benign-edit deltas.
// Spec: docs/design/history-relational-metrics.md §3 #5 and §6.
//
// One parse, two walks: kind counts from the walk here, cognitive totals via
// cognitive-ast's tree-taking core (no second parse). Degrades to null when
// the optional `typescript` dep is absent, like every AST metric here.

import type * as TS from "typescript";
import { cognitiveEntriesFrom } from "./cognitive-ast.js";
import { parseTsSource, type TsModule } from "./cyclomatic-ast.js";

export interface AstProfile {
	/** Total node count (SourceFile excluded). */
	nodes: number;
	/** Node count per SyntaxKind name. */
	kinds: Record<string, number>;
	/** Σ cognitive across all function units. */
	cogTotal: number;
	/** Max single-function cognitive. */
	cogMax: number;
}

function kindName(ts: TsModule, kind: TS.SyntaxKind): string {
	// `ts` is loaded at runtime via `createRequire(...)("typescript")` and cast
	// to the dev-time `TsModule` type (cyclomatic-ast.ts::loadTs) — the actual
	// installed `typescript` version (an optionalDependency; any semver the
	// host project resolves) may not have a reverse-mapping entry for every
	// `kind` the type declares, so the indexer is honestly `string | undefined`
	// here, not the always-`string` the ambient .d.ts claims.
	const reverseMap = ts.SyntaxKind as unknown as Record<number, string | undefined>;
	return reverseMap[kind] ?? String(kind);
}

const JS_TS_RE = /\.[cm]?[jt]sx?$/i;

/**
 * Profile one content snapshot; null when `typescript` is unavailable or the
 * file is not JS/TS (parsing foreign syntax as TS yields nonsense counts).
 */
export function astProfile(content: string, filePath: string): AstProfile | null {
	if (!JS_TS_RE.test(filePath)) return null;
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return null;
	const { ts, sf } = parsed;

	const kinds: Record<string, number> = {};
	let nodes = 0;
	const walk = (node: TS.Node): void => {
		nodes++;
		const name = kindName(ts, node.kind);
		kinds[name] = (kinds[name] ?? 0) + 1;
		ts.forEachChild(node, walk);
	};
	ts.forEachChild(sf, walk);

	let cogTotal = 0;
	let cogMax = 0;
	for (const e of cognitiveEntriesFrom(ts, sf)) {
		cogTotal += e.cognitive;
		if (e.cognitive > cogMax) cogMax = e.cognitive;
	}
	return { nodes, kinds, cogTotal, cogMax };
}

/**
 * Structural distance between two profiles: Σ|Δcount| over the union of
 * kinds. Identifier RENAMES contribute zero (same kinds, same counts) —
 * that is the point.
 */
export function structuralDelta(before: AstProfile, after: AstProfile): number {
	let delta = 0;
	const seen = new Set<string>();
	for (const [kind, n] of Object.entries(before.kinds)) {
		seen.add(kind);
		delta += Math.abs(n - (after.kinds[kind] ?? 0));
	}
	for (const [kind, n] of Object.entries(after.kinds)) {
		if (!seen.has(kind)) delta += n;
	}
	return delta;
}
