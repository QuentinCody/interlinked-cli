import { appendFileSync, existsSync, opendirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanFileLines } from "../../lib/bounded-file-io.js";

export const MUTATION_RETENTION = { bytes: 64 * 1024 * 1024, reports: 128, ageMs: 30 * 86400_000, logBytes: 1024 * 1024 };
export type MutationRetention = typeof MUTATION_RETENTION;

/** Called under the runs.jsonl mutation lock; only content-addressed sidecars are eligible. */
export function pruneMutationReports(directory: string, current: string, limits: MutationRetention, now: number): number {
    const entries: Array<{ path: string; size: number; time: number }> = [];
    const dir = opendirSync(directory);
    try {
        let count = 0;
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
            if (++count > 4096) throw new Error("mutation evidence directory exceeds census budget");
            if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
            const path = join(directory, entry.name);
            const info = statSync(path);
            entries.push({ path, size: info.size, time: info.mtimeMs });
        }
    } finally { dir.closeSync(); }
    entries.sort((a, b) => a.time - b.time || a.path.localeCompare(b.path));
    let bytes = entries.reduce((n, entry) => n + entry.size, 0);
    let count = entries.length;
    let removed = 0;
    for (const entry of entries) {
        if (entry.path === current) continue;
        if (count <= limits.reports && bytes <= limits.bytes && now - entry.time <= limits.ageMs) continue;
        unlinkSync(entry.path);
        count--; bytes -= entry.size; removed++;
    }
    return removed;
}

function retainedLogTail(path: string, budget: number): string {
    const size = statSync(path).size;
    if (size <= budget) return readFileSync(path, "utf8");
    const start = size - budget;
    const lines: string[] = [];
    scanFileLines(path, line => {
        if (line.start > start && line.complete && !line.oversized && line.text) lines.push(line.text);
    }, { startOffset: start, endExclusive: size, maxCapturedLineBytes: budget });
    return lines.join("\n") + (lines.length ? "\n" : "");
}

/** Two bounded generations. Retention is diagnostic, not an indefinite audit archive. */
export function appendMutationRun(path: string, row: string, budget: number): void {
    if (Buffer.byteLength(row) > budget) throw new Error("mutation run metadata exceeds retention budget");
    if (existsSync(path) && statSync(path).size + Buffer.byteLength(row) > budget) {
        const temporary = path + ".rotation.tmp";
        writeFileSync(temporary, retainedLogTail(path, budget), { mode: 0o600 });
        renameSync(temporary, path + ".previous");
        writeFileSync(path, "", { mode: 0o600 });
    }
    appendFileSync(path, row, { mode: 0o600 });
}
