import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failedCaptureShards } from "./captured-elements.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function capture(): { root: string; directory: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "captured-elements-")));
    roots.push(root);
    const directory = join(root, ".capture");
    mkdirSync(join(directory, "shards"), { recursive: true });
    return { root, directory };
}
function record(root: string, file: string, passed: boolean): string {
    return JSON.stringify({ version: 1, testFiles: [join(root, file)], environment: "node", durationMs: 5, passed, istanbul: {} });
}

describe("failedCaptureShards — positive (must fire)", () => {
    // test-contract: public-api — a "Tests did not pass" capture names the failing shards' test files (project-relative, sorted, bounded) and an unreadable record by its name, so the operator is not sent back to a full rerun to learn which test failed
    it("P1: names failing shards and unreadable records, never the passing ones", () => {
        const { root, directory } = capture();
        writeFileSync(join(directory, "shards", "a.json"), record(root, "src/b.test.ts", false));
        writeFileSync(join(directory, "shards", "b.json"), record(root, "src/a.test.ts", true));
        writeFileSync(join(directory, "shards", "c.json"), record(root, "src/c.test.ts", false));
        writeFileSync(join(directory, "shards", "d.json"), "{not json");
        writeFileSync(join(directory, "shards", "e.json"), JSON.stringify({ version: 2 }));
        // The JSON parser's wording varies by Node version; the record's name and the "unreadable" marker do not.
        expect(failedCaptureShards(directory, root)).toEqual([expect.stringMatching(/^d\.json \(unreadable: .+JSON.*\)$/), "e.json (unrecognized shard record)", "src/b.test.ts", "src/c.test.ts"]);
        expect(failedCaptureShards(directory, root, 1)).toEqual([expect.stringMatching(/^d\.json \(unreadable: /)]);
    });
});

describe("failedCaptureShards — negative (must not fire)", () => {
    // test-contract: boundary — no shards directory, or every shard passed, is an empty list (the reason stays the runner's own)
    it("N1: is empty without a shards directory and when every shard passed", () => {
        const { root, directory } = capture();
        expect(failedCaptureShards(join(root, "missing"), root)).toEqual([]);
        writeFileSync(join(directory, "shards", "a.json"), record(root, "src/a.test.ts", true));
        expect(failedCaptureShards(directory, root)).toEqual([]);
    });
});
