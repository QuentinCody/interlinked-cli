import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { iterateStrictCapture, readStrictCapture } from "./captured-elements.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function capture(): { root: string; directory: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "captured-strict-")));
    roots.push(root);
    const directory = join(root, ".capture");
    mkdirSync(join(directory, "shards"), { recursive: true });
    return { root, directory };
}
function put(directory: string, name: string, row: Record<string, unknown>): void {
    writeFileSync(join(directory, "shards", name), JSON.stringify({ version: 1, environment: "node", durationMs: 7, passed: true, istanbul: {}, ...row }));
}

describe("iterateStrictCapture / readStrictCapture — positive (must fire)", () => {
    // test-contract: public-api — every passing single-file shard record is yielded in file-name order with its project-relative test path, shard id and recorded duration (0 when the record has none)
    it("P1: yields one shard per record, sorted by record name", () => {
        const { root, directory } = capture();
        put(directory, "b.json", { testFiles: [join(root, "src/b.test.ts")] });
        put(directory, "a.json", { testFiles: [join(root, "src/a.test.ts")], durationMs: undefined });
        put(directory, "ignored.txt", { testFiles: [join(root, "src/z.test.ts")] });
        const shards = readStrictCapture(directory, root);
        expect(shards.map(shard => [shard.contribution.shardId, shard.tests, shard.durationMs])).toEqual([
            ["src/a.test.ts", ["src/a.test.ts"], 0],
            ["src/b.test.ts", ["src/b.test.ts"], 7],
        ]);
        expect([...iterateStrictCapture(directory, root)]).toHaveLength(2);
    });
});

describe("iterateStrictCapture / readStrictCapture — negative (must not fire)", () => {
    // test-contract: invariant — a failed, multi-project, multi-file or unrecognized record means the capture cannot certify isolation, so the whole capture is refused instead of skipping the record
    it("N1: refuses a failed, project-scoped, multi-file or unparsable record", () => {
        for (const row of [{ passed: false }, { project: "web" }, { testFiles: ["a.test.ts", "b.test.ts"] }, { passed: null }, { version: 2 }]) {
            const { root, directory } = capture();
            put(directory, "x.json", { testFiles: [join(root, "src/a.test.ts")], ...row });
            expect(() => readStrictCapture(directory, root)).toThrow("Incomplete, failed or unsupported multi-project shard");
        }
    });
    // test-contract: invariant — two records naming the same test file are refused: the index cannot establish which one isolated the shard
    it("N2: refuses a repeated shard boundary", () => {
        const { root, directory } = capture();
        put(directory, "a.json", { testFiles: [join(root, "src/a.test.ts")] });
        put(directory, "b.json", { testFiles: [join(root, "src/a.test.ts")] });
        expect(() => readStrictCapture(directory, root)).toThrow("Repeated shard boundary; index cannot establish isolation");
    });
    // test-contract: boundary — an empty capture directory is an error reported at the end of iteration, not an empty verdict
    it("N3: refuses a capture with no shard records", () => {
        const { root, directory } = capture();
        expect(() => readStrictCapture(directory, root)).toThrow("No test shards captured");
    });
});
