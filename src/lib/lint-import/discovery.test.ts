import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverLint } from "./discovery.js";
import { checkLintSources, enableImportedLintCheck, lintPath, loadLintPolicy, mergeLintPolicy, planLintImport, writeLintJson, LINT_POLICY_PATH } from "./policy.js";

const directories: string[] = [];
function project(): string {
    const root = mkdtempSync(join(tmpdir(), "lint-discovery-"));
    directories.push(root);
    return root;
}
function put(root: string, file: string, content: string): void {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
}
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("lint discovery and adoption", () => {
    it("tracks Oxlint ancestor ignore changes for nested adopted scopes", () => {
        const root = project();
        put(root, ".eslintignore", "generated/\n");
        put(root, "packages/app/.oxlintrc.json", "{}");
        const policy = planLintImport(discoverLint(root)).policy;
        expect(policy.entries).toEqual([{ tool: "oxlint", scope: "packages/app", sources: ["packages/app/.oxlintrc.json"] }]);
        expect(policy.digests[".eslintignore"]).toMatch(/^[a-f0-9]{64}$/);
        put(root, ".eslintignore", "**/*.js\n");
        expect(() => checkLintSources(root, policy)).toThrow("configuration changed: .eslintignore");
    });
    it("finds hidden and nested configurations across languages without executing JavaScript", () => {
        const root = project();
        put(root, "eslint.config.mjs", "throw new Error('must never execute'); export default [{ rules: { 'no-eval': 'error' } }];");
        put(root, "packages/api/pyproject.toml", '[tool.ruff.lint]\nselect = ["E", "F"]\n');
        put(root, "rust/Cargo.toml", '[package]\nname = "app"\n[lints.clippy]\nunwrap_used = "deny"\n');
        put(root, ".config/.clang-tidy", "Checks: 'bugprone-*'\n");
        put(root, "node_modules/vendor/.eslintrc.json", "{}");
        const inventory = discoverLint(root);
        expect(inventory.complete).toBe(true);
        expect(inventory.sources.map((source) => [source.tool, source.file])).toEqual([
            ["clang-tidy", ".config/.clang-tidy"], ["eslint", "eslint.config.mjs"],
            ["ruff", "packages/api/pyproject.toml"], ["clippy", "rust/Cargo.toml"],
        ]);
        const plan = planLintImport(inventory);
        expect(plan.policy.entries.map((entry) => [entry.tool, entry.scope])).toEqual([["eslint", "."], ["ruff", "packages/api"], ["clippy", "rust"]]);
        expect(plan.review.map((source) => source.tool)).toEqual(["clang-tidy"]);
    });

    it("reports custom scripts and alternate configs for review instead of claiming adoption", () => {
        const root = project();
        put(root, "package.json", JSON.stringify({ scripts: { lint: "node custom-check.js" }, eslintConfig: { rules: { eqeqeq: "error" } } }));
        put(root, "eslint.special.config.mjs", "export default [];");
        const plan = planLintImport(discoverLint(root));
        expect(plan.policy.entries).toEqual([{ tool: "eslint", scope: ".", sources: ["package.json"] }]);
        expect(plan.review.map((source) => source.tool)).toEqual(["eslint", "custom-script"]);
    });
    it("retains only string commands when inspecting package scripts", () => {
        const root = project();
        put(root, "package.json", JSON.stringify({ scripts: { lint: { command: "never execute" }, typecheck: "tsc", dev: "vite" } }));
        const inventory = discoverLint(root);
        expect(inventory.sources).toEqual([expect.objectContaining({ tool: "custom-script", declarations: ["scripts.typecheck: tsc"] })]);
        expect(inventory.complete).toBe(true);
    });
    it("tracks ancestor and nested ignores and refreshes reviewed deletions and config replacements", () => {
        const root = project();
        put(root, ".gitignore", "build/\n");
        put(root, "api/ruff.toml", 'select = ["F"]\n');
        put(root, "api/nested/.ignore", "generated/\n");
        const before = planLintImport(discoverLint(root)).policy;
        expect(Object.keys(before.digests).sort()).toEqual([".gitignore", "api/nested/.ignore", "api/ruff.toml"]);
        rmSync(join(root, "api/ruff.toml"));
        rmSync(join(root, "api/nested/.ignore"));
        put(root, "api/.ruff.toml", 'select = ["F"]\n');
        expect(() => checkLintSources(root, before)).toThrow();
        const refreshed = mergeLintPolicy(root, before, planLintImport(discoverLint(root)).policy);
        expect(refreshed.entries).toEqual([{ tool: "ruff", scope: "api", sources: ["api/.ruff.toml"] }]);
        expect(Object.keys(refreshed.digests).sort()).toEqual([".gitignore", "api/.ruff.toml"]);
        expect(() => checkLintSources(root, refreshed)).not.toThrow();
    });

    it("marks symlinked configurations and malformed manifests incomplete", () => {
        const root = project();
        const outside = project();
        put(outside, "config", "{}");
        symlinkSync(join(outside, "config"), join(root, ".eslintrc.json"));
        put(root, "package.json", "{");
        const inventory = discoverLint(root);
        expect(inventory.complete).toBe(false);
        expect(inventory.warnings).toHaveLength(2);
        expect(inventory.sources).toEqual([]);
    });

    it("preserves unrelated guard settings and serializes a loadable import", () => {
        const root = project();
        put(root, ".eslintrc.json", '{"rules":{"no-eval":"error"}}');
        put(root, ".interlinked/guard-rules.json", JSON.stringify({ enabled: true, quality_checks: { eslint: { enabled: false }, lint_import: { timeout_ms: 5000 } }, file_reminders: ["keep"] }));
        const { policy } = planLintImport(discoverLint(root));
        writeLintJson(root, LINT_POLICY_PATH, policy);
        enableImportedLintCheck(root);
        expect(loadLintPolicy(root)).toEqual(policy);
        expect(JSON.parse(readFileSync(join(root, ".interlinked/guard-rules.json"), "utf8"))).toEqual({ enabled: true, quality_checks: { eslint: { enabled: false }, lint_import: { timeout_ms: 5000, enabled: true } }, file_reminders: ["keep"] });
    });

    it("rejects traversal and output directories that escape through symlinks", () => {
        const root = project();
        const outside = project();
        symlinkSync(outside, join(root, ".interlinked"));
        expect(() => lintPath(root, "../elsewhere")).toThrow("Out-of-project");
        expect(() => writeLintJson(root, LINT_POLICY_PATH, {})).toThrow("escapes project");
    });
});
