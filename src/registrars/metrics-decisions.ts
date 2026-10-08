import type { Command } from "commander";
import { decisionsAction, type DecisionsOptions } from "../commands/metrics-decisions.js";

export function registerDecisionMetricCommands(metrics: Command): void {
    const group = metrics
        .command("decisions")
        .description(
            "Experimental semantic measurements with local decision models, ThinkThen, and auditable uncertainty",
        );
    const definitions = [
        ["init", "Write a disabled, local-first decision configuration"],
        ["catalog", "Show versioned metric contracts and the ThinkThen question set"],
        ["prepare", "Extract touched function/hunk evidence from git without checkout"],
        ["snapshot", "Index function evidence and import edges at a pinned Git revision"],
        ["candidates <input>", "Build an obligation cohort including consumers not retrieved"],
        ["retrieve <input>", "Attach time-safe BM25, embedding, or hybrid historical neighbors"],
        ["pilot", "Sample real changes and retain unavailable revision counts"],
        ["labels <input>", "Create a blind independent-review label template from a run"],
        ["join-labels <input>", "Join complete adjudicated labels with saved probabilities"],
        ["probe <input>", "Run fresh perturbation, repetition, and batch-composition probes"],
        ["measure <input>", "Measure an evidence population and retain raw probabilities"],
        ["review <input>", "Run relational obligations, atomicity, faithfulness, or comparison"],
        ["embed <input>", "Embed evidence locally, then unload the model"],
        [
            "geometry <input>",
            "Measure provisional embedding churn, dispersion, and nearest-neighbor outliers",
        ],
        ["audit <input>", "Evaluate a full labeled cohort with a temporal split and baselines"],
        ["replay <input>", "Reinterpret a retained run at a new uncertainty band, offline"],
        ["diff <input>", "Compare retained answers and report model/question drift"],
    ];
    for (const [spec, description] of definitions) {
        const name = spec!.split(" ")[0]!;
        const command = group
            .command(spec!)
            .description(description!)
            .option("--cwd <path>", "Project root")
            .option("--config <file>", "Explicit decision configuration")
            .option("--output <file>", "Write an immutable JSON artifact")
            .option("--metrics <ids>", "Comma-separated metric contract IDs")
            .option("--band <low:high>", "Uncertainty band; probabilities are reusable")
            .option("--command <path>", "ThinkThen executable")
            .option("--max-records <n>", "Record budget; excluded records remain unassessed")
            .option("--plan", "Print native request plans without inference")
            .option("--fresh", "Fresh inference; preserve the previous cached observation")
            .option("--base <ref>", "Git base revision")
            .option("--revision <ref>", "Committed revision; default is working tree")
            .option("--file <paths...>", "Restrict changed source files")
            .option("--message <text>", "Description of a working-tree change")
            .option(
                "--analysis <kind>",
                "atomicity, faithfulness, obligations, compare, coupling, rework",
            )
            .option("--claims <file>", "Literal description claims as a JSON array")
            .option("--cutoff <date>", "Train before this date; evaluate at/after it")
            .option("--after <file>", "Second retained run for diff")
            .option("--corpus <file>", "Snapshot or historical function corpus")
            .option("--retrieval <method>", "lexical, embedding, or hybrid")
            .option("--count <n>", "Pilot commit budget (1..1000)")
            .option("--before <date>", "Pilot history upper date bound")
            .option("--labels <file>", "Independent adjudicated label file")
            .option("--max-files <n>", "Snapshot file budget (1..10000)")
            .option("--unit <kind>", "Prepared evidence: function, hunk, or all")
            .option("--bca-command <path>", "Optional pinned bca executable for preparation")
            .option("--bca-version <text>", "Exact required bca --version stdout")
            .option(
                "--comparison <file>",
                "Matched retrieval-arm labeled cohort for five-arm audit",
            )
            .option("--json", "Machine-readable output (always enabled)");
        if (spec!.includes("<input>"))
            command.action(async (input: string, options: DecisionsOptions) => {
                process.exitCode = await decisionsAction(name, input, options);
            });
        else
            command.action(async (options: DecisionsOptions) => {
                process.exitCode = await decisionsAction(name, undefined, options);
            });
    }
}
