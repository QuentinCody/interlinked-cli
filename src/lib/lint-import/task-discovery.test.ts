import { describe, expect, it } from "vitest";
import { discoverLintCommand } from "./command-discovery.js";
import { lintInvocationsInFile } from "./invocation-files.js";
import { yamlDocumentCommands, yamlLintCommands } from "./yaml-commands.js";

describe("task and CI lint evidence", () => {
    it("inherits job defaults and respects later step cwd fields independently of YAML key order", () => {
        const document = { defaults: { run: { "working-directory": "packages/default" } }, jobs: { lint: { defaults: { run: { "working-directory": "packages/api" } }, steps: [{ run: "ruff check src" }, { run: "eslint .", "working-directory": "packages/ui" }] } } };
        const commands = yamlDocumentCommands(".github/workflows/ci.yml", "", document);
        expect(commands.map((source) => [source.command, source.scope])).toEqual([["ruff check src", "packages/api"], ["eslint .", "packages/ui"]]);
        expect(commands.flatMap(discoverLintCommand).map((candidate) => candidate.entry?.cadence)).toEqual(["audit", "audit"]);
    });
    it("keeps matrix/env/task dependency contexts unresolved instead of changing their meaning", () => {
        const document = { jobs: { lint: { strategy: { matrix: { package: ["api", "ui"] } }, steps: [{ run: "eslint ." }] } } };
        const candidates = yamlDocumentCommands(".github/workflows/ci.yml", "", document).flatMap(discoverLintCommand);
        expect(candidates).toEqual([expect.objectContaining({ reason: expect.stringContaining("dependencies requiring review") })]);
        expect(candidates[0]?.entry).toBeUndefined();
    });
    it("keeps lint-bearing invalid or unsupported YAML visible", () => {
        const candidates = yamlLintCommands(".github/workflows/ci.yml", "run: [ruff check .").flatMap(discoverLintCommand);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.reason).toBeTruthy();
        expect(candidates[0]?.entry).toBeUndefined();
    });
    it("resolves Taskfile directories relative to the task file", () => {
        const commands = yamlDocumentCommands("packages/api/Taskfile.yml", "", { tasks: { lint: { dir: "src", cmds: ["ruff check ."] } } });
        expect(commands[0]?.scope).toBe("packages/api/src");
    });
    it("retains build DSL and staged-file execution context for review", () => {
        const gradle = lintInvocationsInFile("build.gradle.kts", 'plugins { id("io.gitlab.arturbosch.detekt") }');
        const staged = lintInvocationsInFile("lint-staged.config.mjs", 'export default { "*.js": "eslint" };');
        expect([...gradle, ...staged].map((candidate) => candidate.reason)).toEqual([expect.stringContaining("declared adapter"), expect.stringContaining("declared adapter")]);
    });
    it("detects shell hooks without an extension and CI references to package lint aliases", () => {
        expect(lintInvocationsInFile(".husky/pre-commit", "npm run lint\n")).toHaveLength(1);
        expect(discoverLintCommand({ command: "npm run lint", scope: ".", origin: { file: "ci.yml", line: 1, kind: "ci", label: "run" } })[0]?.reason).toBeTruthy();
    });
});
