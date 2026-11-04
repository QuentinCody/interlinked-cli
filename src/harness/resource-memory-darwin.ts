import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const SAMPLE_TTL_MS = 500;
let sampledAt = Number.NEGATIVE_INFINITY;
let availableBytes = 0;
let diagnostics: { pressure: string; freeInactiveBytes: number; effectiveAvailableBytes: number } | undefined;

/** Last native sample, including capacity hidden by a critical-pressure veto. No new probe. */
export function darwinMemoryDiagnostics() { return diagnostics ? { ...diagnostics } : undefined; }

/** Free + inactive matches psutil's macOS available-memory estimate.
 * https://github.com/giampaolo/psutil/blob/master/psutil/arch/osx/mem.c
 * Wired/active/compressed pages are not counted as immediately available. */
export function parseDarwinAvailable(vmStat: string, pressure: string): number {
    // Warning pressure is not a zero-byte capacity measurement. Keep the measured
    // headroom so the reserve/RSS governor can admit bounded work. Critical or
    // unknown pressure still vetoes admission and trips the running watchdog.
    if (!["1", "2"].includes(pressure.trim())) return 0;
    const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
    const free = Number(/^Pages free:\s+(\d+)\./m.exec(vmStat)?.[1]);
    const inactive = Number(/^Pages inactive:\s+(\d+)\./m.exec(vmStat)?.[1]);
    const bytes = (free + inactive) * pageSize;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0;
}

/** Critical pressure and unavailable telemetry defer managed work. */
export function readDarwinAvailable(): number {
    const now = performance.now();
    if (now - sampledAt < SAMPLE_TTL_MS) return availableBytes;
    sampledAt = now;
    try {
        const options = { encoding: "utf8" as const, timeout: 2000, maxBuffer: 32 * 1024 };
        const pressure = execFileSync("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], options);
        const vmStat = execFileSync("/usr/bin/vm_stat", [], options);
        availableBytes = parseDarwinAvailable(vmStat, pressure);
        diagnostics = { pressure: pressure.trim(), freeInactiveBytes: parseDarwinAvailable(vmStat, "1"), effectiveAvailableBytes: availableBytes };
    } catch { availableBytes = 0; diagnostics = undefined; }
    return availableBytes;
}
