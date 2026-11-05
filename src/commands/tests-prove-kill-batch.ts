// ===========================================
// `interlinked tests prove-kill --all-survivors` — the batch loop's CLI side
// ===========================================
// Option validation, the compact table, the summary line and the exit code for
// proving every manifest survivor of one file in one command. The orchestration
// (one shared baseline, one receipt per mutant) is `harness/kill-proof/batch.ts`;
// the verdict rules are `run.ts proveResolved`, shared with the single-mutant
// path. `--json` returns the whole `ProveKillBatchResult`: `{file, tests,
// results: [...per-mutant ProveKillResult + mutantId...], summary, …}`.

import { realpathSync } from "node:fs";
import { batchExitCode, DEFAULT_BATCH_MAX, type ProveKillBatchResult, type ProveKillBatchRow, proveKillBatch } from "../harness/kill-proof/batch.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { PROVE_KILL_EXIT, type ProveKillCliOptions, timeoutProblem } from "./tests-prove-kill.js";

export interface ProveKillBatchCliOptions extends ProveKillCliOptions {
	allSurvivors?: boolean;
	max?: string;
}

/** `--all-survivors` takes `--file` and `--test`, never a mutant or a fault; `--max` is a positive integer. */
export function batchOptionProblem(options: ProveKillBatchCliOptions): string | null {
	if (options.allSurvivors !== true) return options.max !== undefined ? "--max applies to --all-survivors only" : null;
	if (options.mutant !== undefined || options.find !== undefined || options.replace !== undefined) return "--all-survivors proves every manifest survivor of --file; do not pass --mutant, --find or --replace with it";
	if (options.file === undefined) return "--all-survivors needs --file <source>: the measured file whose survivors to prove";
	if (options.max !== undefined && (!/^\d+$/.test(options.max) || Number(options.max) <= 0 || !Number.isSafeInteger(Number(options.max)))) return "--max must be a positive integer";
	return timeoutProblem(options);
}

const LEXEME_WIDTH = 34;
const CASES_WIDTH = 60;

function clip(text: string, width: number): string {
	return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function mutationLabel(row: ProveKillBatchRow): string {
	const mutant = row.ok ? row.receipt.mutant : row.mutant;
	if (!mutant) return "(not resolved)";
	return `${clip(JSON.stringify(mutant.originalLexeme), LEXEME_WIDTH)} → ${clip(JSON.stringify(mutant.replacement), LEXEME_WIDTH)}`;
}

function verdictOf(row: ProveKillBatchRow): string {
	return (row.ok ? row.receipt.verdict : row.verdict).toUpperCase();
}

/** Killed cases for a receipt row (count and titles); the first reason for a row that produced none. */
function detailOf(row: ProveKillBatchRow): string {
	if (!row.ok) return clip(row.reasons[0] ?? "", CASES_WIDTH);
	const killed = row.receipt.underMutant.cases.filter(c => c.verdict === "killed").map(c => c.test.slice(c.test.indexOf(" › ") + 3));
	if (killed.length === 0) return row.receipt.verdict === "survived" ? "none — every case still passes" : clip(row.receipt.reasons[0] ?? "", CASES_WIDTH);
	return clip(`${killed.length}: ${killed.join(", ")}`, CASES_WIDTH);
}

export function summaryLine(batch: ProveKillBatchResult): string {
	const { summary } = batch;
	const parts = [`${summary.killed} killed`, `${summary.survived} survived`, `${summary.inconclusive} inconclusive`, `${summary.unavailable} unavailable`];
	if (summary.notPassingNow > 0) parts.push(`${summary.notPassingNow} not-passing-now`);
	const skipped = batch.skipped > 0 ? `; ${batch.skipped} skipped by --max ${batch.max}` : "";
	return `summary: ${parts.join(" / ")} of ${summary.total}${skipped} (${(batch.elapsedMs / 1000).toFixed(1)} s)`;
}

function nextStep(batch: ProveKillBatchResult): string {
	const { summary } = batch;
	const more = batch.skipped > 0 ? ` ${batch.skipped} survivor(s) did not run; raise --max to cover them.` : "";
	if (summary.total === 0) return "Nothing ran. Fix the reason above and re-run. No receipt was written.";
	if (summary.killed === summary.total) return `Every survivor that ran is killed; one receipt per mutant is recorded.${more} Re-measure the file to update the manifest: interlinked mutation measure ${batch.file} --record`;
	if (summary.notPassingNow > 0) return "Make the tests pass on the current code first. A test that already fails proves nothing about any mutant.";
	if (summary.survived > 0) return `${summary.survived} survivor(s) still pass these tests. Assert the value each surviving line changes, then re-run the same command.${more}`;
	return `Nothing is proven for the undecided rows: a crash, a timeout, a parse error or an unresolvable mutant is not a kill.${more}`;
}

export function renderProveKillBatch(batch: ProveKillBatchResult): string {
	const lines: string[] = [];
	const generation = batch.generation === null ? "" : `, generation ${batch.generation}`;
	lines.push(`file: ${batch.file} (${batch.survivors} open survivor(s) in the manifest${generation}; ${batch.results.length} run)`);
	for (const warning of batch.warnings ?? []) lines.push(`warning: ${warning}`);
	const first = batch.results.find(row => row.ok);
	if (first?.ok) lines.push(`tests: ${batch.tests.join(", ")} (${first.receipt.baseline.cases} case(s) pass in the isolated copy, ${first.receipt.baseline.durationMs} ms, shared by every mutant)`);
	else lines.push(`tests: ${batch.tests.join(", ")}`);
	for (const reason of batch.reasons ?? []) lines.push(`  - ${reason}`);
	if (batch.results.length) {
		lines.push(`  ${"mutant".padEnd(16)}  ${"line".padStart(5)}  ${"mutation".padEnd(LEXEME_WIDTH * 2 + 3)}  ${"verdict".padEnd(15)}  killed cases`);
		for (const row of batch.results) {
			const mutant = row.ok ? row.receipt.mutant : row.mutant;
			const line = mutant ? String(mutant.line) : "-";
			lines.push(`  ${row.mutantId.padEnd(16)}  ${line.padStart(5)}  ${mutationLabel(row).padEnd(LEXEME_WIDTH * 2 + 3)}  ${verdictOf(row).padEnd(15)}  ${detailOf(row)}`);
		}
	}
	lines.push(summaryLine(batch), nextStep(batch));
	return lines.join("\n");
}

export async function testsProveKillBatchCommand(options: ProveKillBatchCliOptions): Promise<void> {
	const mode = getOutputMode(options);
	const problem = batchOptionProblem(options);
	if (problem !== null) { outputError(mode, problem); process.exitCode = PROVE_KILL_EXIT.undecided; return; }
	const budgetMs = Number(options.runTimeout ?? "300000");
	const max = options.max === undefined ? DEFAULT_BATCH_MAX : Number(options.max);
	try {
		const root = realpathSync(options.cwd ?? process.cwd());
		const batch = await proveKillBatch({ root, file: options.file ?? "", tests: options.test ?? [], budgetMs, max, ...(options.vitestConfig !== undefined ? { vitestConfig: options.vitestConfig } : {}) });
		process.exitCode = batchExitCode(batch);
		output(mode, batch, { normal: () => renderProveKillBatch(batch) });
	} catch (error) {
		outputError(mode, error instanceof Error ? error.message : "kill proof batch unavailable");
		process.exitCode = PROVE_KILL_EXIT.undecided;
	}
}
