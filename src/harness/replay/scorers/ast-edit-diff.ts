// ===========================================
// T1 scorer — structural edit distance
// ===========================================
// String cosine on code is noise; this scores edits STRUCTURALLY. The TS
// compiler is runtime-loaded exactly the way the cyclomatic gate loads it
// (checks/cyclomatic-ast.ts: createRequire of the optionalDependency —
// tsgo has no importable JS API), each source flattens to a multiset of
// (SyntaxKind[:identifier-text]) buckets, and the distance is the symmetric
// difference — zero for pure formatting churn, small for renames, large for
// rewrites. Bash actions score by argv token multiset. When `typescript` is
// absent (--omit=optional installs) the scorer says comparable:false rather
// than fabricating a number
// (docs/design/reproducibility/tier1-teacher-forced-eval.md).

import { createRequire } from "node:module";
import type * as TS from "typescript";
import { parseTsSourceWith } from "../../checks/cyclomatic-ast.js";
import type { JsonObject } from "../../../lib/json-types.js";

let tsCache: typeof TS | null | undefined;

function loadTs(): typeof TS | null {
	if (tsCache !== undefined) return tsCache;
	try {
		// SAFETY: createRequire loads the installed optional TypeScript package,
		// whose runtime API is described by the type-only import above.
		tsCache = createRequire(import.meta.url)("typescript") as typeof TS;
	} catch (err) {
		void err; // optional dependency absent — scorer degrades to comparable:false
		tsCache = null;
	}
	return tsCache;
}

export function astAvailable(): boolean {
	return loadTs() !== null;
}

export interface StructuralDistance {
	comparable: boolean;
	/** Symmetric-difference size between the two node multisets. */
	distance: number;
	/** distance / (|A| + |B|) — 0 identical, 1 disjoint. */
	normalized: number;
}

function multisetFromSource(ts: typeof TS, source: string): Map<string, number> {
	const file = parseTsSourceWith(ts, source, "scored.ts");
	const buckets = new Map<string, number>();
	const visit = (node: TS.Node): void => {
		let key = ts.SyntaxKind[node.kind];
		if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
			key = `${key}:${node.text}`;
		}
		buckets.set(key, (buckets.get(key) ?? 0) + 1);
		ts.forEachChild(node, visit);
	};
	visit(file);
	return buckets;
}

function multisetDistance(a: Map<string, number>, b: Map<string, number>): StructuralDistance {
	let sizeA = 0;
	let sizeB = 0;
	let diff = 0;
	for (const count of a.values()) sizeA += count;
	for (const count of b.values()) sizeB += count;
	const keys = new Set([...a.keys(), ...b.keys()]);
	for (const key of keys) {
		diff += Math.abs((a.get(key) ?? 0) - (b.get(key) ?? 0));
	}
	const total = sizeA + sizeB;
	return { comparable: true, distance: diff, normalized: total === 0 ? 0 : diff / total };
}

/** Structural distance between two code texts. Formatting-insensitive by
 *  construction (whitespace never reaches the multiset). */
export function astEditDistance(oldSource: string, newSource: string): StructuralDistance {
	const ts = loadTs();
	if (!ts) return { comparable: false, distance: 0, normalized: 0 };
	return multisetDistance(multisetFromSource(ts, oldSource), multisetFromSource(ts, newSource));
}

/** Argv token multiset distance for shell commands (order-insensitive —
 *  flag position is noise, flag PRESENCE is signal). */
export function argvDistance(commandA: string, commandB: string): StructuralDistance {
	const toMultiset = (cmd: string): Map<string, number> => {
		const m = new Map<string, number>();
		for (const token of cmd.split(/\s+/).filter(Boolean)) {
			m.set(token, (m.get(token) ?? 0) + 1);
		}
		return m;
	};
	return multisetDistance(toMultiset(commandA), toMultiset(commandB));
}

export interface RoutedStructuralScore extends StructuralDistance {
	kind: "ast" | "argv";
}

interface ScorableAction {
	tool: string | null;
	input: JsonObject | null;
}

function editText(tool: string, input: JsonObject | null): string | null {
	if (!input) return null;
	if (tool === "Edit" && typeof input.new_string === "string") return input.new_string;
	if (tool === "Write" && typeof input.content === "string") return input.content;
	return null;
}

/** Route a reference/candidate action pair to the right structural scorer.
 *  Returns null when the tools differ (action-match already covers that) or
 *  the tool isn't structurally modeled. */
export function scoreEditActions(
	ref: ScorableAction,
	cand: ScorableAction,
): RoutedStructuralScore | null {
	if (ref.tool === null || ref.tool !== cand.tool) return null;
	if (ref.tool === "Bash") {
		const a = typeof ref.input?.command === "string" ? ref.input.command : "";
		const b = typeof cand.input?.command === "string" ? cand.input.command : "";
		return { kind: "argv", ...argvDistance(a, b) };
	}
	const refText = editText(ref.tool, ref.input);
	const candText = editText(ref.tool, cand.input);
	if (refText === null || candText === null) return null;
	return { kind: "ast", ...astEditDistance(refText, candText) };
}
