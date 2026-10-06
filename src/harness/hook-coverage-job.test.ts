import { describe, expect, it } from "vitest";
import { parseHookVerificationCheckpoint, type HookVerificationCheckpoint } from "./hook-coverage-job.js";

function fixture(): HookVerificationCheckpoint {
    return { schema: 1, job: { id: "job", status: "running", total: 2, processed: 1, checked: 1, findings: 2, unmeasured: [] },
        batches: [0, 1].map(index => [{ id: `entry-${index}`, path: `file-${index}.ts`, identity: "v1", scope: "reservation", writer: "unknown" }]),
        nextBatch: 1, deadlineAt: 1791236000000 };
}

describe("durable verification checkpoint validation", () => {
    it("retains exact pending identities, findings, progress and the original deadline", () => {
        const checkpoint = fixture();
        expect(parseHookVerificationCheckpoint(JSON.parse(JSON.stringify(checkpoint)))).toEqual(checkpoint);
    });
    it.each([
        (value: HookVerificationCheckpoint) => { value.job.processed = 2; },
        (value: HookVerificationCheckpoint) => { value.job.checked = 2; },
        (value: HookVerificationCheckpoint) => { value.job.total = 3; },
        (value: HookVerificationCheckpoint) => { value.job.findings = -1; },
        (value: HookVerificationCheckpoint) => { value.nextBatch = 3; },
        (value: HookVerificationCheckpoint) => { value.deadlineAt = Infinity; },
        (value: HookVerificationCheckpoint) => { value.batches[1] = value.batches[0]!; },
        (value: HookVerificationCheckpoint) => { value.job.id = ""; },
    ])("rejects inconsistent progress instead of skipping unmeasured work: %s", corrupt => {
        const checkpoint = fixture();
        corrupt(checkpoint);
        expect(() => parseHookVerificationCheckpoint(checkpoint)).toThrow("Invalid hook verification checkpoint");
    });
    it.each([null, {}, { schema: 99 }, { ...fixture(), batches: [[{ id: "entry" }]] }])("rejects malformed durable state: %j", value => {
        expect(() => parseHookVerificationCheckpoint(value)).toThrow("Invalid hook verification checkpoint");
    });
});
