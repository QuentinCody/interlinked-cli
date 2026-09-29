import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tryAcquireCrossProcessCompilerLease } from "./project-compiler-lock.js";
import { CAPACITY_SCOPE_ENV, acquireTestCapacity, foregroundWantsCapacity, tryAcquireForegroundCapacity } from "./test-capacity.js";

// Contend on a PRIVATE host slot: the run hosting this file may hold the real one (and would grant nested leases).
beforeEach(() => { vi.stubEnv(CAPACITY_SCOPE_ENV, randomUUID()); });
afterEach(() => { vi.unstubAllEnvs(); });

it("makes background work yield admission to a waiting foreground request", async () => {
    const controller = new AbortController();
    const background = await acquireTestCapacity("background", Date.now() + 2000, controller.signal);
    expect(background).not.toBeNull();
    const foreground = acquireTestCapacity("foreground", Date.now() + 2000, controller.signal);
    try {
        await vi.waitFor(() => expect(foregroundWantsCapacity()).toBe(true));
        expect(tryAcquireForegroundCapacity()).toBeNull();
    } finally { background?.release(); }
    const admitted = await foreground;
    expect(admitted).not.toBeNull();
    admitted?.release();
});

/** A separate process tries the lease once with the given ancestors and reports whether it got one; a granted lease is released before exit. */
function childTriesLease(key: string, ancestors: string): "granted" | "denied" {
    const script = `import { tryAcquireCrossProcessCompilerLease } from ${JSON.stringify(pathToFileURL(resolve("src/harness/project-compiler-lock.ts")).href)};
const lease = tryAcquireCrossProcessCompilerLease(process.argv.at(-1));
if (lease) lease.release();
process.stdout.write(lease ? "granted" : "denied");`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, key], { encoding: "utf8", env: { ...process.env, INTERLINKED_LEASE_ANCESTORS: ancestors } });
    if (result.status !== 0) throw new Error(`child failed: ${result.stderr}`);
    return result.stdout === "granted" ? "granted" : "denied";
}

// test-contract: invariant — a CHILD process running under a live lease holder gets a nested grant instead of deadlocking on its host; releasing the grant never releases the holder's lease, the holder's own process gets no grant, and an unrelated pid in the list earns nothing
it("grants a nested lease to a descendant of the live holder and keeps the holder's lease intact", () => {
    const key = `interlinked-nested-lease-test-${randomUUID()}`; // no NUL: the key travels to the child as argv
    const holder = tryAcquireCrossProcessCompilerLease(key);
    expect(holder).not.toBeNull();
    try {
        expect(childTriesLease(key, "")).toBe("denied");
        expect(childTriesLease(key, `${process.pid + 1_000_000},${process.pid}`)).toBe("granted");
        // The holder still holds it after the child's nested release.
        expect(childTriesLease(key, "")).toBe("denied");
        expect(childTriesLease(key, String(process.pid + 1_000_000))).toBe("denied");
        // The holder's OWN process never gets a nested grant on its own lock.
        vi.stubEnv("INTERLINKED_LEASE_ANCESTORS", String(process.pid));
        expect(tryAcquireCrossProcessCompilerLease(key)).toBeNull();
    } finally {
        holder?.release();
    }
    expect(childTriesLease(key, "")).toBe("granted");
}, 60_000);

it("does not acquire capacity after cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(acquireTestCapacity("background", Date.now() + 1000, controller.signal)).resolves.toBeNull();
});
