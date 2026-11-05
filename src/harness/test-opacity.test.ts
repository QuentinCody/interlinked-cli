import { describe, expect, it } from "vitest";
import type { RepositoryInventory } from "../lib/metrics/measurement-types.js";
import { rankOpacity, renderOpacityReport } from "./test-opacity.js";

function inventory(files: Record<string, string>, gaps: RepositoryInventory["gaps"] = []): RepositoryInventory {
    return { version: "interlinked-source-roles-v3", root: "/repo", discovery: "git", gaps, excluded: [], issues: [], inputHash: "", sourceHash: "",
        files: Object.entries(files).map(([path, content]) => ({ path, content, role: "product", language: "typescript", sha256: content })) };
}

const repo = inventory({
    "src/pure.ts": "export const value = 1;",
    "src/io.ts": 'import { readFileSync } from "node:fs"; export const read = (p: string) => readFileSync(p, "utf8");',
    "src/setup.ts": 'import { read } from "./io"; export const config = read("x");',
    "src/clock.ts": "export const now = () => Date.now();",
    "src/pure.test.ts": 'import { value } from "./pure"; import "./setup";',
    "src/io.test.ts": 'import { read } from "./io";',
    "src/clock.test.ts": 'import { now } from "./clock";',
    "src/lost.test.ts": 'import { gone } from "./missing-module";',
});
const historical = { "src/pure.test.ts": { dependencies: [], durationMs: 40_000 }, "src/io.test.ts": { dependencies: [], durationMs: 5_000 }, "src/clock.test.ts": { dependencies: [], durationMs: 1_000 } };

describe("rankOpacity — positive (must fire)", () => {
    // test-contract: public-api — configured shared setup affects every discovered test, even without a source import from the test.
    it("attributes shared setup once per discovered test and labels the runner edge", () => {
        const report = rankOpacity(repo, [], historical, { tests: ["src/clock.test.ts", "src/io.test.ts"], supportFiles: ["src/setup.ts"] });
        expect(report.tests).toBe(2);
        expect(report.opaque_tests).toBe(2);
        expect(report.opaque_duration_ms).toBe(6000);
        expect(report.causes).toEqual([expect.objectContaining({ path: "src/io.ts", tests: 2, duration_ms: 6000,
            chain: ["src/io.test.ts", "src/io.ts"] })]);
        const sharedOnly = rankOpacity(repo, [], historical, { tests: ["src/clock.test.ts"], supportFiles: ["src/setup.ts"] });
        expect(sharedOnly.causes[0]?.chain).toEqual(["src/clock.test.ts", "<runner support>", "src/setup.ts", "src/io.ts"]);
    });

    // test-contract: invariant — discovered files missing from the source inventory cannot be called transparent.
    it("reports missing discovered tests and shared support as opaque inputs", () => {
        const report = rankOpacity(repo, [], {}, { tests: ["custom/check.ts"], supportFiles: ["generated/setup.js"] });
        expect(report.opaque_tests).toBe(1);
        expect(report.causes.map(cause => cause.path).sort()).toEqual(["custom/check.ts", "generated/setup.js"]);
        expect(report.causes.every(cause => cause.reasons.includes("not in inventory"))).toBe(true);
    });
    // test-contract: public-api — each opacity cause is ranked by the execution time of the tests it makes non-reusable, with the chain that spreads it
    it("P1: ranks causes by affected measured duration and shows the import chain from the costliest test", () => {
        const report = rankOpacity(repo, [], historical);
        expect(report.tests).toBe(4);
        expect(report.opaque_tests).toBe(3);
        expect(report.measured_duration_ms).toBe(46_000);
        expect(report.opaque_duration_ms).toBe(45_000);
        expect(report.causes.map(cause => [cause.path, cause.tests, cause.duration_ms, cause.unmeasured_tests])).toEqual([
            ["src/io.ts", 2, 45_000, 0],
            ["src/lost.test.ts", 1, 0, 1],
        ]);
        const io = report.causes[0];
        expect(io?.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/fs|readFileSync/)]));
        expect(io?.chain).toEqual(["src/pure.test.ts", "src/setup.ts", "src/io.ts"]);
        expect(report.causes[1]?.reasons).toEqual(["unresolved import: ./missing-module"]);
        expect(report.incomplete).toBe(false);
    });

    // test-contract: public-api — the rendering names each cause once with its share and chain, bounded by --limit
    it("P2: renders the ranked causes with their chains and respects the limit", () => {
        const text = renderOpacityReport(rankOpacity(repo, [], historical, { limit: 1 }));
        expect(text).toContain("3 of 4 tests opaque");
        expect(text).toContain("src/io.ts");
        expect(text).toContain("src/pure.test.ts → src/setup.ts → src/io.ts");
        expect(text).not.toContain("src/lost.test.ts");
        expect(text).toContain("1 more cause");
    });
});

describe("rankOpacity — negative (must not fire)", () => {
    // test-contract: invariant — a nondeterministic module (the clock) is not an opacity cause; an incomplete inventory is reported, not attributed to a file
    it("N1: leaves nondeterministic modules and transparent tests out, and reports an incomplete inventory as its own cause", () => {
        const report = rankOpacity(inventory({ "src/clock.ts": "export const now = () => Date.now();", "src/clock.test.ts": 'import { now } from "./clock";' }, [{ path: "src/big.bin", role: "product", reason: "too large" }]), [], {});
        expect(report.causes.map(cause => cause.path)).toEqual(["<inventory>"]);
        expect(report.causes[0]?.reasons).toEqual(["inventory incomplete: src/big.bin (too large)"]);
        expect(report.incomplete).toBe(true);
        expect(rankOpacity(inventory({ "src/pure.ts": "export const value = 1;", "src/pure.test.ts": 'import { value } from "./pure";' }), [], {}).causes).toEqual([]);
    });
});
