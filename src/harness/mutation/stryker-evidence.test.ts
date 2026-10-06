import { expect, it } from "vitest";
import { strykerToAdapted } from "./stryker-adapter.js";
import { killApplicability, preserveStrykerEvidence } from "./stryker-evidence.js";
it("preserves optional fields, unresolved references and exact report provenance", () => {
    const mutant = { id: "m", mutatorName: "Equality", replacement: ">=", status: "Killed",
        location: { start: { line: 1, column: 2 }, end: { line: 1, column: 3 } },
        statusReason: "AssertionError: expected 1", killedBy: ["t1", "missing"], testsCompleted: 2 };
    const report = { files: { "a.ts": { source: "a>b", mutants: [mutant] } },
        testFiles: { "a.test.ts": { tests: [{ id: "t1", name: "boundary" }] } } };
    const evidence = preserveStrykerEvidence(report);
    expect(JSON.parse(evidence.report_json)).toEqual(report);
    expect(evidence.unresolved_test_ids).toEqual(["missing"]);
    const adapted = strykerToAdapted(report)?.[0];
    expect(adapted?.mutants[0]?.evidence).toMatchObject({ statusReason: mutant.statusReason, killedBy: mutant.killedBy, testsCompleted: 2 });
    expect(adapted?.reportEvidence?.report_sha256).toBe(evidence.report_sha256);
    expect(preserveStrykerEvidence({ ...report, testFiles: {} }).report_sha256).not.toBe(evidence.report_sha256);
});
it("invalidates a historical kill on every declared input class, while unknown closure stays unknown", () => {
    const recorded = { closure: "complete" as const, hashes: { test: "t", helper: "h", fixture: "f", config: "c", lock: "l" }, runtime: "node-v1", environment: { MODE: "test" } };
    for (const key of Object.keys(recorded.hashes)) {
        expect(killApplicability(recorded, { ...recorded, hashes: { ...recorded.hashes, [key]: "changed" } })).toBe("stale");
    }
    expect(killApplicability(recorded, { ...recorded, runtime: "node-v2" })).toBe("stale");
    expect(killApplicability(recorded, { ...recorded, environment: { MODE: null } })).toBe("stale");
    expect(killApplicability(undefined, recorded)).toBe("unknown");
    expect(killApplicability({ ...recorded, closure: "unknown" }, recorded)).toBe("unknown");
});
it("separates historical kill status from present applicability", () => {
    const recorded = { closure: "complete" as const, hashes: { "test.ts": "1", "helper.ts": "h", "fixture.json": "f" }, runtime: "node", environment: { MODE: "test" } };
    expect(killApplicability(recorded, recorded)).toBe("current");
    expect(killApplicability(recorded, { ...recorded, hashes: { ...recorded.hashes, "helper.ts": "changed" } })).toBe("stale");
    expect(killApplicability(recorded, { ...recorded, closure: "unknown" })).toBe("unknown");
});
