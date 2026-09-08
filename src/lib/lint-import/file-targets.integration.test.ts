import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lintCheckCommand } from "../../commands/lint.js";
import { tightenLintBaseline } from "./baseline.js";
import { LINT_BASELINE_PATH, LINT_POLICY_PATH, writeLintJson } from "./policy.js";
import { measureImportedLint } from "./runner.js";
import { prepareLintImport } from "./selection.js";

const adapters = [
    { tool: "shellcheck", config: ".shellcheckrc", content: "disable=SC2034\n", file: "input.sh", extra: "selected.sh", pattern: "**/*.sh", rule: "SC2086" },
    { tool: "hadolint", config: "hadolint.yaml", content: "ignored: []\n", file: "Dockerfile", extra: "Dockerfile.selected", pattern: "**/Dockerfile*", rule: "DL3006" },
] as const;
const roots: string[] = [];
const originalExitCode = process.exitCode;
afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(adapter: typeof adapters[number]): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-file-targets-")));
    roots.push(root);
    for (const directory of ["bin", "vendor", ".interlinked"]) mkdirSync(join(root, directory));
    writeFileSync(join(root, adapter.config), adapter.content);
    writeFileSync(join(root, adapter.file), "# clean input\n");
    writeFileSync(join(root, adapter.extra), "# BAD input\n");
    const executable = join(root, "bin", adapter.tool);
    // Report only files actually passed to the child, making dropped targets
    // observable through measured diagnostics and baseline retirement.
    writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const files = process.argv.slice(2).filter(arg => !arg.startsWith("--format="));
fs.writeFileSync(".interlinked/argv.json", JSON.stringify(files));
const findings = files.filter(file => fs.readFileSync(file, "utf8").includes("BAD")).map(file => ({ file, line: 1, code: ${adapter.tool === "shellcheck" ? "2086" : '"DL3006"'}, message: "fixture finding" }));
fs.writeSync(1, JSON.stringify(${adapter.tool === "shellcheck" ? "{ comments: findings }" : "findings"}));
process.exitCode = findings.length ? 1 : 0;
`);
    chmodSync(executable, 0o700);
    return root;
}

function policyWithTargets(root: string, targets: string[]) {
    const { policy } = prepareLintImport(root, {});
    assert(policy.entries.length === 1);
    const entry = policy.entries[0];
    assert(entry);
    entry.targets = targets;
    return policy;
}

describe.each(adapters)("explicit $tool inputs", adapter => {
    it("passes requested vendor files and regular-file symlinks unchanged to the analyzer", async () => {
        const root = project(adapter);
        const vendor = `vendor/${adapter.extra}`, alias = `linked-${adapter.extra}`;
        writeFileSync(join(root, vendor), "# BAD vendor input\n");
        symlinkSync(vendor, join(root, alias));
        const targets = [adapter.file, vendor, alias];
        const report = await measureImportedLint(root, policyWithTargets(root, targets));
        expect(report).toMatchObject([{ status: "measured", findings: [
            { file: vendor, rule: adapter.rule }, { file: alias, rule: adapter.rule },
        ] }]);
        expect(JSON.parse(readFileSync(join(root, ".interlinked/argv.json"), "utf8"))).toEqual(targets);
    });

    it("preserves debt when one requested file disappears while another still exists", async () => {
        const root = project(adapter);
        const policy = policyWithTargets(root, [adapter.file, adapter.extra]);
        writeLintJson(root, LINT_POLICY_PATH, policy);
        const initial = await measureImportedLint(root, policy);
        expect(initial).toMatchObject([{ status: "measured", findings: [{ file: adapter.extra, rule: adapter.rule }] }]);
        tightenLintBaseline(root, initial);
        const baseline = readFileSync(join(root, LINT_BASELINE_PATH), "utf8");
        rmSync(join(root, adapter.extra));
        rmSync(join(root, ".interlinked/argv.json"));
        const output = vi.spyOn(console, "log").mockImplementation(() => {});
        await lintCheckCommand(root, { json: true });
        expect(process.exitCode).toBe(2);
        const report: unknown = JSON.parse(String(output.mock.calls[0]?.[0]));
        expect(report).toMatchObject({ complete: false, baseline_updated: false, measurements: [{ status: "unavailable", reason: expect.stringContaining(adapter.extra) }] });
        expect(readFileSync(join(root, LINT_BASELINE_PATH), "utf8")).toBe(baseline);
        expect(existsSync(join(root, ".interlinked/argv.json"))).toBe(false);
    });

    it.each([
        { name: "pattern", target: adapter.pattern, reason: "needs literal file targets" },
        { name: "runtime-pattern", target: `.interlinked/${adapter.pattern}`, reason: "omitted runtime state" },
        { name: "directory", target: "vendor", reason: "not a regular file" },
        { name: "empty", target: null, reason: "No explicit lint files" },
    ])("refuses $name scope instead of measuring a surviving subset", async ({ target, reason }) => {
        const root = project(adapter);
        writeFileSync(join(root, ".interlinked", adapter.extra), "# BAD runtime input\n");
        const targets = target === null ? [] : [adapter.file, target];
        const report = await measureImportedLint(root, policyWithTargets(root, targets));
        expect(report).toMatchObject([{ status: "unavailable", findings: [] }]);
        expect(report[0]?.reason).toContain(reason);
        expect(existsSync(join(root, ".interlinked/argv.json"))).toBe(false);
    });

    it("refuses a requested symlink that escapes the working scope", async () => {
        const root = project(adapter), external = project(adapter);
        const alias = `linked-${adapter.extra}`;
        symlinkSync(join(external, adapter.extra), join(root, alias));
        const report = await measureImportedLint(root, policyWithTargets(root, [adapter.file, alias]));
        expect(report).toMatchObject([{ status: "unavailable", reason: expect.stringContaining("escapes project") }]);
        expect(existsSync(join(root, ".interlinked/argv.json"))).toBe(false);
    });
});
