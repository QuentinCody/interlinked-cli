import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { newLintFindings, tightenLintBaseline } from "../lib/lint-import/baseline.js";
import { measureImportedLint } from "../lib/lint-import/runner.js";
import { prepareLintImport } from "../lib/lint-import/selection.js";

const roots: string[] = [];
const plugin = resolve("tools/oxlint/anti-slop");
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(rules: string[], code: string) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-anti-slop-")));
    roots.push(root);
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    mkdirSync(join(root, "node_modules/@oxlint"));
    symlinkSync(resolve("node_modules/.bin/oxlint"), join(root, "node_modules/.bin/oxlint"));
    symlinkSync(resolve("node_modules/@oxlint/plugins"), join(root, "node_modules/@oxlint/plugins"));
    cpSync(plugin, join(root, "plugin"), { recursive: true });
    writeFileSync(join(root, "oxlint.audit.json"), JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [{ name: "anti-slop", specifier: "./plugin/index.ts" }],
        rules: Object.fromEntries(rules.map((rule) => [`anti-slop/${rule}`, "warn"])),
    }));
    writeFileSync(join(root, "src/app.ts"), code);
    const { policy } = prepareLintImport(root, { config: ["oxlint=oxlint.audit.json"], scope: "src", cadence: "audit", onlySelected: true });
    return { root, policy };
}

it("loads the pinned upstream plugin and reports non-spread accumulator copies without flagging local mutation", async () => {
    const { root, policy } = project(["no-reduce-accumulator-copy"], [
        "items.reduce((acc, item) => Object.assign({}, acc, item), {});",
        "items.reduce((acc, item) => acc.concat(item), []);",
        "items.reduce((acc, item) => { acc.push(item); return acc; }, []);",
        "items.reduce((acc, item) => Object.assign(acc, item), {});",
    ].join("\n"));
    const measured = await measureImportedLint(root, policy);
    expect(measured).toHaveLength(1);
    expect(measured[0]).toMatchObject({ status: "measured" });
    expect(measured[0]?.findings.map(({ file, line, rule }) => ({ file, line, rule }))).toEqual([
        { file: "src/app.ts", line: 1, rule: "anti-slop(no-reduce-accumulator-copy)" },
        { file: "src/app.ts", line: 2, rule: "anti-slop(no-reduce-accumulator-copy)" },
    ]);
});

it("keeps audit profiles off hook cadence and reuses lint debt retirement for module mocks", async () => {
    const { root, policy } = project(["no-module-mocking"], 'import { vi } from "vitest";\nvi.mock("./store");\n');
    expect(await measureImportedLint(root, policy, { cadence: "hook" })).toEqual([]);
    const initial = await measureImportedLint(root, policy, { cadence: "audit" });
    expect(initial[0]).toMatchObject({ status: "measured", findings: [{ line: 2, rule: "anti-slop(no-module-mocking)" }] });
    const baseline = tightenLintBaseline(root, initial);
    expect(initial.flatMap((row) => newLintFindings(row, baseline))).toEqual([]);

    writeFileSync(join(root, "src/app.ts"), 'const vi = { mock() {} };\nvi.mock();\n');
    const clean = await measureImportedLint(root, policy);
    expect(clean[0]).toMatchObject({ status: "measured", findings: [] });
    const tightened = tightenLintBaseline(root, clean);
    writeFileSync(join(root, "src/app.ts"), 'import { vi } from "vitest";\nvi.mock("./store");\n');
    const reintroduced = await measureImportedLint(root, policy);
    expect(reintroduced.flatMap((row) => newLintFindings(row, tightened))).toHaveLength(1);
});

it("records the transitive plugin source so source drift invalidates the imported policy", async () => {
    const { root, policy } = project(["no-widen-then-assert"], [
        'const source = { id: "first" };',
        "const widened: unknown = source;",
        "const narrowed = widened as { id: string };",
    ].join("\n"));
    expect(policy.entries[0]?.sources).toContain("plugin/rules/no-widen-then-assert.ts");
    const measured = await measureImportedLint(root, policy);
    expect(measured[0]).toMatchObject({ status: "measured", findings: [{ line: 3, rule: "anti-slop(no-widen-then-assert)" }] });
    const file = join(root, "plugin/rules/no-widen-then-assert.ts");
    writeFileSync(file, readFileSync(file, "utf8") + "\n// changed plugin source\n");
    expect(await measureImportedLint(root, policy, { cadence: "hook" })).toEqual([]);
    await expect(measureImportedLint(root, policy)).rejects.toThrow();
});

it("reports known value widening across bindings, assignments and predicates while retaining boundary inputs", async () => {
    const { root, policy } = project(["no-known-value-widening"], [
        'const source = { id: "first" };',
        "const widened: unknown = source;",
        "let assigned: unknown;",
        "assigned = source;",
        "function isRecord(value: unknown): value is { id: string } { return true; }",
        "isRecord(source);",
        "declare const boundary: unknown;",
        "isRecord(boundary);",
        "const untouched: unknown = boundary;",
        "const accumulator: Record<string, unknown> = {};",
    ].join("\n"));
    const measured = await measureImportedLint(root, policy);
    expect(measured[0]).toMatchObject({ status: "measured" });
    expect(measured[0]?.findings.map(({ line, rule }) => ({ line, rule }))).toEqual([
        { line: 2, rule: "anti-slop(no-known-value-widening)" },
        { line: 4, rule: "anti-slop(no-known-value-widening)" },
        { line: 6, rule: "anti-slop(no-known-value-widening)" },
    ]);
});

it("preserves recorded upstream provenance, local adaptations and exact matching host/runtime pins", () => {
    const provenance = JSON.parse(readFileSync(join(plugin, "UPSTREAM.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    expect(manifest.devDependencies.oxlint).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.devDependencies["@oxlint/plugins"]).toBe(manifest.devDependencies.oxlint);
    expect(Object.keys(provenance.sha256).length).toBeGreaterThan(18);
    for (const [file, expected] of Object.entries(provenance.sha256)) {
        expect(createHash("sha256").update(readFileSync(join(plugin, file))).digest("hex"), file).toBe(provenance.localSha256?.[file] ?? expected);
    }
});
