// ===========================================
// Caps registrar — `interlinked caps [set|explain]`
// ===========================================
// One surface for the six quality-metric caps/goals the harness enforces. Bare
// `caps` shows the effective caps + provenance; `caps set` writes a per-repo
// override to .interlinked/metric-caps.json; `caps explain` prints the glossary.
// Actions live in src/commands/caps.ts.

import type { Command } from "commander";
import { capsExplainAction, capsSetAction, capsShowAction } from "../commands/caps.js";
import { capsRatchetAction, capsStatusAction } from "../commands/caps-ratchet.js";

export function registerCapsCommands(program: Command): void {
	const caps = program
		.command("caps")
		.description("View, set, and explain quality caps (lines/function-tokens/complexity/CRAP/coverage)")
		.option("--json", "Machine-readable output")
		.action(async (opts: { json?: boolean }) => {
			process.exitCode = await capsShowAction(opts);
		});

	caps
		.command("set <metric> <value>")
		.description("Set a cap (metric: lines | function-tokens | cyclomatic | cognitive | crap | coverage)")
		.option("--json", "Machine-readable output")
		.action(async (metric: string, value: string, opts: { json?: boolean }) => {
			process.exitCode = await capsSetAction(metric, value, opts);
		});

	caps
		.command("explain [metric]")
		.description("Explain what each metric means, its default, and how to change it")
		.option("--json", "Machine-readable output")
		.action(async (metric: string | undefined, opts: { json?: boolean }) => {
			process.exitCode = await capsExplainAction(metric, opts);
		});

	caps
		.command("ratchet <metric>")
		.description(
			"Tighten a per-function complexity cap (cyclomatic | cognitive) and regenerate the grandfather ledger for everything over it",
		)
		.requiredOption("--to <n>", "The new (smaller) cap")
		.option("--dry-run", "Report what would change; write nothing")
		.option("--json", "Machine-readable output")
		.action(async (metric: string, opts: { to?: string; dryRun?: boolean; json?: boolean }) => {
			process.exitCode = await capsRatchetAction(metric, opts);
		});

	caps
		.command("propose")
		.description(
			"Data-driven cap proposals from a live census: per-metric percentile ladder (p50/p75/p90/p95/p99), the count each candidate cap would grandfather, and the smallest cap whose ledger stays under the campaign-size budget",
		)
		.option("--json", "Machine-readable output")
		.action(async (opts: { json?: boolean }) => {
			const { capsProposeAction } = await import("../commands/metrics-complexity.js");
			process.exitCode = await capsProposeAction(opts);
		});

	caps
		.command("status")
		.description("Per-metric burn-down of the grandfather ledger: cap, entries remaining, top offenders, delta vs previous")
		.option("--json", "Machine-readable output")
		.action(async (opts: { json?: boolean }) => {
			process.exitCode = await capsStatusAction(opts);
		});
}
