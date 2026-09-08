import { setTimeout } from "node:timers/promises";
import type { OptionValues } from "commander";
import type { HookCoverageReport } from "../harness/hook-coverage-control.js";
import { getOutputMode, output } from "../lib/output.js";
import { queryHookCoverage } from "./harness-capabilities.js";

const POLL_MS = 1000;

async function waitForVerification(cwd: string, initial: HookCoverageReport): Promise<HookCoverageReport> {
    const id = initial.verification?.id;
    let result = initial;
    while (result.verification?.status === "running") {
        await setTimeout(POLL_MS);
        result = await queryHookCoverage(cwd, { operation: "status" });
        if (result.verification?.id !== id) {
            return { ...result, readiness: "unmeasured", reason: "Verification job changed or daemon restarted; inspect pending versions and retry" };
        }
    }
    return result;
}

export async function harnessCoverageVerifyCommand(opts: OptionValues): Promise<void> {
    const cwd = process.cwd();
    const initial = await queryHookCoverage(cwd, { operation: "verify" });
    const result = opts.wait === false ? initial : await waitForVerification(cwd, initial);
    output(getOutputMode(opts), result, {
        json: () => result,
        normal: () => {
            const job = result.verification;
            if (!job) return result.reason ?? "Coverage verifier unavailable; rebuild and restart the daemon";
            return `Verification ${job.status}: ${job.checked}/${job.total} versions checked, ${job.findings} finding(s), ${result.pending?.length ?? "unknown"} pending.\nReceipts enumerate completed PostToolUse checks; policy acceptance and writer identity are separate.\n${job.unmeasured.join("\n")}`.trimEnd();
        },
    });
    if (initial.changed !== true || result.readiness !== "ready") { process.exitCode = 1; return; }
    if (result.verification?.status === "complete" && (result.pending?.length || result.verification.findings)) process.exitCode = 1;
}
