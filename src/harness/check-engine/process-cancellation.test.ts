import { describe, expect, it } from "vitest";
import { runProcessAsync } from "./spawn-async.js";
import { currentProcessSignal, withProcessCancellation } from "./process-cancellation.js";

describe("job-owned process cancellation", () => {
    it("kills the owning job's real child without cancelling independent work", async () => {
        const owner = new AbortController();
        const cancelled = withProcessCancellation(owner.signal, () => runProcessAsync(process.execPath,
            ["-e", "setInterval(() => {}, 1000)"], { timeout: 3000 }));
        const independent = runProcessAsync(process.execPath, ["-e", "console.log('independent')"], { timeout: 3000 });
        owner.abort();
        expect(await cancelled).toMatchObject({ killed: true });
        expect(await independent).toMatchObject({ code: 0, killed: false, stdout: "independent\n" });
        expect(currentProcessSignal()).toBeUndefined();
    });
    it("preserves explicit child cancellation inside a job", async () => {
        const owner = new AbortController(), child = new AbortController();
        const result = withProcessCancellation(owner.signal, () => runProcessAsync(process.execPath,
            ["-e", "setInterval(() => {}, 1000)"], { timeout: 3000, signal: child.signal }));
        child.abort();
        expect(await result).toMatchObject({ killed: true });
        expect(owner.signal.aborted).toBe(false);
    });
});
