import { type HistoryKind, type HistoryVerdict, historyKind, resolveVerdicts } from "../lib/metrics/history-noise.js";
import { percentileRanks } from "../harness/percentile-rank.js";
import { nonNull } from "../lib/non-null.js";
import type { CommitFiles, CouplingPair } from "./metrics-coupling.js";

export type PairKind = HistoryKind | "mixed";
export type KindedPair = CouplingPair & { kind: PairKind };

export interface SetAsideReport {
	files: number;
	by_reason: Array<{ reason: string; files: number }>;
	/** Pairs of the unfiltered run that involve at least one set-aside file. */
	pairs: number;
}

/** A verdict for every file in the commits: path rules, then the shape of the newest blob (or its parent's, for a deleted file). */
export function verdictsFor(cwd: string, commits: readonly CommitFiles[]): Map<string, HistoryVerdict> {
	const entries: Array<{ path: string; rev: string }> = [], seen = new Set<string>();
	for (const commit of commits) {
		for (const path of commit.files) {
			if (seen.has(path)) continue;
			seen.add(path);
			entries.push({ path, rev: commit.sha }, { path, rev: `${commit.sha}^` });
		}
	}
	const verdicts = new Map<string, HistoryVerdict>();
	resolveVerdicts(cwd, entries, verdicts);
	return verdicts;
}

function isSetAside(verdicts: ReadonlyMap<string, HistoryVerdict>, file: string): boolean {
	return verdicts.get(file)?.kind === "set-aside";
}

export function withoutSetAside(commits: readonly CommitFiles[], verdicts: ReadonlyMap<string, HistoryVerdict>): CommitFiles[] {
	return commits.map(commit => ({ ...commit, files: commit.files.filter(file => !isSetAside(verdicts, file)) }));
}

export function setAsideReport(verdicts: ReadonlyMap<string, HistoryVerdict>, unfiltered: readonly CouplingPair[]): SetAsideReport {
	const reasons = new Map<string, number>();
	for (const verdict of verdicts.values()) if (verdict.kind === "set-aside") reasons.set(verdict.reason, (reasons.get(verdict.reason) ?? 0) + 1);
	const by_reason = [...reasons].map(([reason, files]) => ({ reason, files })).sort((a, b) => a.reason.localeCompare(b.reason));
	const pairs = unfiltered.filter(pair => isSetAside(verdicts, pair.a) || isSetAside(verdicts, pair.b)).length;
	return { files: by_reason.reduce((total, row) => total + row.files, 0), by_reason, pairs };
}

function kindOf(verdicts: ReadonlyMap<string, HistoryVerdict>, file: string): HistoryKind {
	const verdict = verdicts.get(file);
	return verdict === undefined || verdict.kind === "set-aside" ? historyKind(file) : verdict.kind;
}

function rerank(pairs: KindedPair[]): KindedPair[] {
	const ranks = percentileRanks(pairs.map(pair => pair.strength));
	return pairs.map((pair, index) => ({ ...pair, percentile: nonNull(ranks[index]) }));
}

/** Code and mixed pairs in one list, data-only pairs (locale JSON with locale JSON) in the other, each ranked on its own. */
export function splitPairs(pairs: readonly CouplingPair[], verdicts: ReadonlyMap<string, HistoryVerdict>): { code: KindedPair[]; data: KindedPair[] } {
	const code: KindedPair[] = [], data: KindedPair[] = [];
	for (const pair of pairs) {
		const a = kindOf(verdicts, pair.a), b = kindOf(verdicts, pair.b);
		if (a === "data" && b === "data") data.push({ ...pair, kind: "data" });
		else code.push({ ...pair, kind: a === b ? "code" : "mixed" });
	}
	return { code: rerank(code), data: rerank(data) };
}
