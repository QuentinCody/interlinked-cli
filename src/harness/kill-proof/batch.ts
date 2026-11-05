// ===========================================
// Kill proof — every manifest survivor of one file, in one command
// ===========================================
// `interlinked tests prove-kill --file <src> --test <t>… --all-survivors`. The
// manifest is the ONLY source of the work-list (`mutation survivors --file`
// semantics: open survivors after the disposition ledger; nothing is inferred
// from the tree). One `ProofContext` is opened for the file, so the n mutants
// share ONE unmutated baseline copy and, when a verdict needs them, one canary
// and one control copy; each survivor then gets its own mutant copy and — on a
// kill — its own two repeat copies. Every verdict rule lives in `run.ts
// proveResolved`: a mutant proved here gets exactly the result `proveKill`
// gives it alone (pinned by batch.test.ts against three mutants).
//
// Exit contract (the CLI reads `batchExitCode`): 0 only when every survivor
// that ran was killed; 1 when any survived or a test is not-passing-now; 2 when
// nothing could run (no manifest, the file is not measured, no open survivor,
// every row undecided). `--max` caps the batch and the result says how many
// were left out; the exit code judges only the rows that ran.

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { loadLedger, withDispositions } from "../mutation/disposition-store.js";
import { normalizeManifestKey } from "../mutation/manifest-key.js";
import { loadManifestState } from "../mutation/manifest.js";
import { summarizeSurvivors } from "../mutation/survivors.js";
import { resolveMutant } from "./resolve.js";
import { openProofContext, type ProofContextOptions, proveResolved } from "./run.js";
import type { ProveKillResult, ResolvedMutant } from "./types.js";

export const DEFAULT_BATCH_MAX = 50;

export interface ProveKillBatchOptions extends ProofContextOptions {
	/** Repo-relative (or absolute, under the root) path of the measured source file. */
	file: string;
	/** At most this many survivors run, in source order; default {@link DEFAULT_BATCH_MAX}. */
	max?: number;
}

/** One survivor's result, tagged with the manifest id it was resolved from. */
export type ProveKillBatchRow = ProveKillResult & { mutantId: string };

export interface ProveKillBatchSummary {
	killed: number;
	survived: number;
	inconclusive: number;
	unavailable: number;
	notPassingNow: number;
	/** Rows that ran (= `results.length`). */
	total: number;
}

export interface ProveKillBatchResult {
	/** Manifest key of the file. */
	file: string;
	tests: string[];
	/** Open survivors the manifest lists for the file, before `--max`. */
	survivors: number;
	/** Survivors left out by `--max`. */
	skipped: number;
	max: number;
	/** Manifest generation the survivors came from; null when no manifest loaded. */
	generation: number | null;
	results: ProveKillBatchRow[];
	summary: ProveKillBatchSummary;
	/** Set when the batch could not start: no manifest, the file is not in it, or it has no open survivor. */
	reasons?: string[];
	warnings?: string[];
	elapsedMs: number;
}

export type FileSurvivors = { ok: true; file: string; generation: number; mutantIds: string[] } | { ok: false; file: string; generation: number | null; reasons: string[] };

/** The manifest's open survivors for one file, after the disposition ledger — what `mutation survivors --file` lists. */
export function listFileSurvivors(root: string, file: string): FileSurvivors {
	const key = normalizeManifestKey(file, root);
	const configDir = join(root, ".interlinked");
	const state = loadManifestState(configDir);
	if (state.kind === "missing") {
		return { ok: false, file: key, generation: null, reasons: ["no mutation manifest yet: run `interlinked mutation measure <file>`, or prove one explicit fault with --file/--find/--replace"] };
	}
	if (state.kind === "corrupt") return { ok: false, file: key, generation: null, reasons: [`mutation manifest is corrupt: ${state.detail}`] };
	const manifest = withDispositions(state.manifest, loadLedger(configDir));
	const generation = manifest.generation;
	if (!(key in manifest.files)) {
		return { ok: false, file: key, generation, reasons: [`${key} is not in the mutation manifest (generation ${generation}); measure it first: interlinked mutation measure ${key}`] };
	}
	const mutantIds = summarizeSurvivors(manifest, { file: key }).mutants.filter(row => row.file === key).map(row => row.mutantId);
	if (mutantIds.length === 0) return { ok: false, file: key, generation, reasons: [`${key} has no open survivor in the mutation manifest (generation ${generation}); nothing to prove`] };
	return { ok: true, file: key, generation, mutantIds };
}

export function summarizeBatch(rows: readonly ProveKillResult[]): ProveKillBatchSummary {
	const summary: ProveKillBatchSummary = { killed: 0, survived: 0, inconclusive: 0, unavailable: 0, notPassingNow: 0, total: rows.length };
	for (const row of rows) {
		if (!row.ok) {
			if (row.verdict === "not-passing-now") summary.notPassingNow++;
			else summary.unavailable++;
		} else summary[row.receipt.verdict]++;
	}
	return summary;
}

/** 0 only when every row killed; 1 when any survived or is not-passing-now; 2 when nothing ran or nothing was decided. */
export function batchExitCode(batch: Pick<ProveKillBatchResult, "summary">): 0 | 1 | 2 {
	const { summary } = batch;
	if (summary.total === 0) return 2;
	if (summary.killed === summary.total) return 0;
	if (summary.survived > 0 || summary.notPassingNow > 0) return 1;
	return 2;
}

type Candidate = { mutantId: string; resolved: { ok: true; mutant: ResolvedMutant } | { ok: false; reason: string } };

/** Source order (offset, then id) so `--max` and the table are deterministic; unresolved ids last. */
function byOffset(a: Candidate, b: Candidate): number {
	if (a.resolved.ok && b.resolved.ok) return a.resolved.mutant.offset - b.resolved.mutant.offset || a.mutantId.localeCompare(b.mutantId);
	if (a.resolved.ok !== b.resolved.ok) return a.resolved.ok ? -1 : 1;
	return a.mutantId.localeCompare(b.mutantId);
}

function emptyBatch(file: string, tests: readonly string[], max: number, generation: number | null, reasons: string[], startedAt: number): ProveKillBatchResult {
	return { file, tests: [...tests], survivors: 0, skipped: 0, max, generation, results: [], summary: summarizeBatch([]), reasons, elapsedMs: Date.now() - startedAt };
}

/** Prove every open survivor of `options.file` against the same tests; one baseline, one receipt per mutant. */
export async function proveKillBatch(options: ProveKillBatchOptions): Promise<ProveKillBatchResult> {
	const startedAt = Date.now();
	const root = realpathSync(options.root);
	const max = options.max ?? DEFAULT_BATCH_MAX;
	const listed = listFileSurvivors(root, options.file);
	if (!listed.ok) return emptyBatch(listed.file, options.tests, max, listed.generation, listed.reasons, startedAt);
	const spec = (mutantId: string) => ({ kind: "manifest", mutantId, file: listed.file }) as const;
	const candidates = listed.mutantIds.map((mutantId): Candidate => ({ mutantId, resolved: resolveMutant(root, spec(mutantId)) })).sort(byOffset);
	const chosen = candidates.slice(0, max);

	const opened = openProofContext({ ...options, root });
	const results: ProveKillBatchRow[] = [];
	for (const candidate of chosen) {
		if (!candidate.resolved.ok) {
			results.push({ ok: false, verdict: "unavailable", reasons: [candidate.resolved.reason], mutantId: candidate.mutantId });
		} else if (!opened.ok) {
			results.push({ ok: false, verdict: "unavailable", reasons: opened.reasons, mutant: candidate.resolved.mutant, mutantId: candidate.mutantId });
		} else {
			results.push({ ...(await proveResolved(opened.context, candidate.resolved.mutant)), mutantId: candidate.mutantId });
		}
	}
	const warnings = opened.ok ? opened.context.warnings : [];
	return {
		file: listed.file,
		tests: opened.ok ? opened.context.tests : [...options.tests],
		survivors: candidates.length,
		skipped: candidates.length - chosen.length,
		max,
		generation: listed.generation,
		results,
		summary: summarizeBatch(results),
		...(warnings.length ? { warnings: [...warnings] } : {}),
		elapsedMs: Date.now() - startedAt,
	};
}
