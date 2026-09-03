// ===========================================
// interlinked metrics coupling — change coupling from git history
// ===========================================
// Tornhill's logical coupling: files that change in the same commits, whether
// or not any import connects them. Pairs with NO import edge either way
// ("hidden") are the signal — an undeclared contract the AST cannot see.
// Spec: docs/design/history-relational-metrics.md §3 #1.
//
// On-demand command only: it shells to `git log` (hundreds of ms), which is
// cmd-tier cost, never hook-tier. The core below the subprocess is pure and
// unit-tested; the graph annotation fails open to "unknown" rather than
// failing the command.

import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { ProjectGraph } from "../harness/project-graph.js";
import { getOutputMode, output } from "../lib/output.js";

export interface CommitFiles {
	sha: string;
	timestamp: number;
	files: string[];
}

export interface CouplingOptions {
	minSupport: number;
	/** Commits touching more files than this are skipped entirely (bulk refactors dominate pair counts otherwise). */
	maxCommitFiles: number;
	/** Percentage floor on Tornhill strength. */
	minStrength: number;
}

export interface CouplingPair {
	a: string;
	b: string;
	/** Commits touching both files. */
	support: number;
	revA: number;
	revB: number;
	/** support / mean(revA, revB), as a rounded percentage. */
	strength: number;
}

export type CouplingRelation = "companion" | "linked" | "hidden" | "unknown";

export interface AnnotatedCouplingPair extends CouplingPair {
	relation: CouplingRelation;
}

const HEADER_RE = /^(\S+)\t(\d+)$/;

/** Parse `git log --pretty=format:%H%x09%ct --name-only` output. */
export function parseNameOnlyLog(text: string): CommitFiles[] {
	const commits: CommitFiles[] = [];
	let cur: CommitFiles | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "") {
			if (cur) commits.push(cur);
			cur = null;
			continue;
		}
		const header = HEADER_RE.exec(line);
		if (header?.[1] && header[2]) {
			if (cur) commits.push(cur);
			cur = { sha: header[1], timestamp: Number(header[2]), files: [] };
			continue;
		}
		if (cur) cur.files.push(line);
	}
	if (cur) commits.push(cur);
	return commits;
}

/**
 * Fold one commit's files into the running rev counts and pairwise support
 * counts. Skips commits with no files, or bulk commits over the file-count
 * ceiling (they'd dominate pair counts with refactor noise).
 */
function accumulateCommitCoupling(
	commit: CommitFiles,
	opts: CouplingOptions,
	revs: Map<string, number>,
	pairSupport: Map<string, Map<string, number>>,
): void {
	const files = [...new Set(commit.files)].sort();
	if (files.length === 0 || files.length > opts.maxCommitFiles) return;
	for (const f of files) revs.set(f, (revs.get(f) ?? 0) + 1);
	for (const [i, a] of files.entries()) {
		const row = pairSupport.get(a) ?? new Map<string, number>();
		pairSupport.set(a, row);
		for (const b of files.slice(i + 1)) row.set(b, (row.get(b) ?? 0) + 1);
	}
}

/** Pairwise co-change counts over non-bulk commits, Tornhill strength, filtered + sorted. */
export function computeCoupling(commits: CommitFiles[], opts: CouplingOptions): CouplingPair[] {
	const revs = new Map<string, number>();
	// Nested map rather than a `${a}\x00${b}` string key: no byte is impossible in a
	// path, so a flattened key is lossy — it both mis-reports the pair identity (the
	// split hands back substrings that were never inputs) and collides two distinct
	// pairs onto one support count.
	const pairSupport = new Map<string, Map<string, number>>();
	for (const commit of commits) accumulateCommitCoupling(commit, opts, revs, pairSupport);
	const pairs: CouplingPair[] = [];
	for (const [a, row] of pairSupport) {
		const revA = revs.get(a) ?? 0;
		for (const [b, support] of row) {
			if (support < opts.minSupport) continue;
			// Both members were counted into `revs` in the same iteration that created
			// this row, so these lookups are total; the `?? 0` only satisfies the type.
			const revB = revs.get(b) ?? 0;
			const strength = Math.round((support / ((revA + revB) / 2)) * 100);
			if (strength < opts.minStrength) continue;
			pairs.push({ a, b, support, revA, revB, strength });
		}
	}
	pairs.sort(
		(x, y) => y.strength - x.strength || y.support - x.support || x.a.localeCompare(y.a),
	);
	return pairs;
}

const TEST_SUFFIX_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const CODE_EXT_RE = /\.[cm]?[jt]sx?$/i;

function stemOf(path: string): string {
	return basename(path).replace(TEST_SUFFIX_RE, "").replace(CODE_EXT_RE, "");
}

/** Same-stem test↔SUT siblings (same dir, or the test under a sibling __tests__/). */
export function isCompanionPair(a: string, b: string): boolean {
	const aIsTest = TEST_SUFFIX_RE.test(a);
	const bIsTest = TEST_SUFFIX_RE.test(b);
	if (aIsTest === bIsTest) return false;
	const test = aIsTest ? a : b;
	const sut = aIsTest ? b : a;
	if (stemOf(test) !== stemOf(sut)) return false;
	const testDir = dirname(test);
	const sutDir = dirname(sut);
	return testDir === sutDir || testDir === `${sutDir}/__tests__`;
}

/**
 * Attach the relation label. `isLinked` returns null when no import graph is
 * available — the pair is then "unknown", never silently "hidden" (a false
 * "hidden" is this command's worst failure mode).
 */
export function annotateRelations(
	pairs: CouplingPair[],
	isLinked: (a: string, b: string) => boolean | null,
): AnnotatedCouplingPair[] {
	return pairs.map((p) => {
		if (isCompanionPair(p.a, p.b)) return { ...p, relation: "companion" as const };
		const linked = isLinked(p.a, p.b);
		if (linked === null) return { ...p, relation: "unknown" as const };
		return { ...p, relation: linked ? ("linked" as const) : ("hidden" as const) };
	});
}

/** Paths that inflate co-change counts without carrying design signal. */
const EXCLUDE_RE = /^(dist|build|coverage|docs\/generated|\.interlinked)\//;

interface MetricsCouplingOpts {
	cwd?: string;
	since?: string;
	minSupport?: string;
	maxCommitFiles?: string;
	minStrength?: string;
	limit?: string;
	json?: boolean;
	short?: boolean;
}

/**
 * `--flag 0` means 0. The original `Number(raw) || fallback` was falsy-guarded, so
 * every explicit zero silently became the default — `--min-strength 0` asked for no
 * floor and got the 30% one. Missing, blank, and non-numeric values still fall back.
 */
function numericOption(raw: string | undefined, fallback: number): number {
	const text = (raw ?? "").trim();
	if (text === "") return fallback;
	const parsed = Number(text);
	return Number.isNaN(parsed) ? fallback : parsed;
}

function importLookupFor(cwd: string): (a: string, b: string) => boolean | null {
	try {
		const graph = new ProjectGraph(cwd);
		graph.initialize();
		return (a: string, b: string): boolean | null => {
			const absA = join(cwd, a);
			const absB = join(cwd, b);
			if (!graph.hasFile(absA) || !graph.hasFile(absB)) return null;
			return (
				graph.getDependencies(absA).some((e) => e.toFile === absB) ||
				graph.getDependencies(absB).some((e) => e.toFile === absA)
			);
		};
	} catch {
		return () => null;
	}
}

function renderTable(pairs: AnnotatedCouplingPair[], since: string, scanned: number): string {
	const lines: string[] = [];
	lines.push(`Change coupling — ${scanned} commits since ${since}`);
	lines.push("");
	lines.push("  str%  n   revs      relation   pair");
	for (const p of pairs) {
		const str = String(p.strength).padStart(4);
		const n = String(p.support).padStart(3);
		const revs = `${p.revA}/${p.revB}`.padEnd(9);
		const rel = p.relation.padEnd(10);
		lines.push(`  ${str}  ${n} ${revs} ${rel} ${p.a} ↔ ${p.b}`);
	}
	const hidden = pairs.filter((p) => p.relation === "hidden").length;
	lines.push("");
	lines.push(
		`${pairs.length} pairs (${hidden} hidden — co-change with no import edge either way).`,
	);
	return lines.join("\n");
}

/** Public API — wired by `interlinked metrics coupling` in registrars/quality.ts. */
export async function metricsCouplingCommand(opts: MetricsCouplingOpts): Promise<void> {
	const cwd = opts.cwd || process.cwd();
	const since = opts.since || "90 days ago";
	const mode = getOutputMode(opts);
	let logText: string;
	try {
		logText = execFileSync(
			"git",
			["log", "--no-merges", `--since=${since}`, "--name-only", "--pretty=format:%H\t%ct"],
			{ cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
		);
	} catch (err) {
		process.stderr.write(
			`git log failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n`,
		);
		process.exitCode = 1;
		return;
	}
	const commits = parseNameOnlyLog(logText).map((c) => ({
		...c,
		files: c.files.filter((f) => !EXCLUDE_RE.test(f)),
	}));
	const pairs = computeCoupling(commits, {
		minSupport: numericOption(opts.minSupport, 4),
		maxCommitFiles: numericOption(opts.maxCommitFiles, 30),
		minStrength: numericOption(opts.minStrength, 30),
	});
	const limit = numericOption(opts.limit, 25);
	const annotated = annotateRelations(pairs.slice(0, limit), importLookupFor(cwd));

	output(mode, annotated, {
		json: () => ({ since, commits_scanned: commits.length, pairs: annotated }),
		short: () =>
			`${annotated.length} coupled pairs, ${annotated.filter((p) => p.relation === "hidden").length} hidden`,
		normal: () => renderTable(annotated, since, commits.length),
	});
}
