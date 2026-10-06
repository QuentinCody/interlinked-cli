import { setTimeout } from "node:timers/promises";
import type { OptionValues } from "commander";
import type { HookCoverageReport, HookCoverageRequest } from "../harness/hook-coverage-control.js";
import { getOutputMode, output } from "../lib/output.js";
import { queryHookCoverage } from "./harness-capabilities.js";
import { readTestRunObservation } from "../harness/test-run-observation.js";

const POLL_MS = 1000;
const MAX_UNAVAILABLE_MS = 120_000;
const PROGRESS_INTERVAL_MS = 10_000;

/** Terminal feedback uses stderr; JSON stdout remains one final document. */
function waitingProgress(cwd: string): (report: HookCoverageReport) => void {
    const started = Date.now();
    let last = -Infinity;
    return report => {
        if (!process.stderr.isTTY) return;
        const job = verificationOf(report), now = Date.now();
        if (job?.status !== "running" || now - last < PROGRESS_INTERVAL_MS) return;
        last = now;
        const seconds = Math.floor((now - started) / 1000);
        const pending = report.progress?.pendingCount ?? report.pending?.length ?? "unknown";
        const unavailable = "unmeasured" in job ? job.unmeasured.length : job.unmeasuredCount;
        process.stderr.write(`[coverage] ${job.processed}/${job.total} versions processed; ${job.checked} checked; ${job.findings} findings; ${unavailable} unavailable details; ${pending} pending; waiting ${seconds}s. Counters update after each batch.\n`);
        const observed = readTestRunObservation(cwd);
        if (observed) process.stderr.write(`[coverage] Latest project test observation: ${observed.tests.length} files, ${observed.status}, recorded ${observed.observedAt}.\n`);
    };
}

async function pollAvailableStatus(cwd: string, request: HookCoverageRequest): Promise<HookCoverageReport> {
    let result: HookCoverageReport = { readiness: "unmeasured" };
    const started = Date.now();
    let lastNotice = -Infinity;
    do {
        await setTimeout(POLL_MS);
        result = await queryHookCoverage(cwd, request);
        if (result.readiness === "ready" || result.retryable === false) return result;
        const now = Date.now();
        if (process.stderr.isTTY && now - lastNotice >= PROGRESS_INTERVAL_MS) {
            lastNotice = now;
            process.stderr.write(`[coverage] Daemon temporarily unavailable for ${Math.floor((now - started) / 1000)}s; waiting for the existing job. No verification was resubmitted.\n`);
        }
    } while (Date.now() - started < MAX_UNAVAILABLE_MS);
    return { ...result, reason: `Coverage status unavailable for ${Math.floor((Date.now() - started) / 1000)}s: ${result.reason ?? "observation unavailable"}. Verification may still be running; inspect status before retrying.` };
}

function verificationOf(report: HookCoverageReport) {
    return report.progress?.verification ?? report.verification;
}

async function finalVerificationStatus(cwd: string, id: string | undefined, result: HookCoverageReport, compactStart: boolean): Promise<HookCoverageReport> {
    if (!result.progress) return result; // Older daemons return the full report.
    const final = await pollAvailableStatus(cwd, compactStart ? { operation: "status", detail: "verification" } : { operation: "status" });
    if (final.readiness !== "ready") return final;
    if (final.progress || final.verification?.id !== id || final.verification?.status !== "complete") {
        return { ...final, readiness: "unmeasured", reason: "Final verification state changed or is incomplete; inspect status before retrying" };
    }
    return final;
}

async function waitForVerification(cwd: string, initial: HookCoverageReport): Promise<HookCoverageReport> {
    const id = verificationOf(initial)?.id;
    let result = initial;
    const showProgress = waitingProgress(cwd);
    showProgress(result);
    while (verificationOf(result)?.status === "running") {
        result = await pollAvailableStatus(cwd, { operation: "status", detail: "progress" });
        if (result.readiness !== "ready") return result;
        if (verificationOf(result)?.id !== id) {
            return { ...result, readiness: "unmeasured", reason: "Verification job changed or daemon restarted; inspect pending versions and retry" };
        }
        showProgress(result);
    }
    return finalVerificationStatus(cwd, id, result, initial.progress !== undefined);
}

export async function harnessCoverageVerifyCommand(opts: OptionValues): Promise<void> {
    const cwd = process.cwd();
    const initial = await queryHookCoverage(cwd, { operation: "verify", detail: "progress" });
    const result = opts.wait === false ? initial : await waitForVerification(cwd, initial);
    output(getOutputMode(opts), result, {
        json: () => result,
        normal: () => {
            if (result.readiness !== "ready") return result.reason ?? "Coverage observation unavailable; inspect status before retrying";
            const job = verificationOf(result);
            if (!job) return result.reason ?? "Coverage verifier unavailable; rebuild and restart the daemon";
            const details = result.verification?.unmeasured.join("\n") ?? "";
            const pending = result.progress?.pendingCount ?? result.pending?.length ?? "unknown";
            return `Verification ${job.status}: ${job.checked}/${job.total} versions checked, ${job.findings} finding(s), ${pending} pending.\nReceipts enumerate completed PostToolUse checks; policy acceptance and writer identity are separate.\n${details}`.trimEnd();
        },
    });
    if (initial.changed !== true || result.readiness !== "ready") { process.exitCode = 1; return; }
    const job = result.verification;
    if (job?.status === "complete" && (result.pending?.length || job.findings || job.unmeasured.length || job.checked < job.total)) process.exitCode = 1;
}
