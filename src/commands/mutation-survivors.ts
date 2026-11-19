// ===========================================
// interlinked mutation survivors — read the work-list out of the manifest
// ===========================================
// The gap this closes: every mutant the runner has ever failed to kill is
// already recorded in `.interlinked/mutation-manifest.json`, and no command
// could read it. The per-edit gate reports the survivors of ONE edit;
// `mutation measure` re-runs ONE file against the runner. So a repo's standing
// mutation debt — the thing an agent could actually work through — was
// reachable only by hand-written JSON scripts.
//
// Ranking + counting live in harness/mutation/survivors.ts (pure, no fs). This
// module is I/O and rendering only: load, filter, shard, print.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	restrictToFiles,
	type SurvivorFileRow,
	type SurvivorFilter,
	type SurvivorRemedy,
	type SurvivorSummary,
	summarizeSurvivors,
} from "../harness/mutation/survivors.js";
import { getConfigDir } from "../lib/config.js";
import { c, header } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

export interface MutationSurvivorsOptions {
	file?: string;
	mutator?: string;
	top?: string;
	shard?: string;
	includeDispositioned?: boolean;
	includeStale?: boolean;
	cwd?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

/** One slice of the ranked work-list, for splitting a fan-out across machines. */
export interface Shard {
	/** Zero-based. */
	index: number;
	count: number;
}

/**
 * Parse the human `i/n` shard spelling (1-based, as a person would say it) into
 * a zero-based index. Strict: a malformed or out-of-range spec returns null
 * rather than a guess, because silently measuring the wrong slice would look
 * exactly like measuring the right one.
 */
export function parseShard(spec: string): Shard | null {
	const match = /^(\d+)\/(\d+)$/.exec(spec.trim());
	if (!match) return null;
	const one = Number(match[1]);
	const count = Number(match[2]);
	// The regex admits digits only, so neither read can be NaN — but a relational
	// comparison against NaN fails OPEN (every `<`/`>` is false), so the range
	// check below would silently accept it. Assert rather than reason about it.
	if (!Number.isFinite(one) || !Number.isFinite(count)) return null;
	if (count < 1 || one < 1 || one > count) return null;
	return { index: one - 1, count };
}

/**
 * Deal the ranked list round-robin, NOT in contiguous blocks.
 *
 * The list is sorted worst-first, so a contiguous split hands shard 1 every
 * expensive file and shard 2 the tail — the opposite of a balanced fan-out.
 * Round-robin gives each machine a comparable mix, and stays deterministic, so
 * two machines computing their own shard from the same manifest never overlap
 * and never drop a file between them.
 */
export function shardOf<T>(rows: readonly T[], shard: Shard): T[] {
	return rows.filter((_, i) => i % shard.count === shard.index);
}

function pct(value: number): string {
	return `${(value * 100).toFixed(0)}%`;
}

function num(value: number): string {
	return value.toLocaleString("en-US");
}

function totalsLine(s: SurvivorSummary): string {
	const t = s.totals;
	return [
		`${num(t.mutants)} mutants`,
		`${num(t.killed)} killed`,
		`${num(t.open)} open survivors (${num(t.openByRemedy.write_test)} need a test, ${num(t.openByRemedy.strengthen_tests)} need stronger assertions, ${num(t.openByRemedy.unknown)} unqualified)`,
		`${num(t.dispositioned)} judged`,
		`${num(t.uncovered)} uncovered`,
		`score ${pct(t.score)}`,
	].join(" · ");
}

/**
 * One table per JOB, not one table of files.
 *
 * "Write a test for this file" and "make this file's existing tests assert
 * more" are different work, and a reader cannot tell them apart from a survivor
 * count. The measured test count separates them, so the report does too.
 */
function remedyTables(s: SurvivorSummary, top: number): string[] {
	const lines: string[] = [];
	const groups: Array<{ remedy: SurvivorRemedy; title: string; hint: string }> = [
		{
			remedy: "write_test",
			title: "No test runs against these files — write one",
			hint: "Every mutant here survives because nothing executes the code.",
		},
		{
			remedy: "strengthen_tests",
			title: "Tests run but do not detect the change — strengthen the assertions",
			hint: "The tests execute this code and pass while it behaves differently.",
		},
		{
			remedy: "unknown",
			title: "Unqualified — re-measure before you act on these",
			hint: "No provenance: the counts came from an unknown test scope.",
		},
	];
	for (const group of groups) {
		const rows = s.files.filter((f) => f.open > 0 && f.remedy === group.remedy);
		if (rows.length === 0) continue;
		lines.push(...fileTable(rows, top, group.title, group.hint));
	}
	return lines;
}

function fileTable(files: SurvivorFileRow[], top: number, title: string, hint: string): string[] {
	const rows = files;
	const shown = rows.slice(0, top);
	const lines = [
		"",
		c.bold(`  ${title}`),
		c.dim(`  ${hint}`),
		c.dim("   open  uncov  tests  score  file"),
		...shown.map(
			(f) =>
				`  ${String(f.open).padStart(5)}  ${String(f.uncovered).padStart(5)}  ${testCountOf(f).padStart(5)}  ${pct(f.score).padStart(5)}  ${f.file}${f.stale ? c.dim(" (deleted)") : ""}`,
		),
	];
	if (rows.length > shown.length) lines.push(c.dim(`  … ${num(rows.length - shown.length)} more file(s)`));
	return lines;
}

/** Test files in scope when this file was measured; "?" when unqualified. */
function testCountOf(f: SurvivorFileRow): string {
	return f.provenance === null ? "?" : String(f.provenance.testCount);
}

function mutatorTable(s: SurvivorSummary, top: number): string[] {
	const rows = s.mutators.filter((m) => m.open > 0).slice(0, top);
	if (rows.length === 0) return [];
	return [
		"",
		c.bold("  Mutators that escape most often"),
		c.dim("   open  of total  escape  mutator"),
		...rows.map(
			(m) =>
				`  ${String(m.open).padStart(5)}  ${String(m.total).padStart(8)}  ${pct(m.escapeRate).padStart(6)}  ${m.mutator}`,
		),
	];
}

function symbolTable(s: SurvivorSummary, top: number): string[] {
	const rows = s.symbols.filter((r) => r.open > 0).slice(0, top);
	if (rows.length === 0) return [];
	return [
		"",
		c.bold("  Symbols to fix"),
		...rows.map(
			(r) =>
				`   ${String(r.open).padStart(4)} open  ${r.qualifiedName}${r.quarantined ? c.dim(" [quarantined]") : ""}  ${c.dim(r.file)}`,
		),
	];
}

function mutantTable(s: SurvivorSummary, top: number): string[] {
	const rows = s.mutants.slice(0, top);
	if (rows.length === 0) return [];
	return [
		"",
		c.bold("  Surviving mutants (kill these)"),
		...rows.map(
			(m) =>
				`    ${m.mutantId}  ${m.qualifiedName}  ${m.mutator}: ${JSON.stringify(m.originalLexeme).slice(0, 60)} → ${JSON.stringify(m.replacement).slice(0, 60)}`,
		),
	];
}

/**
 * The loudest thing this report can say.
 *
 * A file measured under a narrow test scope reports survivors that a wider
 * scope kills outright — measured here at 186 vs 18 on one unedited file, and
 * 106 vs 0 on another. Summing counts from different regimes produces a number
 * that looks like debt and is not, so a report carrying unqualified records
 * must refuse to present its total as a measurement.
 */
function provenanceNote(s: SurvivorSummary): string[] {
	const unqualified = s.totals.unqualifiedFiles;
	if (unqualified === 0) return [];
	const share = s.totals.files === 0 ? 0 : unqualified / s.totals.files;
	return [
		"",
		c.yellow(
			`  ⚠ ${num(unqualified)} of ${num(s.totals.files)} file(s) (${pct(share)}) carry NO measurement provenance —`,
		),
		c.yellow("    their counts were recorded under an unknown test scope and are NOT comparable."),
		c.dim("    Re-measure to qualify them: interlinked mutation sweep --limit 20"),
	];
}

function staleNote(s: SurvivorSummary): string[] {
	if (s.totals.staleFiles === 0) return [];
	return [
		"",
		c.dim(
			`  ${num(s.totals.staleFiles)} measured file(s) no longer exist — their survivors are stale and unfixable. Nothing prunes them on load.`,
		),
	];
}

function nextSteps(s: SurvivorSummary, opts: RenderOptions): string[] {
	if (opts.file) {
		return [
			"",
			c.dim("  Kill one: add a test that fails under the replacement, then"),
			c.dim(
				"  ground each new case: // test-contract: <public-api|invariant|bug|security|boundary> — <specific rationale>",
			),
			c.dim(`  prove the kill (executed, receipted): interlinked tests prove-kill --mutant <id> --test <test file>`),
			c.dim(`  re-measure with: interlinked mutation measure ${opts.file} --record`),
		];
	}
	const worst = s.files.find((f) => f.open > 0 && !f.stale);
	if (!worst) return [];
	return ["", c.dim(`  Next: interlinked mutation survivors --file ${worst.file}`)];
}

export interface RenderOptions {
	top: number;
	/** Set when the report is scoped to one file — switches to the per-mutant view. */
	file?: string | undefined;
	shard?: Shard | undefined;
}

/** Render the human report. Pure: takes a summary, returns text. */
export function renderSurvivorReport(s: SurvivorSummary, opts: RenderOptions): string {
	const lines: string[] = [
		header("Mutation survivors"),
		`  ${totalsLine(s)}`,
		c.dim(`  manifest generation ${s.generation}, measured ${s.authoritativeAt}`),
	];
	if (opts.shard) {
		lines.push(c.dim(`  shard ${opts.shard.index + 1}/${opts.shard.count} of the ranked file list`));
	}
	if (s.totals.open === 0) {
		lines.push("", c.green("  No open surviving mutants in scope."));
		lines.push(...provenanceNote(s), ...staleNote(s));
		return lines.join("\n");
	}
	if (opts.file) {
		lines.push(...symbolTable(s, opts.top), ...mutantTable(s, opts.top));
	} else {
		lines.push(...remedyTables(s, opts.top), ...mutatorTable(s, opts.top));
	}
	lines.push(...provenanceNote(s), ...staleNote(s), ...nextSteps(s, opts));
	return lines.join("\n");
}

function buildFilter(opts: MutationSurvivorsOptions, cwd: string): SurvivorFilter {
	return {
		file: opts.file,
		mutator: opts.mutator,
		includeDispositioned: opts.includeDispositioned === true,
		exists: (file: string) => existsSync(resolve(cwd, file)),
	};
}

/** Drop stale (deleted-file) rows unless the caller asked to see them. Totals
 *  are recomputed by `restrictToFiles` — a narrowed view that kept repo-wide
 *  totals would report another scope's debt as its own. */
function applyStaleFilter(s: SurvivorSummary, includeStale: boolean): SurvivorSummary {
	if (includeStale || s.totals.staleFiles === 0) return s;
	return restrictToFiles(s, new Set(s.files.filter((f) => !f.stale).map((f) => f.file)));
}

function applyShard(s: SurvivorSummary, shard: Shard | undefined): SurvivorSummary {
	if (!shard) return s;
	return restrictToFiles(s, new Set(shardOf(s.files, shard).map((f) => f.file)));
}

export async function mutationSurvivorsCommand(opts: MutationSurvivorsOptions): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = resolve(opts.cwd || process.cwd());
	const configDir = getConfigDir(cwd);

	const shard = opts.shard ? parseShard(opts.shard) : undefined;
	if (opts.shard && !shard) {
		outputError(mode, `--shard must be "i/n" with 1 <= i <= n (e.g. --shard 1/2). Got "${opts.shard}".`);
		process.exitCode = 1;
		return;
	}

	const { corruptManifestMessage, loadManifestState } = await import("../harness/mutation/manifest.js");
	const { loadLedger, withDispositions } = await import("../harness/mutation/disposition-store.js");
	const state = loadManifestState(configDir);
	if (state.kind === "corrupt") {
		outputError(mode, corruptManifestMessage(configDir, state.detail));
		process.exitCode = 1;
		return;
	}
	const baseManifest = state.kind === "valid" ? state.manifest : null;
	if (!baseManifest) {
		outputError(
			mode,
			`No mutation manifest at ${join(configDir, "mutation-manifest.json")}. Measure a file first: \`interlinked mutation measure <file> --record\`.`,
		);
		process.exitCode = 1;
		return;
	}
	// Apply the durable disposition ledger onto the manifest before ranking: a
	// recorded dead_code/duplicate survivor leaves the work-list, while an
	// evidence-only `unresolved` (suppression level 0) stays open. No edit to
	// survivors.ts — withDispositions returns a manifest-shaped copy.
	const manifest = withDispositions(baseManifest, loadLedger(configDir));

	const top = Number.parseInt(opts.top ?? "", 10);
	const limit = Number.isFinite(top) && top > 0 ? top : 20;
	const summary = applyShard(
		applyStaleFilter(summarizeSurvivors(manifest, buildFilter(opts, cwd)), opts.includeStale === true),
		shard ?? undefined,
	);

	output(mode, summary, {
		json: () => summary,
		short: () =>
			`${num(summary.totals.open)} open survivors across ${num(summary.files.filter((f) => f.open > 0).length)} file(s), score ${pct(summary.totals.score)}`,
		normal: () => renderSurvivorReport(summary, { top: limit, file: opts.file, shard: shard ?? undefined }),
	});
}
