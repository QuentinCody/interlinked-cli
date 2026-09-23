import type { Command, OptionValues } from "commander";

export function registerE2eCommands(program: Command): void {
    program.command("e2e").description("End-to-end tests for hook and daemon boundaries")
        .command("scaffold <name>").description("Create a fixture-backed e2e test with a failing contract assertion")
        .option("--event <event>", "PreToolUse, PostToolUse or Stop", "PreToolUse")
        .option("--tool <tool>", "Native tool name", "Edit")
        .option("--cwd <path>", "Project root")
        .option("--dry-run", "Print the test without writing it")
        .action(async (name: string, options: OptionValues) => {
            const { e2eScaffoldCommand } = await import("../commands/e2e.js");
            e2eScaffoldCommand(name, options);
        });
}
