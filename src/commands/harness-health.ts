// `interlinked harness health` — check-health governance report (Tricorder-
// style demotion signal, v1 log-derived). Streams .interlinked/recurrences.jsonl
// line-by-line (40k+ rows in production — never materialized as one array),
// folds per-check-id stats, and flags heuristic checks whose findings re-fire
// without changing as probation candidates for demotion (default → advisory)
// or detection refinement. The UP direction lives in `interlinked recurrence
// propose`; this is the DOWN direction.

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { OptionValues } from "commander";
import {
	type CheckHealthRow,
	createCheckHealthAccumulator,
	finalizeCheckHealth,
	foldRecurrenceLine,
} from "../harness/check-health.js";
import { classifyDeterminism } from "../harness/quality-checks.js";
import { recurrencesPath } from "../harness/recurrence.js";
import { readFindingOutcomes } from "../harness/check-observation-reader.js";
import { recheckFindingFiles } from "../harness/check-recheck.js";
import { c, header, table } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { corpusPrecision } from "./harness-health-corpus.js";

/** Normal mode shows the worst offenders; --full shows every check id. */
const NORMAL_MODE_ROW_LIMIT = 25;

export async function harnessHealthCommand(opts: OptionValues): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		const logPath = recurrencesPath(cwd);
		let findingOutcomes = await readFindingOutcomes(cwd);
        const precision = corpusPrecision(cwd);
		if (opts.recheck) {
			const files = Array.isArray(opts.file) ? opts.file.filter((file): file is string => typeof file === "string") : findingOutcomes.state.map((finding) => finding.file);
			const followup = recheckFindingFiles(cwd, files);
			findingOutcomes = await readFindingOutcomes(cwd);
			if (followup.unavailable.length || followup.deferred.length) {
				process.stderr.write(`Recheck: ${followup.unavailable.length} unavailable, ${followup.deferred.length} beyond the 20-file budget\n`);
			}
		}
		if (!existsSync(logPath) && findingOutcomes.observations === 0) {
			output(
				mode,
				{ checks: [], probation_candidates: 0, finding_outcomes: findingOutcomes, corpus_precision: precision },
				{
					json: () => ({ checks: [], probation_candidates: 0, finding_outcomes: findingOutcomes, corpus_precision: precision }),
					normal: () =>
						c.dim(`No recurrence log at ${logPath} — nothing to grade yet.`),
				},
			);
			return;
		}

		const rows = existsSync(logPath) ? await aggregateHealthFromLog(logPath) : [];
		const candidates = rows.filter((r) => r.status === "probation-candidate");
		const result = { checks: rows, probation_candidates: candidates.length, finding_outcomes: findingOutcomes, corpus_precision: precision };
		const outcomeText = renderFindingOutcomes(findingOutcomes);

		output(mode, result, {
			json: () => result,
			short: () =>
				`${rows.length} check ids graded, ${candidates.length} probation candidate(s); ${findingOutcomes.observations} bound observations`,
			normal: () => renderHealthReport(rows, candidates, NORMAL_MODE_ROW_LIMIT) + outcomeText,
			full: () => renderHealthReport(rows, candidates, rows.length) + outcomeText,
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

function renderFindingOutcomes(report: Awaited<ReturnType<typeof readFindingOutcomes>>): string {
	const lines = ["", "Finding outcomes (observed clearance is not causal fix rate)"];
	for (const row of report.checks) {
		lines.push(`${row.check}: ${row.unique_findings} finding slots, ${row.rechecked_clean} rechecked clean, ${row.not_rechecked} not rechecked, ${row.unavailable} unavailable; follow-up ${Math.round(row.followup_coverage * 100)}%`);
	}
	lines.push(`${report.observations} observations; ${report.measured_execution_ms.toFixed(1)} ms measured execution; window ${report.observation_window.first ?? "unknown"} to ${report.observation_window.last ?? "unknown"}.`);
	lines.push(`${report.legacy_rows} legacy/other rows; ${report.invalid_rows} unreadable rows. Adjudicated precision/scope are in --json; triage cost remains unmeasured. ${report.coverage}`);
	return "\n" + lines.join("\n");
}

/** Line-by-line fold over the JSONL — lazy by construction. Torn lines are
 *  skipped inside foldRecurrenceLine (same tolerance as loadRecurrenceEvents). */
async function aggregateHealthFromLog(logPath: string): Promise<CheckHealthRow[]> {
	const acc = createCheckHealthAccumulator();
	const rl = createInterface({
		input: createReadStream(logPath, { encoding: "utf-8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of rl) {
		foldRecurrenceLine(acc, line);
	}
	return finalizeCheckHealth(acc, classifyDeterminism);
}

function renderHealthReport(
	rows: CheckHealthRow[],
	candidates: CheckHealthRow[],
	limit: number,
): string {
	const lines: string[] = [header("Check health (repeat-rate = events per unique finding)")];
	const shown = rows.slice(0, limit);
	lines.push(
		table(
			["check id", "status", "repeat", "events", "unique", "sessions", "determinism"],
			shown.map((r) => [
				r.check_id,
				statusCell(r.status),
				r.repeat_rate.toFixed(1),
				String(r.events),
				String(r.unique_findings),
				String(r.sessions),
				r.determinism ?? "unknown",
			]),
		),
	);
	if (rows.length > shown.length) {
		lines.push(c.dim(`  … ${rows.length - shown.length} more (use --full)`));
	}
	lines.push("");
	lines.push(...renderProbationSection(candidates));
	return lines.join("\n");
}

function statusCell(status: CheckHealthRow["status"]): string {
	if (status === "probation-candidate") return c.red("PROBATION");
	if (status === "low-data") return c.dim("low-data");
	return c.green("healthy");
}

function renderProbationSection(candidates: CheckHealthRow[]): string[] {
	if (candidates.length === 0) {
		return [c.dim("No probation candidates — every graded check is healthy or low-data.")];
	}
	const lines = [
		c.bold(`Probation candidates (${candidates.length}) — demote to advisory or refine detection:`),
	];
	for (const r of candidates) {
		lines.push(`  ${c.red("●")} ${r.check_id} — ${r.why}`);
	}
	lines.push(
		c.dim(
			"  Same finding re-firing unchanged = likely FP noise or an ignored advisory. " +
				"Prefer refining the check over demoting (see CLAUDE.md verify policy).",
		),
	);
	return lines;
}
