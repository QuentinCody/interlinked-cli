import type { Command } from "commander";
import { lintCheckCommand, lintImportCommand, lintScanCommand } from "../commands/lint.js";

async function withLintErrors(task: () => void | Promise<void>, options: { json?: boolean }): Promise<void> {
    try { await task(); }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.json) console.log(JSON.stringify({ complete: false, error: message }));
        else console.error(`Lint NOT CHECKED: ${message}`);
        process.exitCode = 2;
    }
}

export function registerLintCommands(program: Command): void {
    const lint = program.command("lint").description("Discover and adopt existing lint configurations as Interlinked checks and debt gates");
    lint.command("scan [target]").description("Inventory lint configs, declarations, ignores and scripts across nested packages")
        .option("--json", "Machine-readable inventory and import plan")
        .option("--details", "Show bounded source declaration excerpts")
        .action((target = ".", options) => withLintErrors(() => lintScanCommand(target, options), options));
    lint.command("import [target]").description("Preview or apply lint adoption while preserving original analyzer semantics")
        .option("--write", "Write the import policy and enable its PostToolUse check")
        .option("--baseline", "With --write, run analyzers and seed or tighten existing-debt allowances")
        .option("--eslint-config <file>", "Select an ESLint config relative to target (repeatable)", (file: string, selected: string[]) => [...selected, file], [])
        .option("--eslint-scope <directory>", "Working directory and lint target for selected ESLint configs, relative to target (default: .)")
        .option("--config <tool=file>", "Select any supported analyzer config (repeatable)", (value: string, selected: string[]) => [...selected, value], [])
        .option("--scope <directory>", "Working directory for --config selections (default: .)")
        .option("--cadence <cadence>", "Set imported profiles to hook or audit cadence")
        .option("--timeout <ms>", "Total analyzer batch budget, up to 300000 ms", "30000")
        .option("--json", "Machine-readable import plan/result")
        .option("--details", "Show bounded source declaration excerpts")
        .action((target = ".", options) => withLintErrors(() => lintImportCommand(target, options), options));
    lint.command("check [target]").description("Gate imported lint findings: exit 1 for new debt, 2 when no complete verdict exists")
        .option("--update-baseline", "Seed unadopted scopes and tighten existing allowances after complete analysis")
        .option("--timeout <ms>", "Total analyzer batch budget, up to 300000 ms", "30000")
        .option("--json", "Machine-readable findings and measurement status")
        .action((target = ".", options) => withLintErrors(() => lintCheckCommand(target, options), options));
}
