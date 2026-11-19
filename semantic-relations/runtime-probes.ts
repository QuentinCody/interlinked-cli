import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const suffix = process.argv[2] ?? "before";
if (suffix === "--help") {
    console.log("Usage: runtime-probes.ts LABEL [RUN_DIR]\nRuns local child-process and supervisor probes. A custom RUN_DIR receives probes/ and study/runtime-probes-LABEL.json.");
    process.exit(0);
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(suffix)) throw new Error("Invalid probe label");
const root = resolve(process.cwd());
const runDir = process.argv[3] ? resolve(process.argv[3]) : undefined;
const study = runDir ? join(runDir, "study") : join(root, "semantic-relations/studies/2026-10-27-runtime");
const probeRoot = join(runDir ?? join(root, "scratch/semantic-relations-runtime"), "probes");
const reportPath = join(study, `runtime-probes-${suffix}.json`);
if (existsSync(reportPath)) throw new Error(`Probe report already exists: ${reportPath}`);
mkdirSync(study, { recursive: true });
mkdirSync(probeRoot, { recursive: true });
const directory = mkdtempSync(join(probeRoot, `${suffix}-`));
async function run(name: string, source: string) {
    const ledger = join(directory, `${name}-${suffix}-ledger.jsonl`);
    const runner = join(directory, `${name}-${suffix}-runner.mjs`);
    writeFileSync(runner, source);
    const start = Date.now();
    return await new Promise<Record<string, unknown>>(resolve => {
        const child = spawn(process.execPath, ["--import", "tsx", runner], { cwd: root, env: { ...process.env, INTERLINKED_STAGES_LEDGER: ledger }, stdio: ["ignore", "pipe", "pipe"], detached: true });
        let stdout = "", stderr = "", timedOut = false;
        child.stdout.on("data", b => { stdout += String(b); });
        child.stderr.on("data", b => { stderr += String(b); });
        const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGTERM"); } catch {} }, 15_000);
        child.on("close", code => {
            clearTimeout(timer);
            resolve({ name, code, timedOut, durationMs: Date.now() - start, stdout, stderr, ledger: existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [] });
        });
    });
}
const resource = pathToFileURL(join(root, "src/harness/resource-command.ts")).href;
const supervisor = pathToFileURL(join(root, "src/harness/resource-cli.ts")).href;
const results = [];
for (const [name, executable, args] of [
    ["success", process.execPath, ["-e", "process.exit(0)"]],
    ["failure", process.execPath, ["-e", "process.exit(3)"]],
    ["own-75", process.execPath, ["-e", "process.exit(75)"]],
    ["own-127", process.execPath, ["-e", "process.exit(127)"]],
    ["missing-target", join(directory, "does-not-exist"), []],
    ["external-signal", process.execPath, ["-e", "process.kill(process.pid,'SIGTERM')"]],
] as const) {
    results.push(await run(name, `import {runResourceCommand,describeResourceCommandOutcome} from ${JSON.stringify(resource)}; const outcome=await runResourceCommand(${JSON.stringify(executable)},${JSON.stringify(args)},new AbortController().signal,'light'); console.log(JSON.stringify({outcome,report:describeResourceCommandOutcome(outcome)}));`));
}
for (const [name, text] of [["supervised-external-signal", "process.kill(process.pid, 'SIGTERM');"], ["supervised-own-75", "process.exit(75);"]] as const) {
    const fixture = join(directory, `${name}.mjs`); writeFileSync(fixture, text);
    results.push(await run(name, `import {superviseResourceCli} from ${JSON.stringify(supervisor)}; console.log(JSON.stringify({supervised:await superviseResourceCli([process.execPath,${JSON.stringify(fixture)},'verify','--timeout','3000']),exitCode:process.exitCode}));`));
}
writeFileSync(reportPath, `${JSON.stringify({ node: process.version, results }, null, 2)}\n`, { flag: "wx" });
for (const r of results) console.log(JSON.stringify({ name: r.name, code: r.code, timedOut: r.timedOut, stdout: r.stdout, stderr: r.stderr, ledgerRows: (r.ledger as unknown[]).length }));
