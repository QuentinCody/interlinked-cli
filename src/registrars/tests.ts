import { type Command, type OptionValues } from "commander";

function registerContracts(tests: Command): void {
    const contracts = tests.command("contracts").description("Inspect provenance or explicitly execute portable behavioral contracts");
    contracts.command("import <source>")
        .description("Print proposed cases from explicit json interlinked-contract fences; never execute")
        .option("--cwd <path>", "Project root").option("--json", "Machine-readable proposed manifest")
        .action(async (source: string, options: OptionValues) => {
            const { testsContractsCommand } = await import("../commands/tests-contracts.js");
            await testsContractsCommand("import", { ...options, source });
        });
    for (const action of ["inspect", "run"] as const) {
        contracts.command(action)
            .description(action === "run" ? "Execute declared runners and retain per-case receipts" : "Inspect provenance and configured acceptance without execution")
            .option("--cwd <path>", "Project root")
            .option("--file <path>", "Project-relative contract manifest", ".interlinked/behavioral-contracts.json")
            .option("--previous <path>", "Prior manifest whose cases also run against current implementation")
            .option("--timeout <ms>", "Total admission and execution budget", "60000")
            .option("--json", "Machine-readable contract evidence")
            .action(async (options: OptionValues) => {
                const { testsContractsCommand } = await import("../commands/tests-contracts.js");
                await testsContractsCommand(action, options);
            });
    }
}

export function registerTestsCommands(program: Command): void {
    const tests = program.command("tests").description("Explain and run affected tests with bounded scheduling and snapshot validation");
    registerContracts(tests);
    tests.command("review [paths...]")
        .description("Review changed source, behavioral obligations and bounded simplification candidates without running tests")
        .option("--cwd <path>", "Project root")
        .option("--base <ref>", "Revision for automatic changed-file discovery", "HEAD")
        .option("--json", "Machine-readable review scope and missing evidence")
        .action(async (paths: string[], options: OptionValues) => {
            const { testsReviewCommand } = await import("../commands/tests-review.js");
            testsReviewCommand(paths, options);
        });
    tests.command("readiness <language>")
        .description("Inspect test prerequisites without installing; Python also reports approved provisioning argv")
        .option("--cwd <path>", "Project root")
        .option("--json", "Machine-readable readiness and missing prerequisites")
        .action(async (language: string, options: OptionValues) => {
            const { testsReadinessCommand } = await import("../commands/tests-readiness.js");
            await testsReadinessCommand(language, options);
        });
    tests.command("suite <language>")
        .description("Run a bounded project suite: typescript, javascript, python, rust or go")
        .option("--cwd <path>", "Project root")
        .option("--timeout <ms>", "Total admission and execution budget", "60000")
        .option("--json", "Machine-readable execution evidence")
        .action(async (language: string, options: OptionValues) => {
            const { testsSuiteCommand } = await import("../commands/tests-suite.js");
            await testsSuiteCommand(language, options);
        });
    const descriptions = { plan: "Explain the union of affected tests without running assertions",
        run: "Run pending and affected tests; retain newer edits for another run", status: "Show pending requests and the last observed test job" };
    for (const kind of ["plan", "run", "status"] as const) {
        tests.command(`${kind} [paths...]`)
            .description(descriptions[kind])
            .option("--cwd <path>", "Project root")
            .option("--base <ref>", "Compare tracked changes against this revision", "HEAD")
            .option("--all", "Run the full suite for reconciliation")
            .option("--timeout <ms>", "Total planning, admission and execution budget", "60000")
            .option("--workers <count>", "Maximum workers, also bounded by available memory", "2")
            .option("--json", "Machine-readable test plan or execution")
            .action(async (paths: string[], options: OptionValues) => {
                const { testsCommand } = await import("../commands/tests.js");
                await testsCommand(kind, paths, options);
            });
    }
}
