import { execFile } from "node:child_process";
import type { ResourceBudget } from "./resource-budget.js";
import { readResourceMemory } from "./resource-memory.js";

/** Count descendants and process-group members, including reparented workers. */
export function processTreeRss(table: string, root: number): number {
    const rows = table.trim().split("\n").filter(Boolean).map(line => line.trim().split(/\s+/).map(Number));
    if (!rows.length || rows.some(row => row.length !== 4 || row.some(value => !Number.isFinite(value) || value < 0))) throw new Error("Invalid process memory sample");
    const owners = new Set([root]);
    let previous = -1;
    while (previous !== owners.size) {
        previous = owners.size;
        for (const [pid, parent, group] of rows) {
            if (pid !== undefined && parent !== undefined && (owners.has(parent) || group === root)) owners.add(pid);
        }
    }
    return rows.reduce((sum, [pid, , , rss]) => sum + (pid !== undefined && rss !== undefined && owners.has(pid) ? rss * 1024 : 0), 0);
}

async function sampleRss(pid: number): Promise<number> {
    const table = await new Promise<string>((resolve, reject) => {
        execFile("ps", ["-axo", "pid=,ppid=,pgid=,rss="], { encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 ** 2 },
            (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    return processTreeRss(table, pid);
}

async function resourceIssue(pid: number, budget: ResourceBudget): Promise<string | null> {
    const available = readResourceMemory().availableBytes;
    if (!Number.isFinite(available) || available < budget.reserveBytes) return "Host memory reserve exhausted or unavailable";
    return await sampleRss(pid) > budget.maxRssBytes ? "Runner process tree exceeded its memory budget" : null;
}

/** Single in-flight sample; failed telemetry interrupts instead of certifying capacity. */
export function watchResources(pid: number, budget: ResourceBudget, stop: (reason: string) => void): () => void {
    let closed = false, sampling = false;
    const report = (reason: string | null): void => { if (!closed && reason) stop(reason); };
    const sample = async (): Promise<void> => {
        if (closed || sampling) return;
        sampling = true;
        try { report(await resourceIssue(pid, budget)); }
        catch { report("Process memory telemetry unavailable"); }
        finally { sampling = false; }
    };
    const timer = setInterval(() => { void sample(); }, 500);
    void sample();
    return () => { closed = true; clearInterval(timer); };
}
