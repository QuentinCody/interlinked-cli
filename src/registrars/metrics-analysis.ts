import type { Command, OptionValues } from "commander";

function options(opts: OptionValues, command: Command): OptionValues { return { ...(command.parent?.parent?.opts() ?? {}), ...(command.parent?.opts() ?? {}), ...opts }; }
function common(command: Command): Command { return command.option("--cwd <path>", "Repository root").option("--json", "Machine-readable result").option("--short", "Compact summary"); }

type AnalysisRequest = { kind: "catalog" | "deletions"; opts: OptionValues }
    | { kind: "explain"; metric: string; opts: OptionValues }
    | { kind: "compare"; before: string; after: string; opts: OptionValues };
async function analysisAction(request: AnalysisRequest): Promise<void> {
    const commands = await import("../commands/metrics-analysis.js");
    if (request.kind === "explain") return commands.metricsExplainCommand(request.metric, request.opts);
    if (request.kind === "compare") return commands.metricsCompareCommand(request.before, request.after, request.opts);
    if (request.kind === "catalog") return commands.metricsCatalogCommand(request.opts);
    return commands.metricsDeletionsCommand(request.opts);
}
async function evidenceAction(kind: "status" | "identity" | "run", opts: OptionValues): Promise<void> {
    const commands = await import("../commands/metrics-evidence.js");
    const handlers = { status: commands.metricsEvidenceStatusCommand, identity: commands.metricsEvidenceIdentityCommand, run: commands.metricsEvidenceRunCommand };
    await handlers[kind](opts);
}

function evidenceCommands(metrics: Command): void {
    const evidence = metrics.command("evidence").description("Bound coverage and mutation evidence to source, tests, runner and artifact hashes");
    common(evidence.command("status").description("List current, stale and inconclusive behavioral receipts"))
        .action((opts: OptionValues, command: Command) => evidenceAction("status", options(opts, command)));
    common(evidence.command("identity").description("Export current input hashes for CI receipts"))
        .action((opts: OptionValues, command: Command) => evidenceAction("identity", options(opts, command)));
    common(evidence.command("import <receipt> <artifact>").description("Validate and import a CI-produced receipt and report"))
        .action(async (receipt: string, artifact: string, opts: OptionValues, command: Command) => {
            const { metricsEvidenceImportCommand } = await import("../commands/metrics-evidence.js");
            metricsEvidenceImportCommand(receipt, artifact, options(opts, command));
        });
    common(evidence.command("run").description("Run an explicit command in a bounded isolated copy; no model calls by Interlinked"))
        .requiredOption("--kind <kind>", "coverage or mutation")
        .requiredOption("--command <json>", "JSON argv array, executed without a shell")
        .requiredOption("--artifact <path>", "Repository-relative Istanbul or mutation JSON output")
        .requiredOption("--runner-version <version>", "Declared runner version")
        .requiredOption("--policy <id>", "Coverage/mutation operator policy identity")
        .option("--timeout <ms>", "Total copy and execution budget", "60000")
        .option("--resume", "Reuse a passing receipt only when all inputs and runner identity match")
        .action((opts: OptionValues, command: Command) => evidenceAction("run", options(opts, command)));
}

export function registerMetricsAnalysisCommands(metrics: Command): void {
    coverageCommands(metrics);
    common(metrics.command("corpus <manifest>").description("Score pinned clean local repositories and persist reproducible reports"))
        .requiredOption("--out <directory>", "Directory for per-repository reports and corpus summary")
        .action(async (manifest: string, opts: OptionValues, command: Command) => {
            const { metricsCorpusCommand } = await import("../commands/metrics-corpus.js");
            await metricsCorpusCommand(manifest, { ...options(opts, command), out: String(opts.out) });
        });
    common(metrics.command("catalog").description("List metric contracts and every check/guard disposition"))
        .option("--checks", "Include individual check and guard dispositions")
        .action((opts: OptionValues, command: Command) => analysisAction({ kind: "catalog", opts: options(opts, command) }));
    common(metrics.command("explain <metric>").description("Explain one metric's denominator, burden and composite weight"))
        .action((metric: string, opts: OptionValues, command: Command) => analysisAction({ kind: "explain", metric, opts: options(opts, command) }));
    common(metrics.command("compare <before> <after>").description("Compare saved score JSON with profile and evidence compatibility checks"))
        .action((before: string, after: string, opts: OptionValues, command: Command) => analysisAction({ kind: "compare", before, after, opts: options(opts, command) }));
    const deletions = common(metrics.command("deletions").description("Join redundancy, reachability, coverage and survivor review candidates"))
        .action((opts: OptionValues, command: Command) => analysisAction({ kind: "deletions", opts: options(opts, command) }));
    common(deletions.command("validate <plan>").description("Test an explicit removal plan in an isolated copy; preserve the repository"))
        .option("--timeout <ms>", "Total trial budget", "60000")
        .action(async (plan: string, opts: OptionValues, command: Command) => {
            const { metricsRemovalValidateCommand } = await import("../commands/metrics-evidence.js");
            await metricsRemovalValidateCommand(plan, options(opts, command));
        });
    evidenceCommands(metrics);
}

function coverageCommands(metrics: Command): void {
    common(metrics.command("gates").description("Show disabled gates, actual coverage executions, freshness and runtime percentiles"))
        .action(async (opts: OptionValues, command: Command) => {
            const { metricsGatesCommand } = await import("../commands/metrics-coverage-ops.js");
            metricsGatesCommand(options(opts, command));
        });
    const coverage = metrics.command("coverage").description("Operate the exact Vitest contribution index used by per-edit coverage");
    for (const kind of ["warm", "status"] as const) common(coverage.command(kind).description(kind === "warm" ? "Measure the full suite in an overlay and initialize the contribution index" : "Validate coverage index inputs and report stale shards"))
        .option("--timeout <ms>", "Coverage execution budget", "60000")
        .action(async (opts: OptionValues, command: Command) => {
            const { metricsCoverageCommand } = await import("../commands/metrics-coverage-ops.js");
            await metricsCoverageCommand(kind, options(opts, command));
        });
}
