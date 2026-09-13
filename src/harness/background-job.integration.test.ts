import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

it("retains ownership after its launcher exits and reaps the runner on termination", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "background-supervisor-"));
    const preload = join(cwd, "memory.mjs");
    // Controlled OS readings exercise the 8 GiB policy without allocating gigabytes.
    writeFileSync(preload, 'import os from "node:os"; os.totalmem = () => 8 * 1024 ** 3; process.availableMemory = () => 4 * 1024 ** 3; process.constrainedMemory = () => 0;');
    const evidence = join(cwd, "runner.json");
    const runner = 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({pid: process.pid, workers: process.argv[2], heap: require("node:v8").getHeapStatistics().heap_size_limit})); setInterval(() => {}, 1000);';
    const args = ["--max-old-space-size=128", "--import", import.meta.resolve("tsx"), "--import", preload,
        fileURLToPath(new URL("./background-job-main.ts", import.meta.url)), "integration-job", process.execPath,
        "--eval", runner, "--", evidence, "--maxWorkers=8"];
    const launcher = spawn(process.execPath, ["--eval",
        'const child = require("node:child_process").spawn(process.execPath, JSON.parse(process.argv[1]), {cwd: process.argv[2], detached: true, stdio: "ignore"}); console.log(child.pid); child.unref();',
        JSON.stringify(args), cwd], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    launcher.stdout.on("data", chunk => { output += String(chunk); });
    const launcherExit = new Promise<number | null>(resolve => launcher.once("exit", resolve));
    let supervisor = 0;
    let runnerPid = 0;
    try {
        await expect(launcherExit).resolves.toBe(0);
        supervisor = Number(output.trim());
        await vi.waitFor(() => expect(existsSync(evidence)).toBe(true), { timeout: 10_000 });
        const captured: unknown = JSON.parse(readFileSync(evidence, "utf8"));
        expect(captured).toMatchObject({ workers: "--maxWorkers=1", heap: expect.any(Number), pid: expect.any(Number) });
        // SAFETY: this fixture's JSON shape is asserted immediately above.
        const data = captured as { workers: string; heap: number; pid: number };
        runnerPid = data.pid;
        expect(data.heap).toBeLessThan(900 * 1024 ** 2);
        const duplicate = spawn(process.execPath, args, { cwd, stdio: "ignore" });
        await expect(new Promise<number | null>(resolve => duplicate.once("exit", resolve))).resolves.toBe(1);
        expect(JSON.parse(readFileSync(evidence, "utf8"))).toEqual(data);
        process.kill(supervisor, "SIGTERM");
        await vi.waitFor(() => expect(alive(runnerPid)).toBe(false), { timeout: 10_000 });
        await vi.waitFor(() => expect(alive(supervisor)).toBe(false), { timeout: 10_000 });
    } finally {
        if (supervisor > 0 && alive(supervisor)) process.kill(supervisor, "SIGTERM");
        if (runnerPid > 0 && alive(runnerPid)) process.kill(runnerPid, "SIGKILL");
        rmSync(cwd, { recursive: true, force: true });
    }
}, 30_000);
