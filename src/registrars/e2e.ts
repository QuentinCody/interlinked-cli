import type { Command, OptionValues } from "commander";

export function registerE2eCommands(program: Command): void {
    program.command("e2e").description("Interlinked's OWN hook/daemon boundary tests (self-test lane); host projects use `interlinked tests e2e`")
        .command("scaffold <name>").description("Create a fixture-backed e2e test with a failing contract assertion (Interlinked checkout only; developer preset elsewhere)")
        .option("--event <event>", "PreToolUse, PostToolUse or Stop", "PreToolUse")
        .option("--tool <tool>", "Native tool name", "Edit")
        .option("--cwd <path>", "Project root")
        .option("--dry-run", "Print the test without writing it")
        .option("--developer-preset", "Write the Interlinked-private preset outside the Interlinked checkout (never emitted into a host project by default)")
        .action(async (name: string, options: OptionValues) => {
            const { e2eScaffoldCommand } = await import("../commands/e2e.js");
            e2eScaffoldCommand(name, options);
        });
}
