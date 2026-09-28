import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blockingLintFindings, newLintFindings } from "./baseline.js";
import { measureImportedLint } from "./runner.js";
import { prepareLintImport } from "./selection.js";

const roots: string[] = [];
function project(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "readability-adoption-")));
    roots.push(root);
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    for (const tool of ["biome", "oxlint"]) symlinkSync(resolve("node_modules", ".bin", tool), join(root, "node_modules", ".bin", tool));
    return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("portable readability adoption", () => {
    it("does not certify formatter-disabled scope", async () => {
        const root = project();
        writeFileSync(join(root, "biome.json"), '{"formatter":{"enabled":false}}');
        writeFileSync(join(root, "app.ts"), "const x={a:1};");
        const { policy } = prepareLintImport(root, { config: ["biome-format=biome.json"], target: ["app.ts"], onlySelected: true });
        expect(await measureImportedLint(root, policy)).toMatchObject([{ status: "unavailable" }]);
    });
    it("runs the installed formatter, gates differences and measures the formatted result", async () => {
        const root = project();
        writeFileSync(join(root, "biome.json"), '{"files":{"includes":["**/*.ts"]},"formatter":{"enabled":true,"indentStyle":"space","indentWidth":4,"lineWidth":100}}');
        writeFileSync(join(root, "app.ts"), "const x={a:1,b:2};");
        const { policy } = prepareLintImport(root, { config: ["biome-format=biome.json"], target: ["app.ts"], onlySelected: true });
        const before = await measureImportedLint(root, policy);
        expect(before[0]).toMatchObject({ status: "measured", findings: [{ rule: "format", severity: "error", line: 1 }] });
        expect(blockingLintFindings(before[0]!, { version: 1, entries: {} })).toHaveLength(1);
        writeFileSync(join(root, "app.ts"), "const x = { a: 1, b: 2 };\n");
        expect(await measureImportedLint(root, policy)).toMatchObject([{ status: "measured", findings: [] }]);
    });

    it("keeps native structure warnings advisory while missing braces gate", async () => {
        const root = project();
        writeFileSync(join(root, "readability.json"), JSON.stringify({ categories: { correctness: "off" }, rules: { curly: ["error", "all"], "max-nested-callbacks": ["warn", { max: 2 }] } }));
        writeFileSync(join(root, "app.ts"), "const result = a.map(x => b.map(y => c.some(z => z.ok)));\nif (ready) run();\n");
        const { policy } = prepareLintImport(root, { config: ["oxlint=readability.json"], gate: "errors", onlySelected: true });
        const [measurement] = await measureImportedLint(root, policy);
        expect(measurement?.status).toBe("measured");
        const baseline = { version: 1 as const, entries: {} };
        expect(newLintFindings(measurement!, baseline).map(row => row.severity).sort()).toEqual(["error", "warning"]);
        expect(blockingLintFindings(measurement!, baseline).map(row => row.rule)).toEqual(["eslint(curly)"]);
    });
});
