// interlinked-tdd: exempt
// ===========================================
// Istanbul → canonical element sets
// ===========================================
// Pure canonicalization helpers split out of vitest.ts to keep both modules
// under the per-file line cap. This is a leaf cluster: it depends only on its
// own logic, node builtins, and the coverage-index element-set type — nothing
// in vitest.ts imports back into here, so there is no cycle.

import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import type { CanonicalCoverageElementSet } from "../coverage-index/types.js";

/**
 * Istanbul's per-id location/hit-count maps (`statementMap`, `s`, `branchMap`,
 * `b`, `fnMap`, `f`). Ids are opaque generated keys, so the map itself stays
 * open-shaped; individual entries are validated where they are read
 * ({@link locLine}, {@link locColumn}, and the per-entry checks in
 * {@link branchElements} / {@link functionElements}).
 */
type IstanbulIdMap = JsonObject;

/** One istanbul file-coverage entry, after unwrapping any `{data: …}` envelope. */
interface IstanbulFileCoverage {
	path?: string;
statementMap: IstanbulIdMap;
	s: IstanbulIdMap;
	branchMap?: IstanbulIdMap;
	b?: IstanbulIdMap;
	fnMap?: IstanbulIdMap;
	f?: IstanbulIdMap;
}

export function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Optional record field of `raw`, or `undefined` when absent/malformed. */
function optionalRecord(raw: JsonObject, key: string): IstanbulIdMap | undefined {
	return isRecord(raw[key]) ? raw[key] : undefined;
}

/** Parse a FileCoverage envelope ({data: …}) or plain entry, or null when malformed. */
function parseFileCoverage(raw: unknown): IstanbulFileCoverage | null {
	if (!isRecord(raw)) return null;
	const candidate = !isRecord(raw.statementMap) && isRecord(raw.data) ? raw.data : raw;
	if (!isRecord(candidate)) return null;
	const { statementMap, s } = candidate;
	if (!isRecord(statementMap) || !isRecord(s)) return null;
	const branchMap = optionalRecord(candidate, "branchMap");
	const b = optionalRecord(candidate, "b");
	const fnMap = optionalRecord(candidate, "fnMap");
	const f = optionalRecord(candidate, "f");
	const path = typeof candidate.path === "string" ? candidate.path : undefined;
	return {
		statementMap,
		s,
		...(branchMap !== undefined && { branchMap }),
		...(b !== undefined && { b }),
		...(fnMap !== undefined && { fnMap }),
		...(f !== undefined && { f }),
		...(path !== undefined && { path }),
	};
}

/** A `{start: {line, column}}` location's line, or null. */
function locLine(raw: unknown): number | null {
	if (!isRecord(raw)) return null;
	const start = raw.start;
	if (!isRecord(start) || typeof start.line !== "number") return null;
	return start.line;
}

function locColumn(raw: unknown): number {
	if (isRecord(raw) && isRecord(raw.start) && typeof raw.start.column === "number") {
		return raw.start.column;
	}
	return 0;
}

/** A path with symlinks resolved when it exists; the input untouched otherwise. */
export function canonicalPath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * Repo-relative POSIX path for an istanbul file key, or null when outside.
 * Both sides are symlink-canonicalized before comparing: on macOS `tmpdir()`
 * roots live under `/var/folders/…` while vitest realpaths everything to
 * `/private/var/…`, and an un-canonicalized comparison silently drops every
 * file as "outside the root".
 */
function relFor(rawPath: string, projectRoot: string): string | null {
	const norm = rawPath.replace(/\\/g, "/");
	if (!isAbsolute(norm)) return norm || null;
	const rel = relative(canonicalPath(projectRoot), canonicalPath(norm)).replace(/\\/g, "/");
	if (!rel || rel.startsWith("..")) return null;
	return rel;
}

/**
 * Lines + statement elements from istanbul statement data. Per-line value is
 * the MAX of the hits of statements starting on that line — istanbul's own
 * getLineCoverage semantics, so the index and istanbul reports can never
 * disagree about what a "covered line" means.
 */
function lineAndStatementElements(
	statementMap: IstanbulIdMap,
	s: IstanbulIdMap,
): { lines: Map<number, number>; statements: Map<string, number> } {
	const lines = new Map<number, number>();
	const statements = new Map<string, number>();
	for (const [id, loc] of Object.entries(statementMap)) {
		const line = locLine(loc);
		const hits = s[id];
		if (line === null || typeof hits !== "number") continue;
		lines.set(line, Math.max(lines.get(line) ?? 0, hits));
		statements.set(`${line}:${locColumn(loc)}`, hits);
	}
	return { lines, statements };
}

/** Record one istanbul branch entry's per-path hit counts into `branches`. */
function recordBranchPathHits(
	branches: Map<string, number>,
	id: string,
	branch: JsonObject,
	hitsArr: unknown[],
): void {
	const locations = Array.isArray(branch.locations) ? branch.locations : [];
	const fallbackLine = typeof branch.line === "number" ? branch.line : (locLine(branch.loc) ?? 0);
	for (let i = 0; i < hitsArr.length; i++) {
		const hits = hitsArr[i];
		if (typeof hits !== "number") continue;
		branches.set(`${locLine(locations[i]) ?? fallbackLine}:${id}:${i}`, hits);
	}
}

/** Branch elements keyed `line:branchId:pathIndex` from istanbul branch data. */
function branchElements(fc: IstanbulFileCoverage): Map<string, number> {
	const branches = new Map<string, number>();
	const branchMap = fc.branchMap;
	const b = fc.b;
	if (!branchMap || !b) return branches;
	for (const [id, branch] of Object.entries(branchMap)) {
		if (!isRecord(branch)) continue;
		const hitsArr = b[id];
		if (!Array.isArray(hitsArr)) continue;
		recordBranchPathHits(branches, id, branch, hitsArr);
	}
	return branches;
}

/** Function elements keyed `name@declLine` from istanbul function data. */
function functionElements(fc: IstanbulFileCoverage): Map<string, number> {
	const functions = new Map<string, number>();
	const fnMap = fc.fnMap;
	const f = fc.f;
	if (!fnMap || !f) return functions;
	for (const [id, fn] of Object.entries(fnMap)) {
		if (!isRecord(fn)) continue;
		const hits = f[id];
		if (typeof hits !== "number") continue;
		const name = typeof fn.name === "string" && fn.name ? fn.name : `(anonymous_${id})`;
		functions.set(`${name}@${locLine(fn.decl) ?? locLine(fn.loc) ?? 0}`, hits);
	}
	return functions;
}

/** One valid istanbul file entry → a canonical element set. */
function elementSetFromIstanbul(fc: IstanbulFileCoverage): CanonicalCoverageElementSet {
	const { lines, statements } = lineAndStatementElements(fc.statementMap, fc.s);
	const set: CanonicalCoverageElementSet = {
		lines,
		branches: branchElements(fc),
		functions: functionElements(fc),
	};
	if (statements.size > 0) set.statements = statements;
	return set;
}

/**
 * Canonicalize an istanbul coverage-data object (one capture record's
 * `istanbul` field, or a parsed `coverage-final.json`) into per-file element
 * sets keyed by repo-relative POSIX path. Malformed entries and files outside
 * the project root are skipped — partial data never throws.
 */
export function istanbulToElementSets(
	data: unknown,
	projectRoot: string,
): Map<string, CanonicalCoverageElementSet> {
	const out = new Map<string, CanonicalCoverageElementSet>();
	if (!isRecord(data)) return out;
	for (const [key, rawEntry] of Object.entries(data)) {
		const fc = parseFileCoverage(rawEntry);
		if (!fc) continue;
		const rel = relFor(fc.path ?? key, projectRoot);
		if (!rel) continue;
		out.set(rel, elementSetFromIstanbul(fc));
	}
	return out;
}
