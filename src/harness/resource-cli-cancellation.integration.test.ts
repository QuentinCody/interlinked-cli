import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// test-contract: regression — OS cancellation must reap a capture's detached process group before CLI exit;
// a successful partial capture must not become a passing verdict after cancellation.
it.each(["SIGINT", "SIGTERM"] as const)("reaps owned capture descendants and returns no verdict on %s", async signal => {
    const root = mkdtempSync(join(tmpdir(), "cli-cancel-"));
    const ready = join(root, "pids"), resultPath = join(root, "result.json"), passed = join(root, "passed");
    const capture = `const {spawn}=require("node:child_process"); const fs=require("node:fs");
const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{stdio:"ignore"});
process.on("SIGTERM",()=>{}); fs.writeFileSync(${JSON.stringify(ready)},process.pid+","+child.pid); setInterval(()=>{},1000);`;
    const script = join(root, "owner.mjs");
    writeFileSync(script, `import {writeFileSync} from "node:fs";
import {withResourceCliCancellation} from ${JSON.stringify(new URL("./resource-cli.ts", import.meta.url).href)};
import {currentProcessSignal} from ${JSON.stringify(new URL("./check-engine/process-cancellation.ts", import.meta.url).href)};
import {runProcessAsync} from ${JSON.stringify(new URL("./check-engine/spawn-async.ts", import.meta.url).href)};
await withResourceCliCancellation([process.execPath,"index.js","coverage","check","--from-index"],async()=>{
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
        if (capturePid) { try { process.kill(-capturePid, "SIGKILL"); } catch { /* Owned group already reaped. */ } }
        rmSync(root, { recursive: true, force: true });
    }
});
