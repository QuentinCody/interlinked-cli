import { spawn } from "node:child_process";
import type { EvidenceOutcome } from "./evidence-types.js";

export interface EvidenceProcessOptions { cwd: string; argv: string[]; timeoutMs: number; signal?: AbortSignal; }
export interface EvidenceProcessResult { outcome: EvidenceOutcome; durationMs: number; output: string; }

/** Executes only an explicitly selected command; process groups are terminated on cancellation. */
export async function runEvidenceProcess(options: EvidenceProcessOptions): Promise<EvidenceProcessResult> {
    const executable = options.argv[0];
    if (!executable) throw new Error("Runner command is empty");
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("Positive timeout required");
    if (options.signal?.aborted) return { outcome: "cancelled", durationMs: 0, output: "" };
    const started = Date.now();
    return new Promise(resolve => {
        const child = spawn(executable, options.argv.slice(1), { cwd: options.cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
        let forced: EvidenceOutcome | undefined, output = "";
        const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65536); };
        const stop = (reason: EvidenceOutcome) => {
            forced = reason;
            try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Child already exited. */ }
        };
        const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
        const abort = () => stop("cancelled");
        options.signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", collect); child.stderr.on("data", collect);
        const finish = (outcome: EvidenceOutcome) => {
            clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
            resolve({ outcome: forced ?? outcome, durationMs: Date.now() - started, output });
        };
        child.once("error", error => { output = error.message; finish("error"); });
        child.once("close", code => finish(code === 0 ? "passed" : "failed"));
    });
}
