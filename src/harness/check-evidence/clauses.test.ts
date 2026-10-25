import { describe, expect, it } from "vitest";
import type { FaultOutcome } from "../requirement-faults/corpus.js";
import { clauseEvidence, parseClauses } from "./clauses.js";

const HEADER = [
    "// CLASS: catch-only assertions",
    "// FIRES WHEN: an active test's assertions occur only in catch, the try has no",
    "// assertion sentinel.",
    "// DOES NOT FIRE: expect.assertions/hasAssertions; a fail/throw sentinel in try;",
    "// a recognized toThrow assertion; skipped tests.",
    "// CALIBRATION (2026-09-06): numbers",
    "export function check() {}",
].join("\n");

describe("parseClauses — positive", () => {
    it("P1: FIRES WHEN is k1; each DOES NOT FIRE item is the next clause, in header order", () => {
        expect(parseClauses(HEADER)).toEqual([
            { k: 1, direction: "fires", text: "an active test's assertions occur only in catch, the try has no assertion sentinel" },
            { k: 2, direction: "quiet", text: "expect.assertions/hasAssertions" },
            { k: 3, direction: "quiet", text: "a fail/throw sentinel in try" },
            { k: 4, direction: "quiet", text: "a recognized toThrow assertion" },
            { k: 5, direction: "quiet", text: "skipped tests" },
        ]);
    });

    it("P2: without semicolons the DOES NOT FIRE list splits on commas", () => {
        const source = "// FIRES WHEN: x.\n// DOES NOT FIRE: port 0, ports below 1024, or unrecognized contexts.\n// CALIBRATION: y";
        expect(parseClauses(source).map(row => row.text)).toEqual(["x", "port 0", "ports below 1024", "unrecognized contexts"]);
    });
});

describe("parseClauses — the list is the first sentence", () => {
    it("P2b: remark sentences after the list are notes, never clauses, even when they contain semicolons", () => {
        const source = "// FIRES WHEN: x.\n// DOES NOT FIRE: unmatched values, a transformed subject, or negation. Coarse\n// literals count only once; quoted keys never.\n// CALIBRATION: y";
        expect(parseClauses(source).map(row => row.text)).toEqual(["x", "unmatched values", "a transformed subject", "negation"]);
    });
});

describe("parseClauses — a qualified label", () => {
    it("P2c: a parenthetical between the label and its colon is part of the label", () => {
        const source = "// FIRES WHEN (inside one function body): a scanner loop.\n// DOES NOT FIRE: test files; non-JS/TS files.\n// CALIBRATION: y";
        expect(parseClauses(source).map(row => row.text)).toEqual(["a scanner loop", "test files", "non-JS/TS files"]);
    });
});

describe("parseClauses — negative", () => {
    it("N1: a module without both headers has no clauses", () => {
        expect(parseClauses("// FIRES WHEN: only this\nexport const x = 1;")).toEqual([]);
        expect(parseClauses("export const x = 1;")).toEqual([]);
    });
});

describe("clauseEvidence", () => {
    const outcome = (requirement: string, status: FaultOutcome["status"]): FaultOutcome => ({ fault: `${requirement}#m`, requirement, status, killedBy: [], inconclusive: [] });

    it("P3: each clause gets its recorded faults' kill fraction; a clause with no conclusive fault is unmeasured, never pinned", () => {
        const evidence = clauseEvidence("test-catch", parseClauses(HEADER), [
            outcome("clause:test-catch:k1", "killed"),
            outcome("clause:test-catch:k4", "killed"), outcome("clause:test-catch:k4", "survived"),
            outcome("clause:test-catch:k5", "inconclusive"),
            outcome("clause:other-module:k2", "killed"),
        ]);
        expect(evidence.clauses.map(row => [row.k, row.faults, row.fraction])).toEqual([[1, 1, 1], [2, 0, null], [3, 0, null], [4, 2, 0.5], [5, 1, null]]);
        expect(evidence).toMatchObject({ total: 5, measured: 2, pinned: 1 });
    });
});
