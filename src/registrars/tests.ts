import { type Command, type OptionValues } from "commander";

export function registerTestsCommands(program: Command): void {
    const tests = program.command("tests").description("Explain and run affected tests with bounded scheduling and snapshot validation");
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
