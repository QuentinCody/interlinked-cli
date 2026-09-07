import type { Command, OptionValues } from "commander";

export function registerDataLabCommands(data: Command): void {
    const lab = data.command("lab").description("Explicit, isolated evidence storage experiments; preserves original logs and indexes");
    for (const operation of ["generate", "snapshot", "build", "search", "show", "fts", "analytics-export", "analytics-query", "benchmark", "worker"] as const) {
        lab.command(operation).description(`Evidence experiment: ${operation}`)
            .option("--corpus <path>", "Frozen corpus directory")
            .option("--out <path>", "New private output directory (must not exist)")
            .option("--index <path>", "Existing experiment index/segment directory")
            .option("--engine <name>", "scan, gzip, legacy, compact, bounded, segments or cloud", "scan")
            .option("--engines <list>", "Benchmark engine list; cloud requires endpoint", "scan,gzip,legacy,compact,bounded,segments")
            .option("--query <json>", "Portable literal-text and exact-field query JSON", "{}")
            .option("--id <hash>", "Evidence ID to retrieve with original-byte verification")
            .option("--cwd <path>", "Source project for an explicit snapshot")
            .option("--native-dir <path>", "Explicit Claude transcript directory; no automatic home-directory import")
            .option("--max-mb <n>", "Snapshot expanded-byte budget", "32")
            .option("--records <n>", "Synthetic count or snapshot record budget", "20000")
            .option("--payload-bytes <n>", "Synthetic payload bytes per event", "1024")
            .option("--max-files <n>", "Snapshot file count limit", "16")
            .option("--disk-mb <n>", "Bounded index total disk budget including reserved rollback journal", "8")
            .option("--repetitions <n>", "Benchmark query repetitions, including first", "5")
            .option("--endpoint <url>", "Cloud benchmark endpoint; uploads synthetic corpora only")
            .option("--account <id>", "R2 SQL account ID")
            .option("--bucket <name>", "R2 Data Catalog bucket")
            .option("--table <namespace.table>", "R2 SQL Iceberg table")
            .option("--tenant <name>", "Analytics tenant scope")
            .option("--project <name>", "Analytics project scope")
            .option("--job <path>", "Private benchmark worker job")
            .option("--json", "Machine-readable output (always emitted)")
            .action(async (options: OptionValues) => {
                const { dataLabCommand } = await import("../commands/data-lab.js");
                await dataLabCommand(operation, options);
            });
    }
}
