import { join } from "node:path";
import type { OptionValues } from "commander";
import { repairHistoryLoss } from "../harness/hook-coverage-ledger.js";
import { getOutputMode, output } from "../lib/output.js";
import { isHarnessRunning } from "./harness-process.js";
import { collectServingDaemonPids } from "./harness-daemon-control.js";

/** `interlinked harness coverage repair-history`: an offline, explicit repair of
 *  a hook-coverage history log that is shorter than its committed pointer. It
 *  touches only `.interlinked/hook-coverage.json` and its sibling log; the
 *  daemon must be restarted afterwards to load the repaired ledger. */
export async function harnessCoverageRepairCommand(opts: OptionValues): Promise<void> {
    const cwd = process.cwd();
    if (isHarnessRunning(cwd).running || (await collectServingDaemonPids(cwd)).size > 0) {
        throw new Error("Stop the daemon (`interlinked harness stop`) before repairing history; its in-memory ledger must not overwrite the repair.");
    }
    const path = join(cwd, ".interlinked", "hook-coverage.json");
    const result = repairHistoryLoss(path);
    output(getOutputMode(opts), result, {
        json: () => result,
        normal: () => [
            `${result.repaired ? "Repaired" : "No repair"}: ${result.detail}`,
            ...(result.orphan ? [`Partial log set aside at ${result.orphan}`] : []),
            ...(result.repaired ? ["Restart the daemon (`interlinked harness restart`) to load the repaired ledger."] : []),
        ].join("\n"),
    });
}
