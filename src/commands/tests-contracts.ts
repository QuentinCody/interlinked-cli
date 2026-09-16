import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { importContractExamples, inspectContracts } from "../harness/contracts/evidence.js";
import { runContracts } from "../harness/contracts/runner.js";
import type { ContractReport } from "../harness/contracts/types.js";
interface Options { cwd?: string; file?: string; source?: string; previous?: string; timeout?: string; json?: boolean; }
function retainReceipt(root: string, report: ContractReport): string {
    const directory = join(root, ".interlinked", "contract-runs");
    mkdirSync(directory, { recursive: true });
    if (realpathSync(directory) !== directory) throw new Error("Contract evidence directory crosses a symlink");
    const path = join(directory, `${Date.now()}-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return path;
}
async function executeContracts(root: string, options: Options): Promise<ContractReport & { receipt: string }> {
    const report = await runContracts(root, { timeoutMs: Number(options.timeout ?? "60000"), ...(options.file ? { path: options.file } : {}), ...(options.previous ? { previous: options.previous } : {}) });
    return { ...report, receipt: retainReceipt(root, report) };
}
/** Invocation authorizes the selected runner, never acceptance of its expectations. */
export async function testsContractsCommand(action: "inspect" | "run" | "import", options: Options): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const root = realpathSync(options.cwd ?? process.cwd());
        if (action === "import") {
            if (!options.source) throw new Error("A source document is required");
            const manifest = importContractExamples(root, options.source);
            output(mode, manifest, { normal: () => JSON.stringify(manifest, null, 2) });
            return;
        }
        const report = action === "run" ? await executeContracts(root, options) : inspectContracts(root, options.file).report;
        output(mode, report, { normal: () => report.cases.map(row => `${row.id}: ${row.state}; ${row.authority}; provenance ${row.provenance}\n${row.details.join("\n")}`).concat(report.gaps).join("\n") });
        const unsuccessful = action === "run" && report.cases.some(row => row.state !== "passed");
        if (report.gaps.length || unsuccessful) process.exitCode = 1;
    } catch (error) { outputError(mode, error instanceof Error ? error.message : String(error)); }
}
