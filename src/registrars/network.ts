import type { Command } from "commander";

export function registerNetworkCommands(program: Command): void {
    const network = program.command("network").description("Diagnose command-network access and prepare host permission profiles");
    network.command("check <endpoints...>")
        .description("Probe HTTP(S) origins from this process, without credentials or inference")
        .option("--json", "Machine-readable runtime evidence")
        .action(async (endpoints: string[], options: { json?: boolean }) => {
            const { networkCheckCommand } = await import("../commands/network.js");
            await networkCheckCommand(endpoints, options);
        });
    network.command("codex-profile <name>")
        .description("Preview a reusable workspace-restricted Codex network profile")
        .requiredOption("--allow <endpoints...>", "HTTP(S) endpoints whose exact hosts may be reached")
        .option("--write", "Create $CODEX_HOME/<name>.config.toml; refuse conflicting existing files")
        .option("--json", "Machine-readable output")
        .action(async (name: string, options: { allow: string[]; write?: boolean; json?: boolean }) => {
            const { networkCodexProfileCommand } = await import("../commands/network.js");
            networkCodexProfileCommand(name, options);
        });
}
