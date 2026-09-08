import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runImportedLintAsync } from "../harness/check-engine/tool-runners/lint-import.js";
import { LINT_BASELINE_PATH, loadLintPolicy } from "../lib/lint-import/policy.js";
import { lintCheckCommand, lintImportCommand } from "./lint.js";

// Optional real-engine coverage: use an existing installation, never fetch packages in tests.
const binary = resolve(process.env.INTERLINKED_TEST_OXLINT_BIN ?? "node_modules/.bin/oxlint");
const directories: string[] = [];
function project(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-oxlint-integration-")));
    directories.push(root);
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    symlinkSync(binary, join(root, "node_modules/.bin/oxlint"));
    writeFileSync(join(root, ".oxlintrc.json"), '{"categories":{"correctness":"off"},"rules":{"no-debugger":"warn"}}\n');
    writeFileSync(join(root, "app.js"), "debugger;\n");
    return root;
}
afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!existsSync(binary))("lint adoption with a real Oxlint executable", () => {
    it("adopts exit-zero warnings, retires fixes, gates reintroduction and preserves debt on parse failure", async () => {
        const root = project();
        vi.spyOn(console, "log").mockImplementation(() => {});
        await lintImportCommand(root, { write: true, baseline: true, json: true });
        expect(loadLintPolicy(root)?.entries).toEqual([{ tool: "oxlint", scope: ".", sources: [".oxlintrc.json"] }]);
        expect(process.exitCode ?? 0).toBe(0);
        expect(await runImportedLintAsync({ scope: { projectRoot: root, mode: "project" }, timeoutMs: 10_000 })).toEqual([]);
        const before = readFileSync(join(root, LINT_BASELINE_PATH), "utf8");
        writeFileSync(join(root, "app.js"), "function {\n");
        await lintCheckCommand(root, { updateBaseline: true, json: true });
        expect(process.exitCode).toBe(2);
        expect(readFileSync(join(root, LINT_BASELINE_PATH), "utf8")).toBe(before);

        process.exitCode = 0;
        writeFileSync(join(root, "app.js"), "console.log('fixed');\n");
        await lintCheckCommand(root, { json: true });
        expect(process.exitCode).toBe(0);
        writeFileSync(join(root, "app.js"), "debugger;\n");
        const findings = await runImportedLintAsync({ scope: { projectRoot: root, mode: "project" }, timeoutMs: 10_000 });
        expect(findings).toEqual([expect.objectContaining({ file: "app.js", ruleId: "oxlint/eslint(no-debugger)" })]);
        await lintCheckCommand(root, { updateBaseline: true, json: true });
        expect(process.exitCode).toBe(1);
    });

    it("imports configured JavaScript plugin rules using the original Oxlint engine", async () => {
        const root = project();
        writeFileSync(join(root, "anti-slop.mjs"), `export default { meta: { name: "anti-slop" }, rules: {
            "no-unknown-type-alias": { meta: { schema: [], messages: { unknown: "Avoid aliases that erase the useful type." } },
                create(context) { return { TSTypeAliasDeclaration(node) {
                    if (node.typeAnnotation.type === "TSUnknownKeyword") context.report({ node, messageId: "unknown" });
                } }; }
            }
        } };\n`);
        writeFileSync(join(root, ".oxlintrc.json"), JSON.stringify({ categories: { correctness: "off" }, jsPlugins: ["./anti-slop.mjs"], rules: { "anti-slop/no-unknown-type-alias": "warn" } }));
        writeFileSync(join(root, "alias.ts"), "export type Payload = unknown;\n");
        vi.spyOn(console, "log").mockImplementation(() => {});
        await lintImportCommand(root, { write: true, json: true });
        const findings = await runImportedLintAsync({ scope: { projectRoot: root, mode: "project" }, timeoutMs: 10_000 });
        expect(findings).toEqual([expect.objectContaining({ file: "alias.ts", ruleId: expect.stringContaining("no-unknown-type-alias") })]);
        await lintCheckCommand(root, { updateBaseline: true, json: true });
        expect(process.exitCode ?? 0).toBe(0);
        expect(await runImportedLintAsync({ scope: { projectRoot: root, mode: "project" }, timeoutMs: 10_000 })).toEqual([]);
    });
});
