// ===========================================
// `interlinked coverage` registrar — check / metrics / baseline
// ===========================================
// Split out of quality.ts (2026-09-16) when the `metrics` subcommand pushed
// that file past the 500-line cap. Behavior of `check` / `baseline` is
// unchanged; `metrics` is the four-metric analysis surface.

import type { Command, OptionValues } from "commander";

function collectMapping(value: string, previous: string[] = []): string[] { return [...previous, value]; }

function registerE2eIdentity(coverage: Command): void {
	coverage.command("move [old] [new]").description("Record an e2e boundary move, preserving every floor")
		.option("--lane <name>", "Required: e2e").option("--map <old=new>", "Atomic mapping; repeat for a chain or swap", collectMapping)
		.option("--base <ref>", "Comparison base (default: HEAD)").option("--cwd <path>", "Project root").option("--json", "Machine-readable output")
		.action(async (old: string | undefined, next: string | undefined, opts: OptionValues) => {
			const { coverageE2eIdentityCommand } = await import("../commands/coverage-e2e.js");
			await coverageE2eIdentityCommand(opts, { old, next });
		});
	coverage.command("retire <path>").description("Retire an e2e floor whose boundary file is gone or erased")
		.option("--lane <name>", "Required: e2e").option("--base <ref>", "Comparison base (default: HEAD)")
		.option("--cwd <path>", "Project root").option("--json", "Machine-readable output")
		.action(async (path: string, opts: OptionValues) => {
			const { coverageE2eIdentityCommand } = await import("../commands/coverage-e2e.js");
			await coverageE2eIdentityCommand(opts, { retire: path });
		});
}

export function registerCoverageCommands(program: Command): void {
	// NOTE: the parent description below is pinned verbatim by a single-line
	// assertion in quality.mutation-kill.test.ts, and GATE 2 of
	// `mutation_directed_assertion_removal` treats an edit to that line as a
	// removed assertion (the equivalence key includes the expected string), so
	// it cannot be reworded without the file-level suppression. The exit-policy
	// detail therefore lives on the `check` subcommand, which owns --strict.
	const coverageCmd = program
		.command("coverage")
		.description("Per-file coverage ratchet — fails on any file whose coverage drops");
	registerE2eIdentity(coverageCmd);
    coverageCmd.command("status").description("Show quality coverage baselines by lane (distinct from harness filesystem coverage)")
        .option("--cwd <path>", "Project root").option("--json", "Machine-readable output")
        .action(async (opts: OptionValues) => {
            const { coverageLaneStatusCommand } = await import("../commands/coverage-e2e.js");
            coverageLaneStatusCommand(opts);
        });

	// Flag parity is a pinned contract (coverage-flag-parity.test.ts): every
	// option registered here must map to an `opts.<key>` that
	// `coverageCheckCommand` actually reads, and vice versa. The pre-2026-09
	// registration violated BOTH directions — `--summary`/`--baseline` were
	// accepted and silently ignored (the command reads `opts.report` and always
	// loads the baseline from the config dir), while `--strict` /
	// `--changed-files` / `--cwd` were read but unregistered, so commander
	// refused `--strict` as an unknown option and the ratchet could never fail.
	// `--report` deliberately carries NO default: an explicit path SUPPRESSES
	// the multi-report LCOV+istanbul merge in `resolveReportPaths`.
	coverageCmd
		.command("check", { isDefault: true })
		.description(
			"Compare current coverage against the baseline. Per-file drops are ADVISORY (exit 0) unless --strict is passed",
		)
		.option(
			"--report <path>",
			"Path to one coverage report (LCOV .info or istanbul JSON). Default: merge every discovered coverage report",
		)
		.option(
			"--changed-files <list>",
			"Comma-separated repo-relative paths; only report drops for these files",
		)
		.option("--update-baseline", "Persist the current coverage as the new baseline")
		.option("--lane <name>", "Named coverage lane: e2e (isolated strict policy)")
		.option("--init-baseline", "Initialize an absent e2e baseline from a passing measured run")
		.option("--require-measured", "Fail on a partial or unmeasured report")
		.option("--base <ref>", "E2e comparison base (default: HEAD; CI supplies its event base)")
		.option("--map <old=new>", "Apply a mapping in the measured e2e transaction; repeatable", collectMapping)
		.option("--strict", "exit non-zero on any per-file drop (default: advisory)")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { coverageCheckCommand } = await import("../commands/coverage.js");
			await coverageCheckCommand(opts);
		});

	coverageCmd
		.command("metrics")
		.description(
			"Per-metric distribution (lines / statements / functions / branches) over the merged coverage report: measured, at 100%, under a threshold, p50/p90, lowest files",
		)
		.option(
			"--report <path>",
			"Path to one coverage report (LCOV .info or istanbul JSON). Default: merge every discovered report",
		)
		.option("--metric <name>", "Only this metric: lines | statements | functions | branches")
		.option("--under <pct>", 'Threshold for the "under N%" count (default 90)')
		.option("--top <n>", "How many lowest files to list per metric (default 10)")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { coverageMetricsCommand } = await import("../commands/coverage-metrics.js");
			await coverageMetricsCommand(opts);
		});

	coverageCmd
		.command("baseline")
		.description("Show the current coverage baseline")
		.option("--lane <name>", "Named coverage lane: e2e")
		.option("--cwd <path>", "Project root")
		.option("--json", "Machine-readable output")
		.action(async (opts: { json?: boolean; cwd?: string; lane?: string }) => {
			const { coverageBaselineCommand } = await import("../commands/coverage.js");
			coverageBaselineCommand(opts);
		});
}
