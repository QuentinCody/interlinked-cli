import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_QUALITY_CHECKS } from "../harness/rules/default-config-quality-checks.js";
import { tscSchedulerStorePath } from "../harness/server/tsc-scheduler-store.js";
import { createFixture, type E2eFixture, PROJECT_ROOT } from "./fixture.js";

let fixture: E2eFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

async function setup() {
    const quality_checks = Object.fromEntries(Object.entries(DEFAULT_QUALITY_CHECKS).map(([name, config]) =>
        [name, { ...config, enabled: name === "typescript", ...(name === "typescript" ? { scheduler: { enabled: true, min_recall_point: 0.8 } } : {}) }]));
    fixture = await createFixture({ rules: { quality_checks, per_edit_coverage: { enabled: false },
        project_wide_checks: { enabled: false }, structural_checks: { test_first_mode: "warn" } }, prepare(cwd) {
        symlinkSync(join(PROJECT_ROOT, "node_modules"), join(cwd, "node_modules"));
        writeFileSync(join(cwd, "package.json"), '{"type":"module"}');
        writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true,
            target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }));
    } });
    return fixture;
}

async function patch(owned: E2eFixture, sessionId: string, before: string, after: string) {
    const file_path = join(owned.cwd, "src/a.ts");
    const input = { command: `*** Begin Patch\n*** Update File: ${file_path}\n@@\n-${before.trim()}\n+${after.trim()}\n*** End Patch` };
    const id = `${sessionId}-${after.length}`;
    const pre = await owned.hook({ sessionId, tool: "apply_patch", input, payload: { tool_use_id: id } });
    owned.assertServed(pre);
    expect(pre.stdout, pre.stderr).not.toContain('"deny"');
    owned.file("src/a.ts", after);
    const post = await owned.hook({ sessionId, event: "PostToolUse", tool: "apply_patch", input,
        payload: { tool_use_id: id, tool_response: "success" } });
    owned.assertServed(post);
    return post;
}

it("retains deferred compiler errors across repeated Stop and daemon replacement, then clears after repair", async () => {
    const owned = await setup();
    const sessionId = `${owned.sessionPrefix}-scheduler`;
    const good = "export const answer: number = 1;\n";
    owned.file("src/a.ts", good);
    // Establish a real compiler baseline with the import override.
    const imported = 'import type {} from "./b.js";\n' + good;
    owned.file("src/b.ts", "export {};\n");
    await patch(owned, sessionId, good, imported);
    await patch(owned, sessionId, imported, good);
    const broken = 'export const answer: number = "wrong";\n';
    await patch(owned, sessionId, good, broken);
    const store = tscSchedulerStorePath(owned.cwd, { agent_source: "claude", session_id: sessionId });
    expect(existsSync(store)).toBe(true);
    expect(JSON.parse(readFileSync(store, "utf8")).entries.length).toBeGreaterThan(0);
    for (let attempt = 0; attempt < 2; attempt++) {
        const stop = await owned.hook({ sessionId, event: "Stop" });
        owned.assertServed(stop);
        expect(stop.stdout).toContain('"decision":"block"');
        expect(stop.stdout + stop.stderr).toContain("TS2322");
        if (attempt === 0) await owned.restartDaemon();
    }
    await patch(owned, sessionId, broken, good);
    const fixed = await owned.hook({ sessionId, event: "Stop" });
    owned.assertServed(fixed);
    expect(fixed.stdout).not.toContain('"decision":"block"');
    expect(JSON.parse(readFileSync(store, "utf8")).entries).toEqual([]);
});

it("keeps corrupt scheduler state blocking after restart and does not affect another session", async () => {
    const owned = await setup();
    const sessionId = `${owned.sessionPrefix}-corrupt`;
    const good = "export const answer = 1;\n";
    owned.file("src/a.ts", good);
    await patch(owned, sessionId, good, "export const answer = 2;\n");
    const store = tscSchedulerStorePath(owned.cwd, { agent_source: "claude", session_id: sessionId });
    expect(existsSync(store)).toBe(true);
    writeFileSync(store, "{invalid");
    for (let attempt = 0; attempt < 2; attempt++) {
        const stop = await owned.hook({ sessionId, event: "Stop" });
        owned.assertServed(stop);
        expect(stop.stdout).toContain('"decision":"block"');
        expect(stop.stdout + stop.stderr).toContain("deferred set is unreadable");
        if (attempt === 0) await owned.restartDaemon();
    }
    const unrelated = await owned.hook({ sessionId: `${owned.sessionPrefix}-other`, event: "Stop" });
    owned.assertServed(unrelated);
    expect(unrelated.stdout + unrelated.stderr).not.toContain("deferred set is unreadable");
});
