import { expect, it } from "vitest";
import { auditKeys } from "./evidence-deep-audit.mts";
it("deduplicates exact findings across runs without erasing check or location distinctions", () => {
    const report = (details: unknown[]) => ({ schema_version: "interlinked.verify/1", check: { details } });
    const hit = { file: "a.ts", line: 1, text: "bad" };
    expect(auditKeys(report([hit, hit]))).toHaveLength(1);
    expect(auditKeys(report([hit]))).toEqual(auditKeys(report([{ text: "bad", line: 1, file: "a.ts", timestamp: "later" }])));
    expect(auditKeys(report([hit, { ...hit, line: 2 }]))).toHaveLength(2);
    expect(() => auditKeys({})).toThrow("unsupported");
});
