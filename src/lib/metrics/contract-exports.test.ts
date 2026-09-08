import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { measureContracts } from "./adapter-contracts.js";
import { analyzeRepository } from "./analysis.js";
import { collectRepositoryInventory } from "./inventory.js";
import { readScoreConfiguration } from "./score-config.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(source: string, name: string, dependencies: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), "metrics-export-contract-")); roots.push(root);
    const files = { "index.js": source, ...dependencies,
        "interlinked.metrics.json": JSON.stringify({ schemaVersion: 1, contracts: [{ kind: "export", path: "index.js", name }] }) };
    for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
    return collectRepositoryInventory(root);
}
function measure(source: string, name: string, dependencies: Record<string, string> = {}) {
    const inventory = fixture(source, name, dependencies);
    return measureContracts(analyzeRepository(inventory), readScoreConfiguration(inventory));
}

describe("declared module export contracts", () => {
    it.each([
        "export const value = 1;",
        "const value = 1; export { value };",
        "const internal = 1; export { internal as value };",
        "export { internal as value } from './other.js';",
        "export * from './other.js';",
    ])("accepts the named module export in %s", source => {
        const result = measure(source, "value", { "other.js": "export const value = 1, internal = 2;" });
        expect(result.metrics[0]).toMatchObject({ state: "measured", numerator: 0, denominator: 1, value: 0 });
        expect(result.findings).toEqual([]);
    });

    it.each(["export default function value() { return 1; }", "export default class value {}", "export default 1;"])("distinguishes default from a declaration name in %s", source => {
        expect(measure(source, "value").metrics[0]).toMatchObject({ state: "measured", numerator: 1, value: 100 });
        expect(measure(source, "default").metrics[0]).toMatchObject({ state: "measured", numerator: 0, value: 0 });
    });

    it("resolves transitive and default aliases without leaking default through export star", () => {
        const dependencies = { "other.js": "export { default as value } from './leaf.js';", "leaf.js": "export default 1;" };
        expect(measure("export * from './other.js';", "value", dependencies).metrics[0]?.value).toBe(0);
        expect(measure("export * from './leaf.js';", "default", dependencies).metrics[0]?.value).toBe(100);
    });

    it("measures local exports despite unrelated unresolved imports and type errors", () => {
        const result = measure("import missing from 'uninstalled-package'; const invalid = unknownGlobal; export const value = 1;", "value");
        expect(result.metrics[0]).toMatchObject({ state: "measured", numerator: 0, value: 0 });
    });

    it.each([
        ["export * from './missing.js';", {}],
        ["export { missing as value } from './other.js';", { "other.js": "export const different = 1;" }],
        ["export * from './other.js';", { "other.js": "export * from './missing.js';" }],
        ["export const value = ;", {}],
        ["import { value } from './missing.js'; export { value };", {}],
        ["export * from './one.js'; export * from './two.js';", { "one.js": "export const value = 1;", "two.js": "export const value = 2;" }],
    ])("keeps unresolved or malformed modules inconclusive: %s", (source, dependencies) => {
        const result = measure(source, "value", dependencies);
        expect(result.metrics[0]).toMatchObject({ state: "inconclusive", measuredEntities: 0, eligibleEntities: 1 });
        expect(result.findings).toEqual([]);
    });

    it("uses proposed export contents and does not resolve a deleted source from disk", () => {
        const inventory = fixture("export * from './other.js';", "value", { "other.js": "export const value = 1;" });
        const deleted = { ...inventory, files: inventory.files.filter(file => file.path !== "other.js") };
        expect(measureContracts(analyzeRepository(deleted), readScoreConfiguration(deleted)).metrics[0]?.state).toBe("inconclusive");
        const replaced = { ...inventory, files: inventory.files.map(file => file.path === "other.js" ? { ...file, content: "export default function value() {}" } : file) };
        expect(measureContracts(analyzeRepository(replaced), readScoreConfiguration(replaced)).metrics[0]).toMatchObject({ state: "measured", value: 100 });
    });
});
