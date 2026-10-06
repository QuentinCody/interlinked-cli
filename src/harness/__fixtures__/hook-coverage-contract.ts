import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { HookCoverageReport } from "../hook-coverage-control.js";
import type { HookPendingCheck } from "../hook-coverage-ledger.js";

/** Transport-neutral scenarios: the unit adapter uses the control handler; the
 * e2e adapter uses the built CLI and its owned daemon. Neither supplies receipts. */
export interface CoverageFlowDriver {
    manifestPath: string;
    writeManifest(content: string | null): Promise<void>;
    status(): Promise<HookCoverageReport>;
    verify(): Promise<{ report: HookCoverageReport; exitCode: number | null }>;
}

export const CLEAN_MANIFEST = JSON.stringify({ name: "coverage-contract-fixture", private: true });
const DUPLICATE_MANIFEST = JSON.stringify({ name: "coverage-contract-fixture", private: true,
    dependencies: { "fixture-dependency": "1.0.0" }, devDependencies: { "fixture-dependency": "1.0.0" } });

function pendingVersion(report: HookCoverageReport, path: string, content: string | null): HookPendingCheck {
    assert.equal(report.readiness, "ready", report.reason);
    assert.equal(report.pending?.length, 1, "Exactly the written version needs checks");
    const entry = report.pending[0]!;
    assert.equal(entry.path, path);
    assert.equal(entry.identity, content === null ? "missing" : createHash("sha256").update(content).digest("hex"));
    assert.equal(entry.writer, "unknown", "Filesystem observation must not invent writer attribution");
    assert.equal(entry.scope, "policy");
    return entry;
}

function assertCompleted(report: HookCoverageReport, checked: number): string {
    assert.equal(report.readiness, "ready", report.reason);
    assert(report.verification, "A compact acknowledgement is not a completed verification result");
    assert.equal(report.verification.status, "complete");
    assert.equal(report.verification.total, 1);
    assert.equal(report.verification.processed, 1);
    assert.equal(report.verification.checked, checked);
    return report.verification.id;
}

async function assertReceipt(driver: CoverageFlowDriver, entry: HookPendingCheck): Promise<HookCoverageReport> {
    const report = await driver.status();
    assert.deepEqual(report.pending, []);
    assert.equal(report.acceptedPolicy, undefined, "Running checks must not approve policy changes");
    assert.deepEqual(report.reviews, [], "Running checks must not mint manual review receipts");
    const receipt = report.checks?.find(row => row.id === entry.id);
    assert(receipt, "The checked version needs a durable receipt");
    assert.equal(receipt.path, entry.path);
    assert.equal(receipt.identity, entry.identity);
    assert.equal(receipt.kind, "automated_check");
    assert(receipt.checks.includes("package_json_consistency"), "The actual configured check must execute");
    assert.equal(receipt.unavailable?.length ?? 0, 0);
    return report;
}

export const COVERAGE_FLOW_SCENARIOS: Array<{ name: string; run: (driver: CoverageFlowDriver) => Promise<void> }> = [
    {
        name: "checks a clean observed version and persists its receipt without accepting policy",
        async run(driver) {
            await driver.writeManifest(CLEAN_MANIFEST);
            const entry = pendingVersion(await driver.status(), driver.manifestPath, CLEAN_MANIFEST);
            const { report, exitCode } = await driver.verify();
            assert.equal(exitCode, 0);
            assertCompleted(report, 1);
            assert.equal(report.verification?.findings, 0);
            assert.deepEqual(report.verification?.unmeasured, []);
            const history = await assertReceipt(driver, entry);
            assert.equal(history.checks?.length, 1);
            assert.deepEqual(history.checks[0]?.findings, []);
        },
    },
    {
        name: "returns failure for measured findings, then checks repaired bytes without erasing the finding",
        async run(driver) {
            await driver.writeManifest(DUPLICATE_MANIFEST);
            const original = pendingVersion(await driver.status(), driver.manifestPath, DUPLICATE_MANIFEST);
            const failed = await driver.verify();
            assert.equal(failed.exitCode, 1);
            const firstJob = assertCompleted(failed.report, 1);
            assert.equal(failed.report.verification?.findings, 1);
            const firstReceipt = (await assertReceipt(driver, original)).checks?.[0];
            assert(firstReceipt?.findings.some(finding => finding.includes("fixture-dependency")));

            await driver.writeManifest(CLEAN_MANIFEST);
            const repaired = pendingVersion(await driver.status(), driver.manifestPath, CLEAN_MANIFEST);
            assert.notEqual(repaired.id, original.id);
            const passed = await driver.verify();
            assert.equal(passed.exitCode, 0);
            assert.notEqual(assertCompleted(passed.report, 1), firstJob);
            assert.equal(passed.report.verification?.findings, 0);
            const history = await assertReceipt(driver, repaired);
            assert.equal(history.checks?.length, 2);
            assert.deepEqual(history.checks.find(row => row.id === original.id), firstReceipt);
        },
    },
    {
        name: "retains an absent version as unmeasured and recovers when identical bytes are restored",
        async run(driver) {
            await driver.writeManifest(CLEAN_MANIFEST);
            const original = pendingVersion(await driver.status(), driver.manifestPath, CLEAN_MANIFEST);
            await driver.writeManifest(null);
            const deleted = pendingVersion(await driver.status(), driver.manifestPath, null);
            assert.notEqual(deleted.id, original.id);
            const failed = await driver.verify();
            assert.equal(failed.exitCode, 1);
            const firstJob = assertCompleted(failed.report, 0);
            assert(failed.report.verification?.unmeasured.some(reason => reason.includes("File is absent")));
            assert.deepEqual(failed.report.pending, [deleted]);
            assert.deepEqual((await driver.status()).checks, []);

            await driver.writeManifest(CLEAN_MANIFEST);
            const restored = pendingVersion(await driver.status(), driver.manifestPath, CLEAN_MANIFEST);
            assert.notEqual(restored.id, original.id, "An ABA replacement is a new observation even with identical bytes");
            const passed = await driver.verify();
            assert.equal(passed.exitCode, 0);
            assert.notEqual(assertCompleted(passed.report, 1), firstJob);
            assert.equal((await assertReceipt(driver, restored)).checks?.length, 1);
        },
    },
];
