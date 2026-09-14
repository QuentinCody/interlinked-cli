import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const SAMPLE_TTL_MS = 500;
let sampledAt = Number.NEGATIVE_INFINITY;
let availableBytes = 0;

/** Free + inactive matches psutil's macOS available-memory estimate.
 * https://github.com/giampaolo/psutil/blob/master/psutil/arch/osx/mem.c
 * Wired/active/compressed pages are not counted as immediately available. */
export function parseDarwinAvailable(vmStat: string, pressure: string): number {
    if (pressure.trim() !== "1") return 0;
    const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
    const free = Number(/^Pages free:\s+(\d+)\./m.exec(vmStat)?.[1]);
    const inactive = Number(/^Pages inactive:\s+(\d+)\./m.exec(vmStat)?.[1]);
    const bytes = (free + inactive) * pageSize;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0;
}

/** Warning/critical pressure and unavailable telemetry defer managed work. */
export function readDarwinAvailable(): number {
    const now = performance.now();
    if (now - sampledAt < SAMPLE_TTL_MS) return availableBytes;
    sampledAt = now;
    try {
        const options = { encoding: "utf8" as const, timeout: 2000, maxBuffer: 32 * 1024 };
        const pressure = execFileSync("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], options);
        availableBytes = parseDarwinAvailable(execFileSync("/usr/bin/vm_stat", [], options), pressure);
    } catch { availableBytes = 0; }
    return availableBytes;
}
