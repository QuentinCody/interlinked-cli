import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_CATALOG, dataSourceForPath, renderDataCatalogMarkdown } from "./catalog.js";
import { discoverDataFiles } from "./discovery.js";

const roots: string[] = [];
function fixtureRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "interlinked-data-catalog-"));
    roots.push(root);
    mkdirSync(join(root, ".interlinked", "archive"), { recursive: true });
    return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("data catalog and physical discovery", () => {
    it("keeps unique logical identities and documents every registered source", () => {
        expect(new Set(DATA_CATALOG.map((source) => source.name)).size).toBe(DATA_CATALOG.length);
        expect(new Set(DATA_CATALOG.map((source) => source.path)).size).toBe(DATA_CATALOG.length);
        const document = renderDataCatalogMarkdown();
        for (const source of DATA_CATALOG) expect(document).toContain(`| \`${source.path}\` |`);
    });
    it("connects compressed segments and rotations to their logical source", () => {
        expect(dataSourceForPath("archive/activity-0002.jsonl.gz").name).toBe("activity");
        expect(dataSourceForPath("logs/latency.jsonl.1").name).toBe("latency");
        expect(dataSourceForPath("new/custom.jsonl")).toMatchObject({ category: "unknown", retention: "preserve" });
    });
    it("discovers unknown evidence and archives without following an external symlink", () => {
        const root = fixtureRoot();
        const outside = fixtureRoot();
        writeFileSync(join(outside, "private.jsonl"), "{}\n");
        writeFileSync(join(root, ".interlinked", "custom.jsonl"), "{}\n");
        writeFileSync(join(root, ".interlinked", "archive", "activity-0001.jsonl.gz"), "gzip-placeholder");
        symlinkSync(join(outside, "private.jsonl"), join(root, ".interlinked", "linked.jsonl"));
        const result = discoverDataFiles(root);
        expect(result.files.map((file) => file.relativePath)).toEqual(["archive/activity-0001.jsonl.gz", "custom.jsonl"]);
        expect(result.issues.map((issue) => issue.reason)).toContain("symlink not followed");
    });
    it("reports exhausted discovery budgets instead of claiming a complete inventory", () => {
        const root = fixtureRoot();
        writeFileSync(join(root, ".interlinked", "a.jsonl"), "{}\n");
        writeFileSync(join(root, ".interlinked", "b.jsonl"), "{}\n");
        expect(discoverDataFiles(root, { maxEntries: 1 }).complete).toBe(false);
    });
});
