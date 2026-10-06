import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { expect, it } from "vitest";
import { collectRepositoryInventory } from "../../lib/metrics/inventory.js";
import { buildTestDependencyGraph, testDependencyClosure } from "../test-dependency-graph.js";
import { dependencyHashes, WHOLE_INVENTORY_KEY } from "./context.js";

// Independent value model: opaque test reads cannot earn a complete dependency closure.
it("opaque reads bind the inventory and edits/deletions/no-ops follow the raw value model", () => {
    fc.assert(fc.property(fc.array(fc.option(fc.string({maxLength:12}), {nil:null}), {minLength:1,maxLength:15}), values => {
        const root = mkdtempSync(join(tmpdir(), "opaque-model-"));
        try {
            mkdirSync(join(root, "src"));
            writeFileSync(join(root, "package.json"), '{"type":"module"}');
            writeFileSync(join(root, "src/a.test.ts"), 'import {readFileSync} from "node:fs"; readFileSync(process.env.INPUT);');
            const path = join(root, "src/b.ts");
            writeFileSync(path, "export const initial = 1;");
            const binding = () => {
                const inventory = collectRepositoryInventory(root);
                const graph = buildTestDependencyGraph(inventory);
                expect(testDependencyClosure(graph, ["src/a.test.ts"]).opaque).toBe(true);
                const hashes = dependencyHashes({ ...graph, inventory }, ["src/a.test.ts"], []);
                expect(Object.keys(hashes)).toEqual([WHOLE_INVENTORY_KEY]);
                return hashes[WHOLE_INVENTORY_KEY];
            };
            let previous: string | null = "export const initial = 1;";
            let accepted = binding();
            for (const value of values) {
                if (value === null) rmSync(path, { force: true }); else writeFileSync(path, value);
                const current = binding();
                expect(current === accepted).toBe(value === previous);
                previous = value; accepted = current;
            }
        } finally { rmSync(root, { recursive: true, force: true }); }
    }), { numRuns: 20 });
});
