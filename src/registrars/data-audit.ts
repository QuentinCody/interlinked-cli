import type { Command, OptionValues } from "commander";
import { outputError } from "../lib/output.js";

async function auditAction(operation: "diagnose" | "checkpoint" | "verify", options: OptionValues): Promise<void> {
    try {
        const { diagnoseDataAudit, createDataAuditCheckpoint } = await import("../lib/data/audit.js");
        const cwd = typeof options.cwd === "string" ? options.cwd : process.cwd();
        const { verifyDataCheckpoint } = await import("../lib/data/audit-checkpoint-verify.js");
        const result = operation === "verify" ? await verifyDataCheckpoint(cwd, String(options.checkpoint)) : operation === "diagnose" ? await diagnoseDataAudit(cwd)
            : await createDataAuditCheckpoint(cwd, typeof options.reason === "string" ? options.reason : "");
        console.log(JSON.stringify(result, null, 2));
        if (result.valid === false) process.exitCode = 1;
    } catch (error) {
        outputError(options.json ? "json" : "normal", error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
export function registerDataAuditCommands(data: Command): void {
    const audit = data.command("audit").description("Locate historical audit failures and record explicit observation boundaries");
    audit.command("verify").description("Verify retained evidence after an explicit checkpoint, including after rotation")
        .requiredOption("--checkpoint <id>", "Checkpoint identifier")
        .option("--cwd <path>", "Project root").option("--json", "Machine-readable output")
        .action(async (options: OptionValues) => auditAction("verify", options));
    audit.command("diagnose").description("Verify archives/live data and locate the first failing physical record")
        .option("--cwd <path>", "Project root").option("--json", "Machine-readable output")
        .action(async (options: OptionValues) => auditAction("diagnose", options));
    audit.command("checkpoint").description("Record a verified live-tail boundary; historical verdict stays unchanged")
        .requiredOption("--reason <text>", "Investigation/recovery reason")
        .option("--cwd <path>", "Project root").option("--json", "Machine-readable output")
        .action(async (options: OptionValues) => auditAction("checkpoint", options));
}
