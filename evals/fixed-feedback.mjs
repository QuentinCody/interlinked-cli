#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

export function denied(result) {
    const native = JSON.parse(result.stdout || "{}");
    return result.code === 2 || native.decision === "block" || native.hookSpecificOutput?.permissionDecision === "deny";
}

function flat(n) {
    const branches = Array.from({ length: n }, (_, i) => `    if (value === ${i}) return ${i};`).join("\n");
    return `export function score(value: number): number {\n${branches}\n    return -1;\n}\n`;
}

async function measuredHook(fixture, call) {
    const start = performance.now(), result = await fixture.hook(call);
    if (call.cold) assert.equal(result.fellBack, true);
    else fixture.assertServed(result);
    return { milliseconds: performance.now() - start, bytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), denied: denied(result), ...result };
}

async function cleanEdits(fixture) {
    const file = fixture.file("src/clean.ts", "export const value = 1;\n"), results = [];
    const sessionId = `${fixture.sessionPrefix}-clean`;
    for (let i = 0; i < 10; i++) {
        const input = { file_path: file, old_string: `value = ${i + 1}`, new_string: `value = ${i + 2}` };
        const payload = { tool_use_id: `clean-${i}`, tool_response: "success" };
        const pre = await measuredHook(fixture, { tool: "Edit", input, sessionId, payload });
        if (!pre.denied) fixture.file("src/clean.ts", `export const value = ${i + 2};\n`);
        const post = await measuredHook(fixture, { tool: "Edit", input, sessionId, payload, event: "PostToolUse" });
        results.push({ pre, post });
    }
    return results;
}

async function policyControls(fixture) {
    const file = fixture.file("src/score.ts", flat(10));
    const growth = await measuredHook(fixture, { tool: "Write", input: { file_path: file, content: flat(15) } });
    const cap = await measuredHook(fixture, { tool: "Write", input: { file_path: file, content: flat(31) } });
    const probe = fixture.file("scratch/probe.mjs", "// probe\n");
    const tempWrite = 'import { readFileSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; const text = readFileSync("src/score.ts", "utf8"); writeFileSync(join(tmpdir(), "fixture.ts"), text);';
    const fixtureWrite = await measuredHook(fixture, { tool: "Write", input: { file_path: probe, content: tempWrite } });
    const repoWrite = await measuredHook(fixture, { tool: "Write", input: { file_path: probe, content: 'writeFileSync("src/score.ts", "payload");' } });
    const dangerous = await measuredHook(fixture, { tool: "Bash", input: { command: "git reset --hard" } });
    const coldRead = await measuredHook(fixture, { tool: "Read", input: { file_path: file }, cold: true });
    assert.equal(cap.denied, true); assert.equal(repoWrite.denied, true); assert.equal(dangerous.denied, true);
    return { growth, cap, fixtureWrite, repoWrite, dangerous, coldRead };
}

async function measure(buildRoot, output) {
    const { createFixture } = await tsImport(new URL("../src/e2e/fixture.ts", import.meta.url).href, import.meta.url);
    const fixture = await createFixture({ buildRoot: path.resolve(buildRoot), rules: { per_edit_coverage: { enabled: false } } });
    fs.mkdirSync(output, { recursive: true });
    try {
        const clean = await cleanEdits(fixture), controls = await policyControls(fixture);
        for (const name of ["check-results", "check-executions", "hook-transport"]) {
            const file = path.join(fixture.dataDir, `${name}.jsonl`);
            if (fs.existsSync(file)) fs.copyFileSync(file, path.join(output, `${name}.jsonl`));
        }
        const result = { buildRoot, daemon_pid: fixture.pid, clean, controls };
        fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
        process.stdout.write(JSON.stringify({ buildRoot, growthDenied: controls.growth.denied, fixtureWriteDenied: controls.fixtureWrite.denied, cleanBytes: clean.reduce((sum, row) => sum + row.pre.bytes + row.post.bytes, 0) }) + "\n");
    } finally { await fixture.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [build, output] = process.argv.slice(2);
    if (!build || !output) throw new Error("Usage: node evals/fixed-feedback.mjs <package-root> <evidence-dir>");
    measure(build, path.resolve(output)).catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
