import { expect, it } from "vitest";
import { extractChangedEvidence, parseHunks, validateEvidence } from "./evidence.js";

it("retains a widened type contract even when no function changed", () => {
    const records = extractChangedEvidence({
        repository: "r",
        revision: "a",
        timestamp: "2026-01-01",
        file: "types.ts",
        message: "Add a mode",
        before: "type Mode = 'old';",
        after: "type Mode = 'old' | 'new';",
        diff: "@@ -1 +1 @@\n-type Mode = 'old';\n+type Mode = 'old' | 'new';",
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ unit: "hunk", evidence: { symbols: ["Mode"] } });
});

it("measures touched functions and excludes an unchanged neighbor", () => {
    const before =
        "export function one(x: number) { return x; }\nexport function two() { return 2; }\n";
    const after = before.replace("return x;", "return x + 1;");
    const hunk =
        "@@ -1 +1 @@\n-export function one(x: number) { return x; }\n+export function one(x: number) { return x + 1; }";
    const rows = extractChangedEvidence({
        file: "a.ts",
        before,
        after,
        diff: hunk,
        repository: "repo",
        revision: "abc",
        timestamp: "2026-01-01",
        message: "increment result",
    });
    expect(
        rows.filter((row) => row.unit === "function").map((row) => row.evidence.signature),
    ).toEqual(["one"]);
    expect(rows[0]?.evidence.metrics).toMatchObject({ cyclomatic: 1, lines: 1 });
    expect(rows[0]?.evidence).not.toHaveProperty("tests");
    expect(rows.some((row) => row.unit === "hunk")).toBe(true);
});

it("retains deleted hunks and rejects malformed evidence records", () => {
    expect(parseHunks("@@ -2,3 +2,0 @@\n-old")[0]).toMatchObject({
        oldStart: 2,
        oldCount: 3,
        newCount: 0,
    });
    expect(() => validateEvidence({ id: "x" })).toThrow();
});
