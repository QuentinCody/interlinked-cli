import { expect, it } from "vitest";
import { remainingCoverageVersions } from "./hook-coverage-remaining.js";
import type { HookVerificationCheckpoint } from "./hook-coverage-job.js";
const old = { id: "old", identity: "v1", path: "/repo/source.ts", scope: "policy" as const, writer: "unknown" as const };
const checkpoint: HookVerificationCheckpoint = { schema: 1, nextBatch: 1, deadlineAt: 100, batches: [[old]],
    job: { id: "job", status: "complete", total: 1, processed: 1, checked: 0, findings: 0,
        unmeasured: ["/repo/source.ts: Host memory capacity unavailable", "/repo/source.ts: Host memory capacity unavailable"] } };
it("retains a concrete reason for each exact pending version and deduplicates repeated diagnostics", () => {
    expect(remainingCoverageVersions([old], checkpoint)[0]?.reasons).toEqual(["Host memory capacity unavailable"]);
});
it("never transfers old-version failures or a successful verdict to a newer version", () => {
    expect(remainingCoverageVersions([{ ...old, id: "new", identity: "v2" }], checkpoint)[0]?.reasons).toEqual(["This version was observed after the recovery plan; it needs a fresh check"]);
    expect(remainingCoverageVersions([old], undefined)[0]?.reasons).toEqual(["No recovery job has examined this version"]);
});
it("separates current observation blockers from a previous job's tool failures for every version", () => {
    const rows = remainingCoverageVersions([old], checkpoint, ["private configuration unavailable"]);
    expect(rows[0]?.reasons).toEqual(["Current observation unavailable: private configuration unavailable", "Previous recovery evidence: Host memory capacity unavailable"]);
});
