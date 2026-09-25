import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectProjectInputs, scenarioGeneration, scenarioInputs } from "./generation.js";
import { parseE2ePolicy, type E2ePolicy } from "./policy.js";
import { minimalPolicy } from "./__tests__/policy-fixture.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(policyPatch: (raw: Record<string, unknown>) => void = () => {}): { root: string; policy: E2ePolicy } {
    const root = mkdtempSync(join(tmpdir(), "e2e-gen-")); roots.push(root);
    mkdirSync(join(root, "src/orders"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, ".interlinked"), { recursive: true });
    writeFileSync(join(root, "src/orders/create.js"), "export const create = () => 1;\n");
    writeFileSync(join(root, "src/other.js"), "export const other = 2;\n");
    writeFileSync(join(root, "docs/README.md"), "docs\n");
    writeFileSync(join(root, "package.json"), "{\"name\":\"fixture\"}\n");
    const raw = minimalPolicy();
    policyPatch(raw);
    const policy = parseE2ePolicy(JSON.stringify(raw));
    writeFileSync(join(root, ".interlinked/behavioral-contracts.json"), JSON.stringify({ version: 1, cases: [{ id: "orders.create", description: "d", source: { kind: "example", path: "docs/README.md", sha256: "a".repeat(64), quote: "docs" }, inputs: ["dist/cli.js"], runner: { kind: "process", argv: ["node", "dist/cli.js"] }, expect: { exitCode: 0 } }] }));
    return { root, policy };
}
function scenarioOf(policy: E2ePolicy) { return { project: policy.projects[0]!, scenario: policy.projects[0]!.scenarios[0]! }; }

describe("scenarioInputs — positive (must include)", () => {
    it("P1: includes files matching affects and shared inputs, plus the contract manifest; suite artifacts are bound at run time, not here", () => {
        const { root, policy } = setup(raw => { raw.sharedInputs = ["package.json"]; });
        const { project, scenario } = scenarioOf(policy);
        const inputs = scenarioInputs(root, policy, project, scenario);
        expect(inputs.files.map(row => row.path)).toEqual([".interlinked/behavioral-contracts.json", "docs/README.md", "package.json", "src/orders/create.js", "src/other.js"]);
        expect(inputs.contractCaseDigests).toHaveLength(1);
        expect(inputs.gaps).toEqual([]);
    });
    it("N0: a referenced case input that is neither present nor a declared artifact is a gap", () => {
        // SAFETY (test): minimalPolicy() builds exactly this nested shape.
        const { root, policy } = setup(raw => { (((raw.projects as Record<string, unknown>[])[0]!.suites as Record<string, unknown>[])[0]!).artifacts = []; });
        const { project, scenario } = scenarioOf(policy);
        expect(scenarioInputs(root, policy, project, scenario).gaps).toContain("contract input dist/cli.js is absent");
    });
});
describe("scenarioGeneration — behavior", () => {
    it("P2: a relevant edit changes the generation; an unrelated docs edit does not (PE-04, PE-16)", () => {
        const { root, policy } = setup();
        const { project, scenario } = scenarioOf(policy);
        const before = scenarioGeneration(root, policy, "p".repeat(64), project, scenario);
        writeFileSync(join(root, "docs/NOTES.md"), "unrelated docs\n");
        expect(scenarioGeneration(root, policy, "p".repeat(64), project, scenario).generation).toBe(before.generation);
        writeFileSync(join(root, "docs/README.md"), "docs changed\n"); // the CITED requirement is an input (R1)
        expect(scenarioGeneration(root, policy, "p".repeat(64), project, scenario).generation).not.toBe(before.generation);
        writeFileSync(join(root, "docs/README.md"), "docs\n");
        writeFileSync(join(root, "src/orders/create.js"), "export const create = () => 2;\n");
        expect(scenarioGeneration(root, policy, "p".repeat(64), project, scenario).generation).not.toBe(before.generation);
    });
    it("P3: a policy digest change and a contract case change each move the generation (PE-06)", () => {
        const { root, policy } = setup();
        const { project, scenario } = scenarioOf(policy);
        const before = scenarioGeneration(root, policy, "p".repeat(64), project, scenario);
        expect(scenarioGeneration(root, policy, "q".repeat(64), project, scenario).generation).not.toBe(before.generation);
        writeFileSync(join(root, ".interlinked/behavioral-contracts.json"), JSON.stringify({ version: 1, cases: [{ id: "orders.create", description: "d", source: { kind: "example", path: "docs/README.md", sha256: "a".repeat(64), quote: "docs" }, inputs: ["dist/cli.js"], runner: { kind: "process", argv: ["node", "dist/cli.js"] }, expect: { exitCode: 1 } }] }));
        expect(scenarioGeneration(root, policy, "p".repeat(64), project, scenario).generation).not.toBe(before.generation);
    });
    it("N1: a missing manifest or a manifest without the referenced case is a gap, not a generation", () => {
        const { root, policy } = setup();
        const { project, scenario } = scenarioOf(policy);
        rmSync(join(root, ".interlinked/behavioral-contracts.json"));
        const result = scenarioGeneration(root, policy, "p".repeat(64), project, scenario);
        expect(result.gaps.join("\n")).toMatch(/manifest/);
    });
});
describe("collectProjectInputs", () => {
    it("P4: lists protected and shared files under the project root with digests, ignoring .git and .interlinked bulk", () => {
        const { root, policy } = setup();
        mkdirSync(join(root, ".git"), { recursive: true });
        writeFileSync(join(root, ".git/HEAD"), "ref\n");
        const { files, gaps } = collectProjectInputs(join(root, policy.projects[0]!.root), ["src/**"]);
        expect(files.map(row => row.path)).toEqual(["src/orders/create.js", "src/other.js"]);
        expect(files[0]?.sha256).toHaveLength(64);
        expect(gaps).toEqual([]);
    });
    it("P5: a glob rooted in a normally skipped directory keeps it (declared Rust target/ artifacts)", () => {
        const { root } = setup();
        mkdirSync(join(root, "target/release"), { recursive: true });
        writeFileSync(join(root, "target/release/orders_cli"), "binary\n");
        expect(collectProjectInputs(root, ["target/**"]).files.map(row => row.path)).toEqual(["target/release/orders_cli"]);
        expect(collectProjectInputs(root, ["src/**"]).files.map(row => row.path)).not.toContain("target/release/orders_cli");
    });
    it("N2: an oversized declared input and a symlink are reported as gaps, never silently dropped (R2)", () => {
        const { root, policy } = setup(raw => { (raw.projects as Record<string, unknown>[])[0]!.sharedInputs = ["large.dat", "link.js"]; }); // SAFETY (test): fixture shape
        writeFileSync(join(root, "large.dat"), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
        symlinkSync(join(root, "src/other.js"), join(root, "link.js"));
        const { project, scenario } = scenarioOf(policy);
        const result = scenarioGeneration(root, policy, "p".repeat(64), project, scenario);
        expect(result.gaps).toEqual(expect.arrayContaining([expect.stringMatching(/large\.dat not captured: larger than/), expect.stringMatching(/link\.js not captured: symbolic link/)]));
    });
});
