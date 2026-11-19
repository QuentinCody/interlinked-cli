import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_QUALITY_CHECKS } from "../harness/rules/default-config-quality-checks.js";
import { createClaudeCodeAdapter } from "../harness/adapters/claude-code.js";
import { callHookDaemon } from "../hook-entry-transport.js";
import { createFixture, type E2eFixture, PROJECT_ROOT } from "./fixture.js";

let fixture: E2eFixture;
beforeAll(async () => {
    const quality_checks = Object.fromEntries(Object.entries(DEFAULT_QUALITY_CHECKS).map(([name, config]) => [name, { ...config, enabled: name === "typescript" }]));
    fixture = await createFixture({ rules: { quality_checks, per_edit_coverage: { enabled: false },
        structural_checks: { enabled: false, smart_tsc: false }, project_wide_checks: { enabled: false } } });
    symlinkSync(join(PROJECT_ROOT, "node_modules"), join(fixture.cwd, "node_modules"));
    fixture.file("package.json", '{"type":"module"}');
    fixture.file("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ["src"] }));
    fixture.file("src/a.ts", "export const answer = 42;\n");
    fixture.file("src/a.test.ts", 'import { answer } from "./a"; void answer;\n');
});
afterAll(async () => { await fixture?.close(); });

it("reports a Commander option mismatch across a registrar and an atomically edited handler", async () => {
    const before = "export function run(opts) { return opts.dryRun; }";
    const after = 'export function run(opts) { return opts["dry-run"]; }';
    const owned = await createFixture({ prepare(cwd) {
        mkdirSync(join(cwd, "src"));
        symlinkSync(join(PROJECT_ROOT, "node_modules"), join(cwd, "node_modules"), "dir");
        writeFileSync(join(cwd, "package.json"), '{"name":"fixture","type":"module"}');
        writeFileSync(join(cwd, "src/handler.ts"), before + "\n");
        writeFileSync(join(cwd, "src/registrar.ts"), 'import { Command } from "commander";\nimport { run } from "./handler.js";\nnew Command().option("--dry-run").action(run);\n');
        execFileSync("git", ["add", "package.json", "src"], { cwd });
    } });
    try {
        const handler = join(owned.cwd, "src/handler.ts"), companion = join(owned.cwd, "src/handler.test.ts");
        const testBody = [
            'import { Command } from "commander";',
            'import { expect, it } from "vitest";',
            'import { run } from "./handler.js";',
            'it("reproduces the reported mismatch using the parsed Commander flags", () => {',
            '  const options = new Command().option("--dry-run").parse(["--dry-run"], { from: "user" }).opts();',
            '  expect(options.dryRun).toBe(true);',
            '  expect(run(options)).toBeUndefined();',
            '});',
        ].join("\n");
        const input = { command: ["*** Begin Patch", "*** Update File: " + handler, "@@", "-" + before, "+" + after,
            "*** Add File: " + companion, ...testBody.split("\n").map(line => "+" + line), "*** End Patch"].join("\n") };
        const sessionId = "handler-update", id = "handler-and-test";
        const pre = await owned.hook({ sessionId, tool: "apply_patch", input, payload: { tool_use_id: id } });
        owned.assertServed(pre);
        expect(pre.stdout, pre.stderr).not.toContain('"deny"');
        owned.file("src/handler.ts", after + "\n");
        owned.file("src/handler.test.ts", testBody + "\n");
        const post = await owned.hook({ sessionId, event: "PostToolUse", tool: "apply_patch", input,
            payload: { tool_use_id: id, tool_response: "success" } });
        owned.assertServed(post);
        expect(post.stdout).toContain("src/handler.test.ts");
        const evidence = owned.ledger("check-results.jsonl");
        expect(evidence).toContainEqual(expect.objectContaining({ session: sessionId, finding_details: expect.arrayContaining([
            expect.objectContaining({ name: "commander_option_attribute", detail: expect.stringContaining("dryRun") }),
        ]) }));
    } finally { await owned.close(); }
});

it("reports a large authored edit as deferred and retains its independent security-scope receipt", async () => {
    const content = "// one bounded-check fixture\n".padEnd(262145, " ") + "\n";
    const file_path = fixture.file("src/large.ts", content);
    const post = await fixture.hook({ sessionId: "source-budget", event: "PostToolUse", tool: "Edit",
        input: { file_path, old_string: "// first revision", new_string: "// one bounded-check fixture" },
        payload: { tool_use_id: "large-write", tool_response: "success" } });
    fixture.assertServed(post);
    expect(post.stdout).toContain("NOT CHECKED: source_quality");
    const rows = fixture.ledger("check-executions.jsonl");
    expect(rows).toContainEqual(expect.objectContaining({ schema: "source-scan-security.v1", scope: "security-only", tool_use_id: "large-write", paths: [file_path] }));
});

async function reportEdit(name: string) {
    const file_path = fixture.file("src/a.ts", "export const answer = 42;\n");
    const sessionId = `${fixture.sessionPrefix}-${name}`;
    const input = { file_path, old_string: "42", new_string: "43" };
    const pre = await fixture.hook({ sessionId, tool: "Edit", input, payload: { tool_use_id: name } });
    fixture.assertServed(pre);
    expect(pre.stdout, pre.stderr).not.toContain('"deny"');
    fixture.file("src/a.ts", "export const answer = 43;\n");
    const result = await fixture.hook({ sessionId, event: "PostToolUse", tool: "Edit",
        input, payload: { tool_use_id: name, tool_response: "success" } });
    fixture.assertServed(result);
    return result.stdout + result.stderr;
}

it("retains the clean compiler summary in the daemon verdict", async () => {
    await reportEdit("clean"); // Delivers the once-per-session contract guidance.
    const event = createClaudeCodeAdapter().parseHookInput({ cwd: fixture.cwd, session_id: `${fixture.sessionPrefix}-clean`,
        tool_name: "Edit", tool_input: { file_path: join(fixture.cwd, "src/a.ts"), old_string: "42", new_string: "43" }, tool_response: "success" }, "PostToolUse");
    const reply = await callHookDaemon({ socketPath: fixture.paths.framed, method: "hook.post_tool_use", event, timeoutMs: 10_000, env: { INTERLINKED_HOOK_PROTOCOL: "framed" } });
    expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, decision: { decision: "allow", summary: expect.stringContaining("tsc — all clean") } });
});

it("keeps an unrelated pre-existing compiler error advisory and does not report all-clean", async () => {
    fixture.file("src/unrelated.ts", 'export const broken: number = "wrong";\n');
    const introduced = await reportEdit("introduced");
    expect(introduced).toContain("TS2322");
    const output = await reportEdit("existing");
    expect(output).toContain("pre-existing");
    expect(output).not.toContain("all clean");
    expect(output).not.toContain('"decision":"block"');
});
