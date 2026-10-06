import type { Command, OptionValues } from "commander";

export function registerHarnessInventory(harness: Command): void {
    registerHealth(harness);
    registerCorpus(harness);
    harness.command("explain <topic>").description("Explain implementation, local policy, client support and observed evidence separately")
        .option("--client <client>", "Client whose declared hook capabilities to show").option("--json", "Full policy and observation identities")
        .action(async (topic: string, opts: OptionValues) => {
            const { harnessExplainCommand } = await import("../commands/harness-explain.js");
            await harnessExplainCommand(topic, opts);
        });
    harness.command("checks")
        .description("Show the authoritative check inventory — per-family counts + total (static; no daemon needed)")
        .option("--json", "Machine-readable output").option("--short", "One-line summary").option("--full", "Include each count's authoritative source")
        .action(async (opts: OptionValues) => { const { harnessChecksCommand } = await import("../commands/harness-checks.js"); harnessChecksCommand(opts); });
    harness.command("capabilities").description("Inspect runtime hook profiles, selected events, installation and observation evidence")
        .option("--json", "Full capability catalog and coverage identities")
        .action(async (opts: OptionValues) => { const { harnessCapabilitiesCommand } = await import("../commands/harness-capabilities.js"); await harnessCapabilitiesCommand(opts); });
    registerCoverage(harness);
}

function registerCorpus(harness: Command): void {
    const corpus = harness.command("corpus").description("Inspect and refresh versioned detector corpus evidence");
    for (const action of ["status", "scan"] as const) {
        corpus.command(action + " [checks...]").description(action === "scan"
            ? "Scan src with up to 20 named detectors; default: three qualification candidates; retains prior evidence"
            : "Show freshness, scope, adjudication and control evidence")
            .option("--json", "Machine-readable evidence")
            .action(async (ids: string[], opts: OptionValues) => {
                const { harnessCorpusCommand } = await import("../commands/harness-corpus.js");
                harnessCorpusCommand(action, ids, opts);
            });
    }
}

function registerHealth(harness: Command): void {
    harness.command("health")
        .description("Check health: recurrence, finding outcomes, compatible rechecks and missing evidence")
        .option("--json", "Machine-readable output").option("--short", "One-line summary")
        .option("--full", "Show every check id (default: top 25 by repeat-rate)")
        .option("--recheck", "Recheck up to 20 files with the file-only detector cohort")
        .option("--file <paths...>", "Explicit files for --recheck (default: observed finding files)")
        .action(async (opts: OptionValues) => {
            const { harnessHealthCommand } = await import("../commands/harness-health.js");
            await harnessHealthCommand(opts);
        });
}

function registerCoverage(harness: Command): void {
    const coverage = harness.command("coverage").description("Inspect and review daemon-owned filesystem observations");
    coverage.command("status", { isDefault: true }).option("--json", "Machine-readable output")
        .option("--progress", "Read cached recovery progress without rescanning files or returning receipt history")
        .action(async (opts: OptionValues) => { const { harnessCoverageCommand } = await import("../commands/harness-capabilities.js"); await harnessCoverageCommand({ operation: "status", ...(opts.progress ? { detail: "progress" } : {}) }, opts); });
    coverage.command("verify").description("Check pending file versions and retain exact-version evidence and findings")
        .option("--json", "Machine-readable output").option("--no-wait", "Start the daemon verification job and return immediately")
        .action(async (opts: OptionValues) => { const { harnessCoverageVerifyCommand } = await import("../commands/harness-coverage-verify.js"); await harnessCoverageVerifyCommand(opts); });
    coverage.command("accept-policy <digest>").description("Explicitly accept the exact current protected-policy digest")
        .option("--json", "Machine-readable output")
        .action(async (digest: string, opts: OptionValues) => { const { harnessCoverageCommand } = await import("../commands/harness-capabilities.js"); await harnessCoverageCommand({ operation: "accept_policy", digest }, opts); });
    coverage.command("acknowledge <id> <generation> <identity> <evidence>").description("Record manual review evidence for an exact pending file version; does not claim automated checks")
        .option("--json", "Machine-readable output")
        .action(async (id: string, generation: string, identity: string, evidence: string, opts: OptionValues) => {
            const parsed = Number(generation);
            if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("generation must be a nonnegative integer");
            const { harnessCoverageCommand } = await import("../commands/harness-capabilities.js");
            await harnessCoverageCommand({ operation: "acknowledge", id, generation: parsed, identity, evidence }, opts);
        });
}
