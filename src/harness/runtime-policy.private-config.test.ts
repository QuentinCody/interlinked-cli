import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import { localAgentToolDecision } from "./runtime-policy.js";

afterEach(() => vi.unstubAllEnvs());
it.each([
    { command: "cat .interlinked/config.local.json" },
    { command: "echo ready && cat .interlinked/config.local.json" },
    { cmd: "cat '/repo with spaces/.interlinked/config.local.json'" },
    { file_path: "/repo/.interlinked/config.local.json" },
])("MUST-FIRE: an agent private-config request is blocked: %j", tool_input => {
    vi.stubEnv("INTERLINKED_RUNTIME_POLICY", "local-restricted");
    expect(localAgentToolDecision({ hook_event: "PreToolUse", tool_input })?.decision).toBe("block");
});
it("MUST-NOT-FIRE: ordinary files, post-tool events, and a disabled policy", () => {
    vi.stubEnv("INTERLINKED_RUNTIME_POLICY", "local-restricted");
    expect(localAgentToolDecision({ hook_event: "PreToolUse", tool_input: { command: "cat .interlinked/guard-rules.json" } })).toBeNull();
    expect(localAgentToolDecision({ hook_event: "PreToolUse", tool_input: { command: "echo .interlinked/config.local.json" } })).toBeNull();
    expect(localAgentToolDecision({ hook_event: "PreToolUse", tool_input: { command: "cat README.md && echo .interlinked/config.local.json" } })).toBeNull();
    expect(localAgentToolDecision({ hook_event: "PostToolUse", tool_input: { file_path: "/repo/.interlinked/config.local.json" } })).toBeNull();
    vi.stubEnv("INTERLINKED_RUNTIME_POLICY", "");
    expect(localAgentToolDecision({ hook_event: "PreToolUse", tool_input: { command: "cat .interlinked/config.local.json" } })).toBeNull();
});
it("resolves literal paths in the agent's cwd, including cat config.local.json inside .interlinked", () => {
    vi.stubEnv("INTERLINKED_RUNTIME_POLICY", "local-restricted");
    const event = { hook_event: "PreToolUse", tool_input: { command: "cat config.local.json" } };
    expect(localAgentToolDecision({ ...event, cwd: "/other/project/.interlinked" })?.decision).toBe("block");
    expect(localAgentToolDecision({ ...event, cwd: "/other/project" })).toBeNull();
});
it("MUST-NOT-FIRE: the bundled daemon reconciles and drains while reading its private configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "il-private-drain-"));
    try {
        const imports = ["runtime-policy", "hook-filesystem-watch", "hook-coverage-control"].map(name => JSON.stringify(resolve(`src/harness/${name}.ts`)));
        const source = `import {ensureLocalRuntimePolicy} from ${imports[0]};
import {startHookFilesystemWatch} from ${imports[1]}; import {controlHookCoverage} from ${imports[2]};
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
ensureLocalRuntimePolicy(); const root=${JSON.stringify(root)};
mkdirSync(join(root,'.interlinked')); const config=join(root,'.interlinked/config.local.json');
writeFileSync(config,'{}'); const owned=join(root,'owned.ts'); writeFileSync(owned,'before');
const watcher=startHookFilesystemWatch({root,reservations:()=>[config,owned],checker:async entries=>{
    JSON.parse(readFileSync(config,'utf8'));
    return new Map(entries.map(e=>[e.id,{checks:['fixture_config_read'],findings:[],unavailable:[]}]));
}});
try { writeFileSync(owned,'after'); const start=controlHookCoverage(watcher,{operation:'verify',detail:'progress'});
    const deadline=Date.now()+3000; while(watcher.verification.isRunning()&&Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
    const final=controlHookCoverage(watcher,{operation:'status',detail:'verification'});
    process.stdout.write(JSON.stringify({readiness:final.readiness,checked:final.verification?.checked,unmeasured:final.verification?.unmeasured,pending:final.pending?.length,started:start.changed}));
} finally { watcher.stop(); }`;
        const bundled = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
        const path = join(root, "drain.mjs"); writeFileSync(path, bundled.outputFiles[0]!.text);
        const out = execFileSync(process.execPath, [path], { encoding: "utf8", timeout: 10_000, env: { ...process.env, INTERLINKED_RUNTIME_POLICY: "local-restricted" } });
        expect(JSON.parse(out), out).toMatchObject({ readiness: "ready", unmeasured: [], pending: 0, started: true });
        expect(JSON.parse(out).checked).toBeGreaterThanOrEqual(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
