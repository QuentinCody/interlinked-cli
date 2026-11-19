import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { hasErrorCode } from "./check-engine/tool-errors.js";

function killOwnedGroupIfPresent(pid: number | undefined): void {
    if (!pid) return;
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if (!hasErrorCode(error, "ESRCH")) throw error; }
}

// test-contract: regression — a supervised verify owns detached analyzer groups through cancellation,
// including a TERM-resistant analyzer and its descendant after the dispatch child exits.
it.each([
    { signal: "SIGINT", immediateExit: false }, { signal: "SIGTERM", immediateExit: false },
    { signal: "SIGINT", immediateExit: true }, { signal: "SIGTERM", immediateExit: true },
] as const)("supervised verify reaps detached analyzers on $signal with immediateExit=$immediateExit", async ({ signal, immediateExit }) => {
    const root = mkdtempSync(join(tmpdir(), "verify-cancel-"));
    const ready = join(root, "pids"), resultPath = join(root, "result.json"), passed = join(root, "passed");
    const capture = `const {spawn}=require("node:child_process");const fs=require("node:fs");
const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});
process.on("SIGTERM",()=>{});fs.writeFileSync(${JSON.stringify(ready)},process.pid+","+child.pid);setInterval(()=>{},1000);`;
    const script = join(root, "owner.mjs");
    writeFileSync(script, `import {writeFileSync} from "node:fs";
import {superviseResourceCli,withResourceCliCancellation} from ${JSON.stringify(new URL("./resource-cli.ts", import.meta.url).href)};
import {currentProcessSignal} from ${JSON.stringify(new URL("./check-engine/process-cancellation.ts", import.meta.url).href)};
import {runProcessAsync} from ${JSON.stringify(new URL("./check-engine/spawn-async.ts", import.meta.url).href)};
await withResourceCliCancellation(process.argv,async()=>{
 if(await superviseResourceCli(process.argv))return;
 ${immediateExit ? 'process.on("SIGTERM",()=>process.exit(75));' : ""}
 const result=await runProcessAsync(process.execPath,["-e",${JSON.stringify(capture)}],{timeout:10000});
 writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(result));
 currentProcessSignal()?.throwIfAborted();writeFileSync(${JSON.stringify(passed)},"passed");
});\n`);
    const owner = spawn(process.execPath, ["--import", new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).pathname, script, "verify"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, INTERLINKED_CAPTURE_ORIGIN: "test" } });
    let stderr = "", capturePid: number | undefined, descendantPid: number | undefined;
    owner.stderr.on("data", chunk => { stderr += String(chunk); });
    const exited = new Promise<number | null>((resolve, reject) => { owner.once("error", reject); owner.once("close", resolve); });
    try {
        await vi.waitFor(() => expect(existsSync(ready), stderr).toBe(true), { timeout: 10_000 });
        [capturePid, descendantPid] = readFileSync(ready, "utf8").split(",").map(Number);
        if (!capturePid || !descendantPid) throw new Error("Fixture did not publish owned process IDs");
        owner.kill(signal);
        expect(await exited, stderr).toBe(75);
        expect(existsSync(passed)).toBe(false);
        expect(stderr).toContain("no verification verdict");
        expect(() => process.kill(capturePid!, 0)).toThrow();
        expect(() => process.kill(descendantPid!, 0)).toThrow();
    } finally {
        if (owner.exitCode === null) owner.kill("SIGKILL");
        killOwnedGroupIfPresent(capturePid);
        rmSync(root, { recursive: true, force: true });
    }
});

// test-contract: regression — OS cancellation must reap a capture's detached process group before CLI exit;
// a successful partial capture must not become a passing verdict after cancellation.
it.each([
    { signal: "SIGINT", args: ["coverage", "check", "--from-index"] },
    { signal: "SIGTERM", args: ["coverage", "check", "--from-index"] },
    { signal: "SIGINT", args: ["metrics", "diagnostics", "--profile", "python"] },
    { signal: "SIGTERM", args: ["metrics", "--cwd", "/selected/root", "diagnostics", "--profile", "python"] },
] as const)("reaps owned capture descendants and returns no verdict on $signal for $args", async ({ signal, args }) => {
    const root = mkdtempSync(join(process.cwd(), "scratch/cli-cancel-"));
    const ready = join(root, "pids"), resultPath = join(root, "result.json"), passed = join(root, "passed");
    const capture = `const {spawn}=require("node:child_process"); const fs=require("node:fs");
const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{stdio:"ignore"});
process.on("SIGTERM",()=>{}); fs.writeFileSync(${JSON.stringify(ready)},process.pid+","+child.pid); setInterval(()=>{},1000);`;
    const script = join(root, "owner.mjs");
    writeFileSync(script, `import {writeFileSync} from "node:fs";
import {withResourceCliCancellation} from ${JSON.stringify(new URL("./resource-cli.ts", import.meta.url).href)};
import {currentProcessSignal} from ${JSON.stringify(new URL("./check-engine/process-cancellation.ts", import.meta.url).href)};
import {runProcessAsync} from ${JSON.stringify(new URL("./check-engine/spawn-async.ts", import.meta.url).href)};
await withResourceCliCancellation([process.execPath,"index.js",...${JSON.stringify(args)}],async()=>{
 const result=await runProcessAsync(process.execPath,["-e",${JSON.stringify(capture)}],{timeout:10000});
 writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(result));
 currentProcessSignal()?.throwIfAborted(); writeFileSync(${JSON.stringify(passed)},"passed");
});\n`);
    const owner = spawn(process.execPath, ["--import", "tsx", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", capturePid: number | undefined, descendantPid: number | undefined;
    owner.stderr.on("data", chunk => { stderr += String(chunk); });
    const exited = new Promise<number | null>((resolve, reject) => { owner.once("error", reject); owner.once("close", resolve); });
    try {
        await vi.waitFor(() => expect(existsSync(ready), stderr).toBe(true), { timeout: 10_000 });
        [capturePid, descendantPid] = readFileSync(ready, "utf8").split(",").map(Number);
        if (!capturePid || !descendantPid) throw new Error("Fixture did not publish owned process IDs");
        owner.kill(signal);
        expect(await exited, stderr).toBe(75);
        expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({ killed: true });
        expect(existsSync(passed)).toBe(false);
        expect(stderr).toContain("no verification verdict");
        expect(() => process.kill(capturePid!, 0)).toThrow();
        expect(() => process.kill(descendantPid!, 0)).toThrow();
    } finally {
        if (owner.exitCode === null) owner.kill("SIGKILL");
        killOwnedGroupIfPresent(capturePid);
        rmSync(root, { recursive: true, force: true });
    }
});
