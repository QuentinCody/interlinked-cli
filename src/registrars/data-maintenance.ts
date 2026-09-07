import type { Command, OptionValues } from "commander";

export function registerDataMaintenanceCommands(data: Command): void {
    data.command("maintain").description("Plan evidence-class retention; optionally index and losslessly rotate supported logs")
        .option("--execute", "Run explicitly requested or configured maintenance")
        .option("--index", "Also run the SQLite importer (independent of rotation)")
        .option("--no-index", "Skip the importer even if automatic indexing is configured")
        .option("--compact", "Also rotate eligible collection/timeline logs; retains gzip evidence")
        .option("--cwd <path>", "Project root").option("--json", "Machine-readable output")
        .action(async (options: OptionValues) => {
            const { dataMaintenanceCommand } = await import("../commands/data-maintenance.js");
            await dataMaintenanceCommand("maintain", options);
        });
    data.command("configure").description("Show or update local data automation and import budgets")
        .option("--auto-index <on|off>", "Index in the governed background lane at session end")
        .option("--auto-compact <on|off>", "Losslessly rotate supported event logs during maintenance")
        .option("--index-mb <n>", "Expanded byte budget per index pass")
        .option("--index-records <n>", "Record budget per index pass")
        .option("--keep-live-mb <n>", "Retained live tail size")
        .option("--compact-at-mb <n>", "Live-size threshold for eligible logs")
        .option("--cwd <path>", "Project root").option("--json", "Machine-readable output")
        .action(async (options: OptionValues) => {
            const { dataMaintenanceCommand } = await import("../commands/data-maintenance.js");
            await dataMaintenanceCommand("configure", options);
        });
}
