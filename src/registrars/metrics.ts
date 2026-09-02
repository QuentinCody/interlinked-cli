import { type Command, type OptionValues } from "commander";

function parentAndChildOptions(opts: OptionValues, command: Command): OptionValues {
    return { ...(command.parent?.opts() ?? {}), ...opts };
}

function registerCouplingCommand(metrics: Command): void {
    metrics
        .command("coupling")
        .description(
            "Change coupling from git history — co-changed file pairs; pairs with no import edge are flagged 'hidden'",
        )
        .option("--cwd <path>", "Project root (default: current directory)")
        .option("--since <when>", "git --since expression (default: '90 days ago')")
        .option("--min-support <n>", "Minimum co-change commits per pair (default: 4)")
        .option("--max-commit-files <n>", "Skip bulk commits touching more files (default: 30)")
        .option("--min-strength <pct>", "Minimum Tornhill strength percentage (default: 30)")
        .option("--limit <n>", "Maximum pairs to report (default: 25)")
        .option("--json", "Machine-readable output")
        .option("--short", "One-line summary")
        .action(async (opts: OptionValues, command: Command) => {
            const { metricsCouplingCommand } = await import("../commands/metrics-coupling.js");
            await metricsCouplingCommand(parentAndChildOptions(opts, command));
        });
}

function registerArchitectureCommand(metrics: Command): void {
    metrics
        .command("arch")
        .description(
            "Martin metrics per directory (Ca/Ce/instability) + propagation cost from the import graph",
        )
        .option("--cwd <path>", "Project root (default: current directory)")
        .option("--depth <n>", "Directory fold depth (default: 2)")
        .option("--include-tests", "Include test files in the edge set")
        .option("--json", "Machine-readable output")
        .option("--short", "One-line summary")
        .action(async (opts: OptionValues, command: Command) => {
            const { metricsArchCommand } = await import("../commands/metrics-arch.js");
            await metricsArchCommand(parentAndChildOptions(opts, command));
        });
}

function registerComplexityCommand(metrics: Command): void {
    metrics
        .command("complexity")
        .description(
            "Complexity census: percentiles, histograms, top-N hotspots, per-file mass, and over-cap counts for cyclomatic / cognitive / lines",
        )
        .option("--cwd <path>", "Project root (default: current directory)")
        .option("--top <n>", "Hotspots per metric and files by mass (default: 20)")
        .option("--metric <name>", "cyclomatic | cognitive | lines | all (default: all)")
        .option("--json", "Machine-readable output")
        .option("--short", "One-line summary")
        .action(async (opts: OptionValues, command: Command) => {
            const { metricsComplexityCommand } = await import("../commands/metrics-complexity.js");
            await metricsComplexityCommand(parentAndChildOptions(opts, command));
        });
}

function registerSplitPlanCommand(metrics: Command): void {
    metrics
        .command("split-plan <file>")
        .description(
            "Where to cut one over-cap file: intra-file reference graph (TS AST) → 2–4 cohesive modules with line count, ΣCC, imports, a suggested filename each, and the cross-module references the split creates",
        )
        .option("--cwd <path>", "Project root (default: current directory)")
        .option("--max-clusters <n>", "Upper bound on proposed modules, 2–4 (default: 4)")
        .option("--json", "Machine-readable output")
        .option("--short", "One-line summary")
        .action(async (file: string, opts: OptionValues, command: Command) => {
            const { metricsSplitPlanCommand } = await import("../commands/metrics-split-plan.js");
            await metricsSplitPlanCommand({ ...parentAndChildOptions(opts, command), file });
        });
}

function registerReworkCommand(metrics: Command): void {
    metrics
        .command("rework")
        .description(
            "Churn age from git blame — share of changed lines whose previous version was written in the last --window days",
        )
        .option("--cwd <path>", "Project root (default: current directory)")
        .option("--days <n>", "How far back to scan commits (default: 30)")
        .option("--window <n>", "Rework age threshold in days (default: 14)")
        .option("--max-commits <n>", "Commit scan cap (default: 100)")
        .option("--max-commit-files <n>", "Skip bulk commits touching more files (default: 30)")
        .option("--json", "Machine-readable output")
        .option("--short", "One-line summary")
        .action(async (opts: OptionValues, command: Command) => {
            const { metricsReworkCommand } = await import("../commands/metrics-rework.js");
            await metricsReworkCommand(parentAndChildOptions(opts, command));
        });
}

export function registerMetricsCommands(program: Command): void {
    const metrics = program
        .command("metrics")
        .description(
            "Scan the whole codebase: function tokens, companion-test presence, coverage, complexity, and CRAP",
        )
        .option("--cwd <path>", "Project root (default: current directory)")
        .option("--top <n>", "Number of function/file token and CRAP hotspots to show (default: 25)")
        .option("--include-tests", "Include test/spec functions as advisory token measurements")
        .option("--json", "Machine-readable output (full per-file + per-function)")
        .option("--short", "One-line summary")
        .option("--full", "Show every per-file and per-function token measurement")
        .action(async (opts: OptionValues) => {
            const { metricsCommand } = await import("../commands/metrics.js");
            await metricsCommand(opts);
        });

    registerCouplingCommand(metrics);
    registerArchitectureCommand(metrics);
    registerReworkCommand(metrics);
    registerComplexityCommand(metrics);
    registerSplitPlanCommand(metrics);
}
