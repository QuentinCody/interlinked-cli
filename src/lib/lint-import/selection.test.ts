import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lintEntryKey } from "./identity.js";
import { checkLintSources, LINT_POLICY_PATH, loadLintPolicy, writeLintJson } from "./policy.js";
import { prepareLintImport } from "./selection.js";

const directories: string[] = [];
function project(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-selection-")));
    directories.push(root);
    return root;
}
function put(root: string, file: string, content = "export default [];\n"): void {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
}
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("explicit ESLint import profiles", () => {
    it("previews arbitrary names without execution and automatically discovers named audit profiles", () => {
        const root = project();
        put(root, ".oxlintrc.json", "{}");
        put(root, "eslint.config.mjs");
        put(root, "eslint.other.config.mjs");
        put(root, "tools/custom.mjs", "throw new Error('preview must not execute');");
        const plan = prepareLintImport(root, { eslintConfig: ["./tools/custom.mjs", "tools/custom.mjs"] });
        expect(plan.policy.entries).toEqual([
            expect.objectContaining({ tool: "eslint", scope: ".", config: "eslint.other.config.mjs", cadence: "audit" }),
            { tool: "eslint", scope: ".", config: "tools/custom.mjs", sources: ["tools/custom.mjs"] },
            { tool: "oxlint", scope: ".", sources: [".oxlintrc.json"] },
            { tool: "eslint", scope: ".", sources: ["eslint.config.mjs"] },
        ]);
        expect(plan.review.map((source) => source.file)).toEqual([]);
        expect(plan.policy.digests["tools/custom.mjs"]).toMatch(/^[a-f0-9]{64}$/);
        expect(existsSync(join(root, ".interlinked"))).toBe(false);
    });

    it("retains multiple profiles and refreshes their digests on reimport without repeated selectors", () => {
        const root = project();
        put(root, "tools/first.mjs");
        put(root, "tools/second.mjs");
        mkdirSync(join(root, "packages/app"), { recursive: true });
        const first = prepareLintImport(root, { eslintConfig: ["tools/first.mjs", "tools/second.mjs"], eslintScope: "./packages/app/" }).policy;
        writeLintJson(root, LINT_POLICY_PATH, first);
        expect(loadLintPolicy(root)).toEqual(first);
        put(root, "tools/first.mjs", "export default [{ rules: {} }];\n");
        expect(() => checkLintSources(root, first)).toThrow("configuration changed");
        const refreshed = prepareLintImport(root, {}).policy;
        expect(refreshed.entries).toEqual(first.entries);
        expect(refreshed.digests["tools/first.mjs"]).not.toBe(first.digests["tools/first.mjs"]);
        expect(() => checkLintSources(root, refreshed)).not.toThrow();
        expect(readFileSync(join(root, LINT_POLICY_PATH), "utf8")).toContain(first.digests["tools/first.mjs"]);
        rmSync(join(root, "tools/first.mjs"));
        expect(() => prepareLintImport(root, {})).toThrow();
    });

    it("keeps legacy keys stable and separates configurations and working scopes", () => {
        const root = project();
        put(root, "first.mjs");
        put(root, "second.mjs");
        const { entries } = prepareLintImport(root, { eslintConfig: ["first.mjs", "second.mjs"] }).policy;
        const first = entries[0]!;
        const legacy = { tool: "eslint", scope: ".", sources: ["eslint.config.mjs"] };
        expect(lintEntryKey(legacy)).toBe("eslint:.");
        expect(new Set([...entries, { ...first, scope: "nested" }, legacy].map(lintEntryKey)).size).toBe(4);
    });

    it("rejects invalid selections and confinement escapes before writing artifacts", () => {
        const root = project();
        const outside = project();
        put(root, "custom.mjs");
        put(outside, "external.mjs");
        symlinkSync(join(outside, "external.mjs"), join(root, "linked.mjs"));
        for (const file of ["../external.mjs", "linked.mjs", "missing.mjs", ".", ""]) {
            expect(() => prepareLintImport(root, { eslintConfig: [file] })).toThrow();
        }
        expect(() => prepareLintImport(root, { eslintScope: "." })).toThrow("requires --eslint-config");
        expect(() => prepareLintImport(root, { eslintConfig: ["custom.mjs"], eslintScope: "custom.mjs" })).toThrow("directory");
        expect(existsSync(join(root, ".interlinked"))).toBe(false);
    });

    it("rejects oversized and symlinked explicit files even when discovery would not recognize their names", () => {
        const root = project();
        put(root, "large.mjs", " ".repeat(1_000_001));
        symlinkSync(join(root, "large.mjs"), join(root, "local-link.mjs"));
        expect(() => prepareLintImport(root, { eslintConfig: ["large.mjs"] })).toThrow("exceeds");
        expect(() => prepareLintImport(root, { eslintConfig: ["local-link.mjs"] })).toThrow("regular file");
    });

    it("validates profile provenance and duplicate identities when loading committed policy", () => {
        const root = project();
        put(root, "custom.mjs");
        const policy = prepareLintImport(root, { eslintConfig: ["custom.mjs"] }).policy;
        const entry = policy.entries[0]!;
        for (const invalid of [{ ...entry, config: "untracked.mjs" }, { ...entry, tool: "shellcheck" }, { ...entry, config: 42 }]) {
            writeLintJson(root, LINT_POLICY_PATH, { ...policy, entries: [invalid] });
            expect(() => loadLintPolicy(root)).toThrow();
        }
        writeLintJson(root, LINT_POLICY_PATH, { ...policy, entries: [entry, { ...entry, scope: "./" }] });
        expect(() => loadLintPolicy(root)).toThrow("Duplicate");
    });
});
