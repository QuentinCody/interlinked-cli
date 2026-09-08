import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverLintCommand } from "./command-discovery.js";
import { lintEntryKey } from "./identity.js";
import { importedLintInvocation } from "./invocation.js";
import { lintJsonc } from "./json.js";
import { checkLintSources, LINT_POLICY_PATH, loadLintPolicy, writeLintJson } from "./policy.js";
import { prepareLintImport } from "./selection.js";

const roots: string[] = [];
function project() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-automatic-")));
    roots.push(root);
    return {
        root,
        put(file: string, text: string): void {
            mkdirSync(dirname(join(root, file)), { recursive: true });
            writeFileSync(join(root, file), text);
        },
    };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function command(text: string) {
    return discoverLintCommand({ command: text, scope: ".", origin: { file: "package.json", line: 1, kind: "package-script", label: "scripts.lint" } });
}

describe("automatic lint adoption", () => {
    it("can discover current profiles independently of an invalid saved policy", () => {
        const { root, put } = project();
        put("eslint.config.mjs", "export default [];");
        put(LINT_POLICY_PATH, "{");
        expect(() => prepareLintImport(root, {})).toThrow("Invalid lint JSON");
        expect(prepareLintImport(root, {}, null).policy.entries[0]?.tool).toBe("eslint");
    });
    it("preserves an explicit cadence across reimports and applies a cadence override to default profiles", () => {
        const { root, put } = project();
        put("eslint.typed.config.mjs", "export default [];");
        put("biome.json", "{}");
        const initial = prepareLintImport(root, { cadence: "hook" }).policy;
        expect(initial.entries.every((entry) => entry.cadence === "hook")).toBe(true);
        writeLintJson(root, LINT_POLICY_PATH, initial);
        expect(prepareLintImport(root, {}).policy.entries.find((entry) => entry.config)?.cadence).toBe("hook");
        expect(prepareLintImport(root, { cadence: "audit" }).policy.entries.every((entry) => entry.cadence === "audit")).toBe(true);
    });
    it("does not treat package exports or ordinary plugin strings as configuration dependencies", () => {
        const { root, put } = project();
        put("eslint.config.mjs", 'export default [{ settings: { fixture: "./app.js" } }];');
        put("package.json", '{"exports":"./dist/index.js"}');
        put("dist/index.js", "x".repeat(1_000_001));
        put("app.js", "debugger;");
        expect(Object.keys(prepareLintImport(root, {}).policy.digests).sort()).toEqual(["eslint.config.mjs", "package.json"]);
    });
    it("absorbs aliases and arbitrary script names in their package scope without executing configs", () => {
        const { root, put } = project();
        put("packages/api/package.json", JSON.stringify({ scripts: { inspect: "eslint --config ../../rules/typed.mjs src --rule 'no-debugger:warn'", lint: "npm run inspect" } }));
        put("rules/typed.mjs", "throw new Error('preview must not execute');");
        const { policy, inventory, review } = prepareLintImport(root, {});
        expect(policy.entries).toHaveLength(1);
        expect(policy.entries[0]).toMatchObject({ tool: "eslint", scope: "packages/api", config: "rules/typed.mjs", targets: ["src"], flags: ["--rule", "no-debugger:warn"] });
        expect(inventory.invocations?.map((candidate) => candidate.origin.label)).toEqual(["scripts.inspect", "scripts.lint"]);
        expect(review).toEqual([]);
        expect(existsSync(join(root, ".interlinked"))).toBe(false);
    });

    it("hashes transitive local presets and plugin implementations and refuses drift", () => {
        const { root, put } = project();
        put("eslint.config.mjs", 'import rules from "./rules/index.mjs"; export default rules;');
        put("rules/index.mjs", 'export { default } from "./no-slop.mjs";');
        put("rules/no-slop.mjs", "export default [];");
        put("package-lock.json", '{"lockfileVersion":3}');
        const { policy } = prepareLintImport(root, {});
        expect(Object.keys(policy.digests).sort()).toEqual(["eslint.config.mjs", "package-lock.json", "rules/index.mjs", "rules/no-slop.mjs"]);
        put("rules/no-slop.mjs", "export default [{}];");
        expect(() => checkLintSources(root, policy)).toThrow("configuration changed");
    });

    it("preserves explicit arbitrary analyzer configs and validates persisted semantic flags", () => {
        const { root, put } = project();
        put("rules/python.toml", '[lint]\nselect=["F"]');
        const { policy } = prepareLintImport(root, { config: ["ruff=rules/python.toml"], cadence: "audit" });
        writeLintJson(root, LINT_POLICY_PATH, policy);
        expect(loadLintPolicy(root)).toEqual(policy);
        expect(importedLintInvocation(root, policy.entries[0]!)).toMatchObject({ command: "ruff", args: ["check", "--config", join(root, "rules/python.toml"), "--output-format=json", "."] });
        writeLintJson(root, LINT_POLICY_PATH, { ...policy, entries: [{ ...policy.entries[0], flags: ["--fix"] }] });
        expect(() => loadLintPolicy(root)).toThrow();
    });

    it("retains unsupported scripts as review evidence without making an imported policy permanently stale", () => {
        const { root, put } = project();
        put("eslint.config.mjs", "export default [];");
        put("package.json", JSON.stringify({ scripts: { lint: "eslint --fix ." } }));
        const { policy, inventory } = prepareLintImport(root, {});
        expect(inventory.invocations?.[0]?.reason).toContain("Unsupported option");
        expect(() => checkLintSources(root, policy)).not.toThrow();
        put("package.json", JSON.stringify({ scripts: { lint: "eslint src" } }));
        expect(() => checkLintSources(root, policy)).toThrow("configuration changed");
    });

    it("detects newly introduced invocation files even for previously unadopted tools", () => {
        const { root, put } = project();
        put("eslint.config.mjs", "export default [];");
        const { policy } = prepareLintImport(root, {});
        put("api/package.json", JSON.stringify({ scripts: { validate: "ruff check ." } }));
        expect(() => checkLintSources(root, policy)).toThrow("New lint configuration");
    });

    it("keeps missing command inputs visible for review and adopts the independent configuration", () => {
        const { root, put } = project();
        put("eslint.config.mjs", "export default [];");
        put("package.json", JSON.stringify({ scripts: { lint: "eslint --config missing.mjs ." } }));
        const plan = prepareLintImport(root, {});
        expect(plan.policy.entries).toHaveLength(1);
        expect(plan.inventory.invocations?.[0]?.entry).toBeUndefined();
        expect(plan.inventory.invocations?.[0]?.reason).toContain("ENOENT");
    });

    it("reads JSONC tasks while preserving comment-like string contents", () => {
        expect(lintJsonc('{/*comment*/"url":"https://test/a,}","tasks":{"lint":"ruff check .",},}')).toEqual({ url: "https://test/a,}", tasks: { lint: "ruff check ." } });
        const { root, put } = project();
        put("deno.jsonc", '{// task\n"tasks":{"audit":"ruff check --select F src",},}');
        expect(prepareLintImport(root, {}).policy.entries[0]).toMatchObject({ tool: "ruff", targets: ["src"], flags: ["--select", "F"] });
    });
});

describe("literal command preservation", () => {
    it.each(["eslint --fix .", "ruff check --fix .", "eslint src | tee result", "eslint $(pwd)", "eslint `pwd`", "eslint --unknown src", "eslint --output report.json .", "cd ../outside && eslint ."])("leaves %s for review", (text) => {
        const candidates = command(text);
        expect(candidates).not.toHaveLength(0);
        expect(candidates.every((candidate) => !candidate.entry && Boolean(candidate.reason))).toBe(true);
    });

    it("preserves native options and makes targets and rule selections independent baseline identities", () => {
        const first = command("cd packages/api && uv run ruff check --select F src")[0]!.entry!;
        const second = command("cd packages/api && uv run ruff check --select E tests")[0]!.entry!;
        expect(first).toMatchObject({ tool: "ruff", scope: "packages/api", targets: ["src"], flags: ["--select", "F"] });
        expect(lintEntryKey(first)).not.toEqual(lintEntryKey(second));
        expect(command("mypy --strict --package app")[0]?.entry?.cadence).toBe("audit");
    });
});
