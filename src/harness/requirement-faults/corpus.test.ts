import { describe, expect, it } from "vitest";
import { parseFaultCorpus, summarizeKills, type FaultOutcome } from "./corpus.js";

const FAULT = { id: "R1#m1", requirement: { id: "R1", text: "acceptance is an input" }, path: "src/gen.ts", find: "addFile(a)", replace: "", rationale: "drops acceptance", tests: ["src/gen.test.ts"], origin: "authored" };

describe("parseFaultCorpus — positive", () => {
    it("P1: a version-1 corpus of recorded faults, each bound to a requirement and the test files that must notice it", () => {
        const corpus = parseFaultCorpus(JSON.stringify({ version: 1, faults: [FAULT, { ...FAULT, id: "R1#m2", find: "addFile(b)", origin: "edit-log" }] }));
        expect(corpus.faults.map(row => [row.id, row.requirement.id, row.origin])).toEqual([["R1#m1", "R1", "authored"], ["R1#m2", "R1", "edit-log"]]);
    });
});

describe("parseFaultCorpus — negative", () => {
    it("N1: unknown keys, empty anchors, no tests, duplicate ids, unconfined paths and unknown origins are refused", () => {
        const corpus = (faults: unknown[]) => JSON.stringify({ version: 1, faults });
        expect(() => parseFaultCorpus(corpus([{ ...FAULT, extra: 1 }]))).toThrow(/unknown key "extra"/);
        expect(() => parseFaultCorpus(corpus([{ ...FAULT, find: "" }]))).toThrow(/find must be a non-empty string/);
        expect(() => parseFaultCorpus(corpus([{ ...FAULT, tests: [] }]))).toThrow(/tests must list at least one test file/);
        expect(() => parseFaultCorpus(corpus([FAULT, FAULT]))).toThrow(/fault ids must be unique/);
        expect(() => parseFaultCorpus(corpus([{ ...FAULT, path: "../x.ts" }]))).toThrow(/confined project-relative/);
        expect(() => parseFaultCorpus(corpus([{ ...FAULT, origin: "guess" }]))).toThrow(/origin must be one of/);
        expect(() => parseFaultCorpus(JSON.stringify({ version: 2, faults: [] }))).toThrow(/version 1/);
    });
});

describe("summarizeKills — the requirement kill fraction", () => {
    const outcome = (fault: string, requirement: string, status: FaultOutcome["status"]): FaultOutcome => ({ fault, requirement, status, killedBy: status === "killed" ? ["t"] : [], inconclusive: [] });

    it("P2: killed / (killed + survived) per requirement; invalid and inconclusive faults are reported, never counted as either", () => {
        const rows = summarizeKills([outcome("R1#m1", "R1", "killed"), outcome("R1#m2", "R1", "survived"), outcome("R2#m1", "R2", "killed"), outcome("R2#m2", "R2", "invalid"), outcome("R3#m1", "R3", "inconclusive")]);
        expect(rows).toEqual([
            { requirement: "R1", killed: 1, survived: 1, inconclusive: 0, invalid: 0, fraction: 0.5 },
            { requirement: "R2", killed: 1, survived: 0, inconclusive: 0, invalid: 1, fraction: 1 },
            { requirement: "R3", killed: 0, survived: 0, inconclusive: 1, invalid: 0, fraction: null },
        ]);
    });
});
