import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { fcAssert } from "../../test-setup/fc-assert.js";
import { expect, it } from "vitest";
import { hashEnvironment, hashFileSha256, manifestValidity, staleShards, type IndexValidityInputs } from "./invalidation.js";
import { collectRepositoryInventory } from "../../lib/metrics/inventory.js";
import { evidenceIdentity } from "../../lib/metrics/evidence-identity.js";
import { buildTestDependencyGraph } from "../test-dependency-graph.js";
import { indexValidity } from "./context.js";
import type { CoverageIndexManifest } from "./types.js";

// Requirement: plan E and invalidation.ts section 11. This model compares raw
// declared values; it never calls the implementation's hashing to decide validity.
const PATHS = ["test.ts", "helper.ts", "fixture.json", "config.json", "package-lock.json", "unrelated.ts"] as const;
type Key = typeof PATHS[number] | "runtime" | "MODE";
type Values = Record<Key, string | null>;
interface Model { accepted: Values; current: Values }
interface Real { root: string; current: Values; manifest: CoverageIndexManifest }
const INITIAL: Values = { "test.ts": "test", "helper.ts": "helper", "fixture.json": "fixture",
    "config.json": "config", "package-lock.json": "dependency", "unrelated.ts": "unrelated", runtime: "node-v1", MODE: "test" };
const RELEVANT: readonly Key[] = ["test.ts", "helper.ts", "fixture.json", "config.json", "package-lock.json", "runtime", "MODE"];
function inputs(real: Pick<Real, "root" | "current">): IndexValidityInputs {
    const inventory = collectRepositoryInventory(real.root);
    return indexValidity(real.root, evidenceIdentity(inventory), "no-extra-runtime-support", ["test.ts"],
        buildTestDependencyGraph(inventory), hashEnvironment(["MODE", "runtime"], {
            MODE: real.current.MODE ?? undefined, runtime: real.current.runtime ?? undefined,
        }));
}
function snapshot(real: Pick<Real, "root" | "current">): CoverageIndexManifest {
    const hashes = Object.fromEntries(["test.ts", "helper.ts", "fixture.json"].map(path => [path, hashFileSha256(join(real.root, path)) ?? "<missing>"]));
    return { version: 1, generation: 1, authoritativeAt: "2026-10-04T00:00:00Z", ...inputs(real), shards: {
        unit: { shardId: "unit", testPaths: ["test.ts"], testContentHashes: {}, dependencyHashes: hashes,
            lastDurationMs: 1, contributionPath: "unit.json", contributionChecksum: "a".repeat(64), passed: true,
            instability: { events: [], consecutiveStableRuns: 1, quarantined: false } },
    } };
}
function write(real: Real, key: Key, value: string | null): void {
    real.current[key] = value;
    if (key === "runtime" || key === "MODE") return;
    if (value === null) rmSync(join(real.root, key), { force: true });
    else writeFileSync(join(real.root, key), key.endsWith(".ts") ? `export const value = ${JSON.stringify(value)};` : value);
}
class Change implements fc.Command<Model, Real> {
    constructor(readonly key: Key, readonly value: string | null, readonly noop: boolean) {}
    check(): boolean { return true; }
    run(model: Model, real: Real): void {
        const value = this.noop ? model.current[this.key] : this.value;
        model.current[this.key] = value;
        write(real, this.key, value);
        const changed = RELEVANT.some(key => model.current[key] !== model.accepted[key]);
        // Removing an inventoried source changes the production graph's vertex set.
        const graphMembershipChanged = model.current["unrelated.ts"] === null;
        const absentRequired = ["test.ts", "helper.ts", "fixture.json"].some(key => model.current[key as Key] === null);
        const actual = !manifestValidity(real.manifest, inputs(real)).valid || staleShards(real.manifest, real.root).length > 0;
        expect(actual, this.toString()).toBe(changed || absentRequired || graphMembershipChanged);
    }
    toString(): string { return JSON.stringify({ key: this.key, value: this.value, noop: this.noop }); }
}
it("models edits, deletion, restoration and no-op changes across every declared input class", () => {
    const command = fc.tuple(fc.constantFrom<Key>(...RELEVANT, "unrelated.ts"), fc.option(fc.string({ maxLength: 12 }), { nil: null }), fc.boolean())
        .map(([key, value, noop]) => new Change(key, value, noop));
    fcAssert(fc.property(fc.commands([command], { maxCommands: 40 }), commands => {
        const root = mkdtempSync(join(tmpdir(), "invalidation-model-"));
        try {
            writeFileSync(join(root, "package.json"), '{"type":"module"}');
            for (const name of ["vitest", "@vitest/coverage-v8"]) {
                mkdirSync(join(root, "node_modules", name), { recursive: true });
                writeFileSync(join(root, "node_modules", name, "package.json"), '{"version":"1.0.0"}');
            }
            for (const path of PATHS) {
                const value = INITIAL[path];
                writeFileSync(join(root, path), path.endsWith(".ts") ? `export const value = ${JSON.stringify(value)};` : value ?? "");
            }
            const real: Real = { root, current: { ...INITIAL }, manifest: snapshot({ root, current: INITIAL }) };
            fc.modelRun(() => ({ model: { accepted: { ...INITIAL }, current: { ...INITIAL } }, real }), commands);
        } finally { rmSync(root, { recursive: true, force: true }); }
    }), { numRuns: 40 });
});
