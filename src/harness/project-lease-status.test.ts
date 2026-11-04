import { tryAcquireForegroundCapacity, CAPACITY_SCOPE_ENV } from "./test-capacity.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createProjectLeaseSelfCheck, formatProjectLeaseStatus, readProjectLeaseStatus } from "./project-lease-status.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function fixture() {
    const lockRoot = mkdtempSync(join(tmpdir(), "il-lease-status-")); roots.push(lockRoot);
    const project = resolve(lockRoot, "project");
    function write(lane: "compiler" | "heavy-process", value: unknown) {
        const key = lane === "compiler" ? project : `interlinked-heavy-process-v1\0${project}`;
        const dir = join(lockRoot, createHash("sha256").update(key).digest("hex") + ".lock");
        mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "owner.json"), JSON.stringify(value));
    }
    return { lockRoot, project, write };
}
it("MUST-FIRE: a dead lease holder logs once, never leaks its token, and does not remove the lease", () => {
    const f = fixture(); const createdAt = "2026-10-28T00:00:00Z";
    f.write("compiler", { pid: 999999, project: f.project, createdAt, token: "fixture-only-token" });
    const read = () => readProjectLeaseStatus(f.project, { lockRoot: f.lockRoot, isAlive: () => "dead", now: Date.parse(createdAt) + 120000 });
    const log = vi.fn(); const record = vi.fn(); const check = createProjectLeaseSelfCheck(f.project, log, read, record);
    check(); check(); expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("outlives holder PID 999999");
    expect(record).toHaveBeenCalledWith(f.project, expect.objectContaining({ event: "lease-warning", reason: "dead-holder" }));
    expect(read().holders).toHaveLength(1);
    expect(JSON.stringify([read(), log.mock.calls, record.mock.calls])).not.toContain("fixture-only-token");
});
it("MUST-NOT-FIRE: live, unknown, absent, and other-project holders are not dead-holder warnings", () => {
    const f = fixture(); const log = vi.fn();
    for (const state of ["alive", "unknown"] as const) {
        f.write("compiler", { pid: process.pid, project: f.project, createdAt: new Date().toISOString() });
        createProjectLeaseSelfCheck(f.project, log, () => readProjectLeaseStatus(f.project, { lockRoot: f.lockRoot, isAlive: () => state }), vi.fn())();
    }
    createProjectLeaseSelfCheck(f.project, log, () => readProjectLeaseStatus(f.project + "-other", { lockRoot: f.lockRoot }), vi.fn())();
    expect(log).not.toHaveBeenCalled();
});
it("EPERM means alive; malformed and oversized metadata are visibly unavailable", () => {
    const f = fixture(); f.write("compiler", { pid: 23, project: f.project, createdAt: new Date().toISOString() });
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect(readProjectLeaseStatus(f.project, { lockRoot: f.lockRoot }).holders[0]?.holder).toBe("alive");
    f.write("compiler", { pid: "bad" });
    f.write("heavy-process", { padding: "x".repeat(9000) });
    const status = readProjectLeaseStatus(f.project, { lockRoot: f.lockRoot });
    expect(status.unavailable).toHaveLength(2); expect(formatProjectLeaseStatus(status)).toContain("unreadable lease metadata");
    expect(formatProjectLeaseStatus(status)).not.toBe("none");
});
it("status names both admission lanes without exposing project-key material", () => {
    const f = fixture(); const createdAt = new Date().toISOString();
    f.write("compiler", { pid: process.pid, project: f.project, createdAt });
    f.write("heavy-process", { pid: process.pid, project: `interlinked-heavy-process-v1\0${f.project}`, createdAt });
    const status = readProjectLeaseStatus(f.project, { lockRoot: f.lockRoot });
    expect(status.holders.map(h => h.lane)).toEqual(["compiler", "heavy-process"]);
    expect(formatProjectLeaseStatus(status)).toContain(`heavy-process: PID ${process.pid}, alive`);
});

it("MUST-NOT-FIRE: unpublished owner metadata is unavailable, not an orphan or a free lane", () => {
    const f = fixture();
    const lock = join(f.lockRoot, createHash("sha256").update(f.project).digest("hex") + ".lock");
    mkdirSync(lock);
    const read = () => readProjectLeaseStatus(f.project, { lockRoot: f.lockRoot });
    const log = vi.fn();
    createProjectLeaseSelfCheck(f.project, log, read, vi.fn())();
    expect(log).not.toHaveBeenCalled();
    expect(read()).toEqual({ holders: [], unavailable: ["compiler: unreadable lease metadata"] });
    expect(formatProjectLeaseStatus(read())).not.toBe("none");
});


it("reports the actual host admission holder using the capacity protocol's isolated namespace", () => {
    const f = fixture(); vi.stubEnv(CAPACITY_SCOPE_ENV, `b11-${randomUUID()}`);
    const lease = tryAcquireForegroundCapacity(); expect(lease).not.toBeNull();
    try {
        expect(readProjectLeaseStatus(f.project).holders).toContainEqual(expect.objectContaining({ lane: "host-capacity", pid: process.pid, holder: "alive" }));
    } finally { lease?.release(); }
    expect(readProjectLeaseStatus(f.project).holders).not.toContainEqual(expect.objectContaining({ lane: "host-capacity" }));
});

it("MUST-FIRE: an orphaned host admission slot is visible even without a project lease", () => {
    const f = fixture(); vi.stubEnv(CAPACITY_SCOPE_ENV, "");
    const project = "interlinked-background-host-v1";
    const dir = join(f.lockRoot, createHash("sha256").update(project).digest("hex") + ".lock");
    mkdirSync(dir); writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: 999999, project, createdAt: "2026-10-28T00:00:00Z" }));
    const read = () => readProjectLeaseStatus(f.project, { lockRoot: f.lockRoot, isAlive: () => "dead" });
    const log = vi.fn(); createProjectLeaseSelfCheck(f.project, log, read, vi.fn())();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("host-capacity admission lease outlives holder PID 999999"));
});
