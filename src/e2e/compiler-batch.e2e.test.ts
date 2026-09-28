import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createFixture, type E2eFixture, PROJECT_ROOT } from "./fixture.js";

let fixture: E2eFixture;
beforeAll(async () => {
    fixture = await createFixture({ rules: { per_edit_coverage: { enabled: false },
        structural_checks: { test_first_mode: "warn" }, project_wide_checks: { enabled: false } } });
    symlinkSync(join(PROJECT_ROOT, "node_modules"), join(fixture.cwd, "node_modules"));
    fixture.file("package.json", '{"type":"module"}');
    fixture.file("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true,
        target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }));
    fixture.file("src/target.ts", 'export interface E2eTarget { revision: string; }\n');
});
afterAll(async () => { await fixture?.close(); });

async function edit(sessionId: string, source: string, next: string, id: string) {
    const file_path = join(fixture.cwd, "src/a.ts");
    const input = { file_path, old_string: source, new_string: next };
    const pre = await fixture.hook({ sessionId, tool: "Edit", input, payload: { tool_use_id: id } });
    fixture.assertServed(pre);
    expect(pre.stdout, pre.stderr).not.toContain('"deny"');
    fixture.file("src/a.ts", next);
    const post = await fixture.hook({ sessionId, event: "PostToolUse", tool: "Edit", input,
        payload: { tool_use_id: id, tool_response: "success" } });
    fixture.assertServed(post);
    return post.stdout + post.stderr;
}

function relatedEdits(): string[] {
    return [
        'export const answer = "HEAD";\nexport interface Options { revision: string; }\n',
        'export const answer = targetOf({ revision: "HEAD" });\nexport interface Options { revision: string; }\n',
        'export const answer = targetOf({ revision: "HEAD" });\nexport interface Options { revision: string; }\nfunction targetOf(options: E2eTarget): string { return options.revision; }\n',
        'import type { E2eTarget } from "./target.js";\nexport const answer = targetOf({ revision: "HEAD" });\nexport interface Options { revision: string; }\nfunction targetOf(options: E2eTarget): string { return options.revision; }\n',
    ];
}

function compilerRecords(sessionId: string): unknown[] {
    const rows = readFileSync(join(fixture.dataDir, "check-results.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    return rows.filter(row => row.session === sessionId && row.timing?.tools?.some((tool: { tool: string }) => tool.tool === "tsc"));
}

it("checks the completed four-edit batch, suppresses intermediate missing names, and still reports a real final error", async () => {
    const sessionId = `${fixture.sessionPrefix}-related-edits`;
    let source = 'export const answer = "HEAD";\n';
    fixture.file("src/a.ts", source);
    const armed = await fixture.hook({ sessionId, event: "PostToolBatch", payload: { tool_calls: [] } });
    fixture.assertServed(armed);
    const stages = relatedEdits();
    for (const [index, next] of stages.entries()) {
        const output = await edit(sessionId, source, next, `related-${index}`);
        expect(output).not.toContain("TS2304");
        source = next;
    }
    const complete = await fixture.hook({ sessionId, event: "PostToolBatch", payload: { tool_calls: [] } });
    fixture.assertServed(complete);
    expect(complete.stdout + complete.stderr).not.toContain("TS2304");
    const compilerRuns = compilerRecords(sessionId);
    expect(compilerRuns).toHaveLength(1);
    await edit(sessionId, source, source + '\nexport const broken: number = "wrong";\n', "final-error");
    const failed = await fixture.hook({ sessionId, event: "PostToolBatch", payload: { tool_calls: [] } });
    expect(failed.stdout + failed.stderr).toContain("TS2322");
    expect(failed.stdout).not.toContain('"continue":false');
    const stop = await fixture.hook({ sessionId, event: "Stop" });
    expect(stop.stdout).toContain('"decision":"block"');
    expect(stop.stdout + stop.stderr).toContain("TS2322");
    const unsafe = await fixture.hook({ sessionId, tool: "Edit", input: { file_path: join(fixture.cwd, "src/a.ts"),
        old_string: "return options.revision;", new_string: "return eval(options.revision);" } });
    expect(unsafe.stdout).toContain('"deny"');
    expect(unsafe.stdout + unsafe.stderr).toContain("eval_usage");
    console.info(JSON.stringify({ edits: stages.length, compilerCheckRecords: compilerRuns.length,
        intermediateMissingNameErrors: 0, finalErrorReported: true, stopBlocked: true, unsafeEditBlocked: true }));
});

it("retains the ordinary per-edit compiler path without a demonstrated batch hook", async () => {
    const sessionId = `${fixture.sessionPrefix}-per-edit-control`;
    let source = 'export const answer = "HEAD";\n';
    fixture.file("src/a.ts", source);
    const outputs: string[] = [];
    for (const [index, next] of relatedEdits().entries()) {
        outputs.push(await edit(sessionId, source, next, `control-${index}`));
        source = next;
    }
    expect(compilerRecords(sessionId)).toHaveLength(4);
    const errors = outputs.filter(output => output.includes("TS2304")).length;
    expect(errors).toBe(2);
    console.info(JSON.stringify({ control: "same build, no demonstrated batch hook", edits: 4,
        compilerCheckRecords: compilerRecords(sessionId).length, intermediateMissingNameErrors: errors }));
});
