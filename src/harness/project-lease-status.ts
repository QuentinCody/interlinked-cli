// Read-only diagnostics for this checkout and the host admission lanes it uses.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hasErrorCode } from "./check-engine/tool-errors.js";
import { recordDaemonEvent } from "./daemon-ledger.js";

export interface ProjectLeaseHolder {
    lane: "compiler" | "heavy-process" | "test-scheduler" | "host-capacity" | "foreground-priority";
    pid: number;
    createdAt: string;
    ageMs: number;
    holder: "alive" | "dead" | "unknown";
}
export interface ProjectLeaseStatus {
    holders: ProjectLeaseHolder[];
    unavailable: string[];
}

function holderState(pid: number): ProjectLeaseHolder["holder"] {
    try { process.kill(pid, 0); return "alive"; }
    catch (error) {
        if (hasErrorCode(error, "ESRCH")) return "dead";
        return hasErrorCode(error, "EPERM") ? "alive" : "unknown";
    }
}

/** Bounded before parsing, even if a writer appends during the read. No tokens escape. */
function readOwner(path: string): unknown {
    const fd = openSync(path, "r");
    try {
        const bytes = Buffer.alloc(8193);
        const length = readSync(fd, bytes, 0, bytes.length, 0);
        if (length > 8192) throw new Error("oversized lease metadata");
        return JSON.parse(bytes.subarray(0, length).toString("utf8"));
    } finally { closeSync(fd); }
}

export function readProjectLeaseStatus(projectRoot: string, options: {
    lockRoot?: string; now?: number; isAlive?: (pid: number) => ProjectLeaseHolder["holder"];
} = {}): ProjectLeaseStatus {
    let root = resolve(projectRoot);
    try { root = realpathSync.native(root); } catch (error) { void error; }
    const lockRoot = options.lockRoot ?? join(tmpdir(), "interlinked-project-compiler-leases-v1");
    const status: ProjectLeaseStatus = { holders: [], unavailable: [] };
    // Match test-capacity.ts's test-only namespace without exposing it in status.
    const scope = process.env.INTERLINKED_TEST_CAPACITY_SCOPE;
    const scoped = (key: string): string => scope ? `${key}\0${scope}` : key;
    const lanes = [
        { lane: "compiler", project: root },
        { lane: "heavy-process", project: `interlinked-heavy-process-v1\0${root}` },
        { lane: "test-scheduler", project: `interlinked-test-scheduler-v1\0${root}` },
        { lane: "host-capacity", project: scoped("interlinked-background-host-v1") },
        { lane: "foreground-priority", project: scoped("interlinked-foreground-priority-v1") },
    ] as const;
    for (const { lane, project } of lanes) {
        const digest = createHash("sha256").update(project).digest("hex");
        const lock = join(lockRoot, `${digest}.lock`);
        try {
            const owner = readOwner(join(lock, "owner.json"));
            if (owner === null || typeof owner !== "object" || !("pid" in owner) || !("project" in owner) || !("createdAt" in owner)
                || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
                || owner.project !== project || typeof owner.createdAt !== "string" || !Number.isFinite(Date.parse(owner.createdAt))) {
                status.unavailable.push(`${lane}: invalid lease metadata`); continue;
            }
            status.holders.push({ lane, pid: owner.pid, createdAt: owner.createdAt,
                ageMs: Math.max(0, (options.now ?? Date.now()) - Date.parse(owner.createdAt)),
                holder: (options.isAlive ?? holderState)(owner.pid) });
        } catch (error) {
            // mkdir precedes owner publication. An existing lock without its
            // owner is unavailable, not evidence that the admission lane is free.
            if (!hasErrorCode(error, "ENOENT") || existsSync(lock)) status.unavailable.push(`${lane}: unreadable lease metadata`);
        }
    }
    return status;
}

export function formatProjectLeaseStatus(status: ProjectLeaseStatus): string {
    const rows = status.holders.map(h => `${h.lane}: PID ${h.pid}, ${h.holder}, ${Math.floor(h.ageMs / 1000)}s`);
    rows.push(...status.unavailable);
    return rows.length ? rows.join("; ") : "none";
}

/** Warn once per observed orphan, and forget it after the lock disappears. Never retire locks. */
export function createProjectLeaseSelfCheck(projectRoot: string, log: (message: string) => void,
    read: () => ProjectLeaseStatus = () => readProjectLeaseStatus(projectRoot),
    record: typeof recordDaemonEvent = recordDaemonEvent): () => void {
    let warned = new Set<string>();
    return () => {
        const current = new Set<string>();
        for (const holder of read().holders) {
            if (holder.holder !== "dead") continue;
            const id = `${holder.lane}:${holder.pid}:${holder.createdAt}`;
            current.add(id);
            if (warned.has(id)) continue;
            const detail = `${holder.lane} admission lease outlives holder PID ${holder.pid} (age ${Math.floor(holder.ageMs / 1000)}s); next acquisition can reclaim it`;
            log(`[interlinked:lease-holder] WARNING: ${detail}`);
            record(projectRoot, { at: Date.now(), pid: process.pid, event: "lease-warning", reason: "dead-holder", detail });
        }
        warned = current;
    };
}

export function startProjectLeaseSelfCheck(projectRoot: string, log: (message: string) => void): () => void {
    const check = createProjectLeaseSelfCheck(projectRoot, log);
    check();
    const timer = setInterval(check, 60_000);
    timer.unref();
    return () => clearInterval(timer);
}
