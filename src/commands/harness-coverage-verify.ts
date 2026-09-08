import { setTimeout } from "node:timers/promises";
import type { OptionValues } from "commander";
import type { HookCoverageReport } from "../harness/hook-coverage-control.js";
import { getOutputMode, output } from "../lib/output.js";
import { queryHookCoverage } from "./harness-capabilities.js";

const POLL_MS = 1000;
const MAX_UNAVAILABLE_POLLS = 3;

async function pollAvailableStatus(cwd: string): Promise<HookCoverageReport> {
    let result: HookCoverageReport = { readiness: "unmeasured" };
    for (let attempt = 0; attempt < MAX_UNAVAILABLE_POLLS; attempt++) {
        await setTimeout(POLL_MS);
        result = await queryHookCoverage(cwd, { operation: "status" });
        if (result.readiness === "ready") return result;
    }
    return { ...result, reason: `Coverage status unavailable after ${MAX_UNAVAILABLE_POLLS} consecutive polls: ${result.reason ?? "observation unavailable"}. Verification may still be running; inspect status before retrying.` };
}

async function waitForVerification(cwd: string, initial: HookCoverageReport): Promise<HookCoverageReport> {
    const id = initial.verification?.id;
    let result = initial;
    while (result.verification?.status === "running") {
        result = await pollAvailableStatus(cwd);
        if (result.readiness !== "ready") return result;
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
            if (result.readiness !== "ready") return result.reason ?? "Coverage observation unavailable; inspect status before retrying";
            const job = result.verification;
            if (!job) return result.reason ?? "Coverage verifier unavailable; rebuild and restart the daemon";
            return `Verification ${job.status}: ${job.checked}/${job.total} versions checked, ${job.findings} finding(s), ${result.pending?.length ?? "unknown"} pending.\nReceipts enumerate completed PostToolUse checks; policy acceptance and writer identity are separate.\n${job.unmeasured.join("\n")}`.trimEnd();
        },
    });
    if (initial.changed !== true || result.readiness !== "ready") { process.exitCode = 1; return; }
    if (result.verification?.status === "complete" && (result.pending?.length || result.verification.findings)) process.exitCode = 1;
}
