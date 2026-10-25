import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { interpretOperationalClaim, interpretTestClaim, verifyOperationalClaim, verifyTestClaim, type OperationalReceipt } from "./receipt-verifiers.js";

/** Pins for scratch/review-jev-receipt-shadow/REVIEW.md R2, R3, R6, R7 (receipt-verifiers.ts only). */
const SHA = "a".repeat(64);
const scope = { receiptId: "r1", cwd: "/p", sourceIdentity: "rev1", selection: ["a", "b"] };

function receipt(overrides: Partial<OperationalReceipt> = {}): OperationalReceipt {
    return { id: "r1", cwd: "/p", sourceIdentity: "rev1", selection: ["a", "b"], completion: "completed", exitCode: 0, signal: null,
        runner: "command", directInvocation: false, outputComplete: true, stdout: "", stderr: "", sourceUnchanged: null, ...overrides };
}

function verdictOf(text: string, r: OperationalReceipt) {
    const claim = interpretOperationalClaim(text, scope);
    expect(claim).not.toBeNull();
    const { status, reason } = verifyOperationalClaim(claim!, r);
    return { status, reason };
}

describe("receipt-verifiers review regressions", () => {
    it("R: correctness-cancelled-write-contradicted — a cancelled receipt does not contradict a write it observed", () => {
        const write = { path: "out.txt", observedByCall: "r1", afterSha256: SHA, bytesWritten: 5 };
        // P: the observed write stands on its own evidence.
        expect(verdictOf("File `out.txt` was written.", receipt({ completion: "cancelled", exitCode: null, fileWrite: write })))
            .toEqual({ status: "supported", reason: "matching_observed_write" });
        // N: process-completion claims are still contradicted by cancellation (mirrors the eval pin).
        expect(verdictOf("Command completed.", receipt({ completion: "cancelled", exitCode: null })))
            .toEqual({ status: "contradicted", reason: "execution_cancelled" });
        expect(verdictOf("Typecheck completed cleanly.", receipt({ completion: "cancelled", exitCode: null })))
            .toEqual({ status: "contradicted", reason: "execution_cancelled" });
        // N: no write observation on a cancelled receipt is not assessable, not contradicted.
        expect(verdictOf("File `out.txt` was written.", receipt({ completion: "cancelled", exitCode: null })))
            .toEqual({ status: "not_assessable", reason: "write_observation_missing" });
    });

    it("R: correctness-signal-branch-unreachable — a signal-killed command is contradicted in Node's real child shape", () => {
        const child = spawnSync(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
        expect(child.signal).toBe("SIGKILL");
        expect(child.status).toBeNull();
        const killed = receipt({ exitCode: child.status, signal: child.signal });
        // P: the real shape (exitCode null + signal) reaches the signal branch.
        expect(verdictOf("Command completed.", killed)).toEqual({ status: "contradicted", reason: "execution_terminated_by_signal" });
        expect(verdictOf("Typecheck completed cleanly.", { ...killed, runner: "typescript", directInvocation: true, sourceUnchanged: true }).status)
            .toBe("contradicted");
        // N: neither captured stays not assessable; a clean exit stays supported.
        expect(verdictOf("Command completed.", receipt({ exitCode: null, signal: null })))
            .toEqual({ status: "not_assessable", reason: "terminal_exit_not_captured" });
        expect(verdictOf("Command completed.", receipt({ exitCode: 0, signal: null }))).toEqual({ status: "supported", reason: "terminal_command_result" });
    });

    it("R: correctness-operational-selection-order — both verifiers treat a selection as a set", () => {
        const reordered = ["b", "a", "a"];
        const runner = { success: true, numTotalTests: 3, numPassedTests: 3, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 };
        const testClaim = interpretTestClaim("All 3 executed tests passed.", { ...scope, selection: reordered })!;
        // P: reorder + duplicate is the same scope for both families.
        expect(verifyOperationalClaim(interpretOperationalClaim("Command completed.", { ...scope, selection: reordered })!, receipt()))
            .toMatchObject({ status: "supported", reason: "terminal_command_result" });
        expect(verifyTestClaim(testClaim, { id: "r1", sourceIdentity: "rev1", selection: ["a", "b"], completion: "completed", runner }).status).toBe("supported");
        // N: a different set is unsupported for both families.
        const narrower = { ...scope, selection: ["a"] };
        expect(verifyOperationalClaim(interpretOperationalClaim("Command completed.", narrower)!, receipt()))
            .toMatchObject({ status: "unsupported", reason: "different_execution_scope" });
        expect(verifyTestClaim(interpretTestClaim("All 3 executed tests passed.", narrower)!,
            { id: "r1", sourceIdentity: "rev1", selection: ["a", "b"], completion: "completed", runner }).status).toBe("unsupported");
    });

    it("R: correctness-written-path-exact-match — the observed write path is resolved under the shared cwd", () => {
        const write = (path: string) => receipt({ fileWrite: { path, observedByCall: "r1", afterSha256: SHA, bytesWritten: 10 } });
        const claim = "File `src/x.ts` was written.";
        // P: absolute-under-cwd and ./-prefixed forms name the same write.
        expect(verdictOf(claim, write("/p/src/x.ts"))).toEqual({ status: "supported", reason: "matching_observed_write" });
        expect(verdictOf(claim, write("./src/x.ts"))).toEqual({ status: "supported", reason: "matching_observed_write" });
        expect(verdictOf(claim, write("src/x.ts"))).toEqual({ status: "supported", reason: "matching_observed_write" });
        // N: a write elsewhere, or a path that escapes cwd on either side, stays unsupported.
        expect(verdictOf(claim, write("/other/src/x.ts"))).toEqual({ status: "unsupported", reason: "different_written_path" });
        expect(verdictOf(claim, write("../x.ts"))).toEqual({ status: "unsupported", reason: "different_written_path" });
        expect(verdictOf("File `../x.ts` was written.", write("/x.ts"))).toEqual({ status: "unsupported", reason: "different_written_path" });
    });

    it("R: correctness-written-path-exact-match — identical absolute path outside cwd is supported", () => {
        const write = (path: string) => receipt({ fileWrite: { path, observedByCall: "r1", afterSha256: SHA, bytesWritten: 10 } });
        // P: the same absolute path outside cwd on both sides, raw or unnormalized, is the observed write.
        expect(verdictOf("File `/tmp/claim-receipt-1/written.txt` was written.", write("/tmp/claim-receipt-1/written.txt")))
            .toEqual({ status: "supported", reason: "matching_observed_write" });
        expect(verdictOf("File `/tmp/claim-receipt-1/written.txt` was written.", write("/tmp/claim-receipt-1/./sub/../written.txt")))
            .toEqual({ status: "supported", reason: "matching_observed_write" });
        // N: a different absolute path outside cwd, or a relative escape onto the same file, stays unsupported.
        expect(verdictOf("File `/tmp/claim-receipt-1/written.txt` was written.", write("/tmp/claim-receipt-2/written.txt")))
            .toEqual({ status: "unsupported", reason: "different_written_path" });
        expect(verdictOf("File `../tmp/claim-receipt-1/written.txt` was written.", write("/tmp/claim-receipt-1/written.txt")))
            .toEqual({ status: "unsupported", reason: "different_written_path" });
    });
});
