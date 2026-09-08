import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLintBaseline, newLintFindings, retireLintDebt, tightenLintBaseline } from "./baseline.js";
import { LINT_POLICY_PATH, loadLintPolicy, writeLintJson } from "./policy.js";
import { measureImportedLint } from "./runner.js";
import { prepareLintImport } from "./selection.js";

const roots: string[] = [];
function project(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sarif-runner-")));
    roots.push(root);
    mkdirSync(join(root, ".interlinked"));
    writeFileSync(join(root, "app.js"), "debugger;\n");
    writeFileSync(join(root, "analyzer.mjs"), `import { readFileSync } from "node:fs";
const source = readFileSync("app.js", "utf8");
const results = source.includes("debugger") ? [{ ruleId: "no-debugger", message: { text: "Remove debugger" }, locations: [{ physicalLocation: { artifactLocation: { uri: "app.js" }, region: { startLine: 1 } } }] }] : [];
console.log(JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "FixtureLint" } }, invocations: [{ executionSuccessful: !source.includes("FAIL") }], results }] }));
`);
    writeFileSync(join(root, ".interlinked/lint-adapters.json"), JSON.stringify({ version: 1, adapters: [{ id: "project-check", command: "node", args: ["analyzer.mjs"], format: "sarif", scope: ".", configs: ["analyzer.mjs"] }] }));
    return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("declared analyzer execution and ratcheting", () => {
    it("runs a declared analyzer, preserves audit cadence, retires fixes and rejects reintroduced debt", async () => {
        const root = project();
        const policy = prepareLintImport(root, {}).policy;
        writeLintJson(root, LINT_POLICY_PATH, policy);
        expect(loadLintPolicy(root)).toEqual(policy);
        const initial = await measureImportedLint(root, policy);
        expect(initial[0]).toMatchObject({ status: "measured", entry: { tool: "sarif:project-check", cadence: "audit" }, findings: [{ rule: "FixtureLint/no-debugger", file: "app.js" }] });
        tightenLintBaseline(root, initial);
        expect(await measureImportedLint(root, policy, { cadence: "hook" })).toEqual([]);
        writeFileSync(join(root, "app.js"), "export const answer = 42;\n");
        retireLintDebt(root, await measureImportedLint(root, policy));
        writeFileSync(join(root, "app.js"), "debugger;\n");
        const returned = await measureImportedLint(root, policy);
        expect(newLintFindings(returned[0]!, loadLintBaseline(root))).toHaveLength(1);
    });
    it("keeps debt when a zero-exit report declares failed analysis", async () => {
        const root = project();
        const { policy } = prepareLintImport(root, {});
        tightenLintBaseline(root, await measureImportedLint(root, policy));
        const before = loadLintBaseline(root);
        writeFileSync(join(root, "app.js"), "// FAIL\n");
        const measurements = await measureImportedLint(root, policy);
        expect(measurements[0]).toMatchObject({ status: "unavailable", findings: [] });
        expect(() => tightenLintBaseline(root, measurements)).toThrow("incomplete");
        expect(loadLintBaseline(root)).toEqual(before);
    });
});
