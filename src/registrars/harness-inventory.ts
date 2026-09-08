import type { Command, OptionValues } from "commander";

export function registerHarnessInventory(harness: Command): void {
    harness.command("checks")
        .description("Show the authoritative check inventory — per-family counts + total (static; no daemon needed)")
        .option("--json", "Machine-readable output").option("--short", "One-line summary").option("--full", "Include each count's authoritative source")
        .action(async (opts: OptionValues) => { const { harnessChecksCommand } = await import("../commands/harness-checks.js"); harnessChecksCommand(opts); });
    harness.command("capabilities").description("Inspect runtime hook profiles, selected events, installation and observation evidence")
        .option("--json", "Full capability catalog and coverage identities")
        .action(async (opts: OptionValues) => { const { harnessCapabilitiesCommand } = await import("../commands/harness-capabilities.js"); await harnessCapabilitiesCommand(opts); });
    registerCoverage(harness);
}

function registerCoverage(harness: Command): void {
    const coverage = harness.command("coverage").description("Inspect and review daemon-owned filesystem observations");
    coverage.command("status", { isDefault: true }).option("--json", "Machine-readable output")
        .action(async (opts: OptionValues) => { const { harnessCoverageCommand } = await import("../commands/harness-capabilities.js"); await harnessCoverageCommand({ operation: "status" }, opts); });
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
