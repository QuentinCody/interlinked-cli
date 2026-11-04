// Semantic graph — deterministic candidate generation. A relationship type names
// its rules in order; `candidatesFor` applies them until `k` target-kind units are
// found. Every rule is a lookup into an index built once per run; git and the
// project graph are injected so tests never shell out or scan a tree.
// Contract: ./types.ts.

import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative } from "node:path";
import { computeCoupling, type CouplingPair, parseNameOnlyLog } from "../../commands/metrics-coupling.js";
import { ProjectGraph } from "../project-graph.js";
import type { ImportEdge } from "../types.js";
import type { CandidateRule, RelationshipType, Unit, UnitKind } from "./types.js";

/** The two graph lookups a rule needs; `ProjectGraph` satisfies it, a test double can too. */
export interface ImportGraphView {
	getDependencies(file: string): ImportEdge[];
	getDependents(file: string): string[];
}

export interface CandidateDeps {
	/** Absent ⇒ a `ProjectGraph` is built and initialized over `cwd`. */
	graph?: ImportGraphView;
	/** file ⇒ co-changed files, strongest first; absent ⇒ `co_change` yields nothing. */
	coChange?: Map<string, string[]>;
}

export interface CandidateIndex {
	cwd: string;
	/** file ⇒ its units in line order. */
	byFile: Map<string, Unit[]>;
	/** kind ⇒ every unit of that kind in file-then-line order. */
	byKind: Map<UnitKind, Unit[]>;
	/** unit id ⇒ identifier tokens of its name (length ≥ 4, lower-cased). */
	tokens: Map<string, Set<string>>;
	/** file ⇒ files it imports followed by files that import it. */
	linked: Map<string, string[]>;
	coChange: Map<string, string[]>;
	/** companion key ⇒ files sharing the stem. */
	byCompanionKey: Map<string, string[]>;
}

/** Shortest token that counts as shared identity: `get`, `set`, `run` carry no signal. */
const MIN_TOKEN_LENGTH = 4;
const TEST_SUFFIX_RE = /\.(test|spec)(?=\.[^.]+$)/i;
const EXT_RE = /\.[^./]+$/;

/** Identifier tokens after camelCase / snake_case / kebab / dotted splits. */
export function nameTokens(name: string): Set<string> {
	const spaced = name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
	const out = new Set<string>();
	for (const raw of spaced.split(/[^A-Za-z0-9]+/)) {
		const token = raw.toLowerCase();
		if (token.length >= MIN_TOKEN_LENGTH) out.add(token);
	}
	return out;
}

export function isTestFile(file: string): boolean {
	return TEST_SUFFIX_RE.test(file) || file.includes("/__tests__/");
}

/** `x.test.ts`, `__tests__/x.test.ts`, and `x.ts` all share the key `<dir>/x`. */
export function companionKey(file: string): string {
	return file.replace(/\/__tests__\//, "/").replace(TEST_SUFFIX_RE, "").replace(EXT_RE, "");
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const row = map.get(key);
	if (row) row.push(value);
	else map.set(key, [value]);
}

function toRelative(cwd: string, file: string): string {
	return (isAbsolute(file) ? relative(cwd, file) : file).replace(/\\/g, "/");
}

function linkedFiles(cwd: string, graph: ImportGraphView, file: string): string[] {
	const abs = join(cwd, file);
	const out: string[] = [];
	for (const edge of graph.getDependencies(abs)) out.push(toRelative(cwd, edge.toFile));
	for (const dependent of graph.getDependents(abs)) out.push(toRelative(cwd, dependent));
	return [...new Set(out)].filter((other) => other !== file);
}

function byLineThenFile(a: Unit, b: Unit): number {
	return a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1;
}

export function buildCandidateIndex(units: readonly Unit[], cwd: string, deps: CandidateDeps = {}): CandidateIndex {
	const sorted = [...units].sort(byLineThenFile);
	const index: CandidateIndex = {
		cwd,
		byFile: new Map(),
		byKind: new Map(),
		tokens: new Map(),
		linked: new Map(),
		coChange: deps.coChange ?? new Map(),
		byCompanionKey: new Map(),
	};
	for (const unit of sorted) {
		append(index.byFile, unit.file, unit);
		append(index.byKind, unit.kind, unit);
		index.tokens.set(unit.id, nameTokens(unit.name));
	}
	const graph = deps.graph ?? initializedGraph(cwd);
	for (const file of index.byFile.keys()) {
		index.linked.set(file, linkedFiles(cwd, graph, file));
		append(index.byCompanionKey, companionKey(file), file);
	}
	return index;
}

function initializedGraph(cwd: string): ProjectGraph {
	const graph = new ProjectGraph(cwd);
	graph.initialize();
	return graph;
}

function unitsIn(index: CandidateIndex, files: readonly string[], kind: UnitKind): Unit[] {
	const out: Unit[] = [];
	for (const file of files) {
		for (const unit of index.byFile.get(file) ?? []) if (unit.kind === kind) out.push(unit);
	}
	return out;
}

function sameFile(source: Unit, kind: UnitKind, index: CandidateIndex): Unit[] {
	return unitsIn(index, [source.file], kind).sort(
		(a, b) => Math.abs(a.line - source.line) - Math.abs(b.line - source.line) || a.line - b.line,
	);
}

function nameMatch(source: Unit, kind: UnitKind, index: CandidateIndex): Unit[] {
	const own = index.tokens.get(source.id) ?? nameTokens(source.name);
	if (own.size === 0) return [];
	const scored: Array<{ unit: Unit; overlap: number }> = [];
	for (const unit of index.byKind.get(kind) ?? []) {
		const tokens = index.tokens.get(unit.id) ?? nameTokens(unit.name);
		let overlap = 0;
		for (const token of own) if (tokens.has(token)) overlap++;
		if (overlap > 0) scored.push({ unit, overlap });
	}
	return scored.sort((a, b) => b.overlap - a.overlap || byLineThenFile(a.unit, b.unit)).map((s) => s.unit);
}

function companions(source: Unit, kind: UnitKind, index: CandidateIndex): Unit[] {
	const sourceIsTest = isTestFile(source.file);
	const files = (index.byCompanionKey.get(companionKey(source.file)) ?? []).filter(
		(file) => file !== source.file && isTestFile(file) !== sourceIsTest,
	);
	return unitsIn(index, files, kind);
}

function ruleCandidates(rule: CandidateRule, source: Unit, kind: UnitKind, index: CandidateIndex): Unit[] {
	switch (rule) {
		case "same_file":
			return sameFile(source, kind, index);
		case "import_edge":
			return unitsIn(index, index.linked.get(source.file) ?? [], kind);
		case "name_match":
			return nameMatch(source, kind, index);
		case "co_change":
			return unitsIn(index, index.coChange.get(source.file) ?? [], kind);
		case "companion":
			return companions(source, kind, index);
	}
}

/** Rules in declared order, deduplicated, never the source, at most `type.k`.
 *  A type that does not list `same_file` is a cross-file relationship: no rule
 *  of it yields a unit from the source's own file. */
export function candidatesFor(source: Unit, type: RelationshipType, index: CandidateIndex): Unit[] {
	const crossFileOnly = !type.candidate_rules.includes("same_file");
	const seen = new Set<string>([source.id]);
	const out: Unit[] = [];
	for (const rule of type.candidate_rules) {
		for (const unit of ruleCandidates(rule, source, type.target_kind, index)) {
			if (out.length >= type.k) return out;
			if (seen.has(unit.id) || (crossFileOnly && unit.file === source.file)) continue;
			seen.add(unit.id);
			out.push(unit);
		}
	}
	return out;
}

/** file ⇒ partners ordered by Tornhill strength (both directions of every pair). */
export function coChangeFromPairs(pairs: readonly CouplingPair[]): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const pair of [...pairs].sort((x, y) => y.strength - x.strength || y.support - x.support)) {
		append(map, pair.a, pair.b);
		append(map, pair.b, pair.a);
	}
	return map;
}

export interface CoChangeOptions {
	minSupport?: number;
	maxCommitFiles?: number;
	minStrength?: number;
	/** Injectable `git log` runner; the default shells out. */
	runGit?: (args: string[]) => string;
}

function defaultRunGit(cwd: string): (args: string[]) => string {
	return (args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Co-change map from git history since `since` (a `git log --since` value). Not for the hook path. */
export function coChangeFromGit(cwd: string, since: string, opts: CoChangeOptions = {}): Map<string, string[]> {
	const runGit = opts.runGit ?? defaultRunGit(cwd);
	const text = runGit(["log", "--no-merges", `--since=${since}`, "--name-only", "--pretty=format:%H\t%ct"]);
	const pairs = computeCoupling(parseNameOnlyLog(text), {
		minSupport: opts.minSupport ?? 2,
		maxCommitFiles: opts.maxCommitFiles ?? 30,
		minStrength: opts.minStrength ?? 0,
	});
	return coChangeFromPairs(pairs);
}
