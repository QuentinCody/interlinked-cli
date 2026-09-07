import type { Command, OptionValues } from "commander";
import type { DataOperation } from "../commands/data.js";
import { registerDataAuditCommands } from "./data-audit.js";
import { registerDataMaintenanceCommands } from "./data-maintenance.js";
import { registerDataLabCommands } from "./data-lab.js";

function common(command: Command): Command {
    return command.option("--cwd <path>", "Project root")
        .option("--json", "Machine-readable output").option("--short", "Compact JSON");
}
function filters(command: Command): Command {
    for (const name of ["source", "category", "session", "actor", "provider", "model", "file", "check", "kind", "decision", "origin", "call"]) {
        command.option(`--${name} <value>`, `Exact ${name} filter`);
    }
    return command.option("--since <time>", "Event time: duration or ISO timestamp; excludes undated records")
        .option("--until <time>", "Latest event time: duration or ISO timestamp")
        .option("--limit <n>", "Maximum results (1..1000)").option("--no-archives", "Only retained live-source evidence");
}
function action(command: Command, operation: DataOperation): void {
    common(command).action(async (options: OptionValues) => {
        const { dataCommand } = await import("../commands/data.js");
        await dataCommand(operation, options);
    });
}

export function registerDataCommands(program: Command): void {
    const data = program.command("data").description("Discover, assess, index and search all local JSONL evidence");
    registerDataAuditCommands(data);
    registerDataMaintenanceCommands(data);
    registerDataLabCommands(data);
    common(filters(data.command("scan [text]").description("Search bounded live JSONL/gzip directly, without SQLite or copying logs")))
        .option("--max-mb <n>", "Expanded scan budget (default 32, maximum 1024 MiB)")
        .option("--max-records <n>", "Physical line budget (default 25000)")
        .option("--offset <n>", "Result offset within the scanned scope")
        .option("--raw", "Include original record text and hash in returned rows")
        .option("--full-text", "Match all decoded string values, beyond the bounded index projection")
        .action(async (text: string | undefined, options: OptionValues) => {
            const { dataScanCommand } = await import("../commands/data-scan.js");
            await dataScanCommand(options, text);
        });
    action(data.command("recurrence-inventory").description("Latest scoped finding inventory, distinct from incident counts"), "recurrence-inventory");
    action(filters(data.command("investigate").description("Correlate session/call/file evidence, missing phases and folded file obligations")), "investigate");
    action(data.command("catalog").description("Registered source contracts and recursively discovered files"), "catalog");
    action(data.command("health").description("Producer receipts, unknowns, storage and index coverage"), "health");
    action(data.command("status").description("Index freshness, incomplete sources and parse failures"), "status");
    action(data.command("index").description("Incrementally index live files and gzip archives; repeat to resume")
        .option("--max-mb <n>", "Expanded byte budget per run (configured default: 256)")
        .option("--max-records <n>", "Record budget per run (configured default: 250000)")
        .option("--rebuild", "Clear and rebuild only the derived index; raw evidence is preserved")
        .option("--source <name>", "One logical source").option("--no-archives", "Skip archive segments"), "index");
    common(filters(data.command("search [text]").description("Full-text and structured search over the local index")))
        .option("--fts", "Interpret text as SQLite FTS5 grammar")
        .option("--offset <n>", "Result offset")
        .action(async (text: string | undefined, options: OptionValues) => {
            const { dataCommand } = await import("../commands/data.js");
            await dataCommand("search", options, text);
        });
    common(data.command("show <id>").description("Retrieve original evidence bytes and verify the indexed hash"))
        .action(async (id: string, options: OptionValues) => {
            const { dataCommand } = await import("../commands/data.js");
            await dataCommand("show", options, id);
        });
    for (const view of ["sessions", "files", "checks", "usage", "schema", "suggestions"] as const) {
        action(filters(data.command(view).description(`Indexed ${view} evidence with coverage and provenance`)), view);
    }
}
