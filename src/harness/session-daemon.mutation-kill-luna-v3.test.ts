import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    claimSessionPid,
    startSessionDaemon,
} from "./session-daemon.js";
import { BIND_ATTEMPTS, bindSessionSocket } from "./session-daemon-bind.js";
import type { EvaluateUnifiedContext } from "./evaluator-unified.js";
import type { DaemonPaths } from "./session-paths.js";

let temp = "";

afterEach(() => {
    if (temp) {
        rmSync(temp, { recursive: true, force: true });
        temp = "";
    }
});

function paths(name: string): DaemonPaths {
    return {
        socket: join(temp, name + ".sock"),
        pid: join(temp, name + ".pid"),
        log: join(temp, "logs", name + ".log"),
    };
}

function state() {
    return {
        tsgo: {
            available: () => true,
            checkFile: vi.fn().mockResolvedValue({ diagnostics: [], cached: false, elapsed_ms: 1 }),
            simulateEdit: vi.fn().mockResolvedValue({ new_diagnostics: [], elapsed_ms: 1 }),
            invalidate: vi.fn(),
            stats: () => ({ cache_size: 0, available: true }),
        },
        getEvaluatorContext: (): EvaluateUnifiedContext => ({
            rules: {
                version: 1,
                enabled: false,
            } as unknown as EvaluateUnifiedContext["rules"],
            session: undefined,
            reservations: {} as EvaluateUnifiedContext["reservations"],
            cohort: {} as EvaluateUnifiedContext["cohort"],
        }),
    };
}

describe("session daemon binding and ownership", () => {
    // test-contract: an occupied serving socket is never removed or retried into.
    it("refuses to stomp a serving incumbent", async () => {
        temp = mkdtempSync(join(tmpdir(), "session-daemon-"));
        const socketPath = join(temp, "incumbent.sock");
        const incumbent = createServer();
        await new Promise<void>((resolve) => incumbent.listen(socketPath, resolve));

        await expect(
            bindSessionSocket({
                socketPath,
                onConnection: () => undefined,
                attempts: 2,
                isServing: async () => true,
                sleep: async () => undefined,
            }),
        ).rejects.toBeDefined();
        expect(existsSync(socketPath)).toBe(true);
        await new Promise<void>((resolve) => incumbent.close(() => resolve()));
    });

    // test-contract: zero configured bind attempts performs no listen and rejects.
    it("does not bind when attempts is zero", async () => {
        temp = mkdtempSync(join(tmpdir(), "session-daemon-"));
        await expect(
            bindSessionSocket({
                socketPath: join(temp, "never.sock"),
                onConnection: () => undefined,
                attempts: 0,
                sleep: async () => undefined,
            }),
        ).rejects.toThrow("bind aborted before any attempt");
        expect(BIND_ATTEMPTS).toBe(3);
    });

    // test-contract: a live foreign pid claim is rejected without overwriting its file.
    it("reports an existing live foreign owner", () => {
        temp = mkdtempSync(join(tmpdir(), "session-daemon-"));
        const pidPath = join(temp, "owner.pid");
        const owner = process.ppid === process.pid ? process.pid + 1 : process.ppid;
        writeFileSync(pidPath, String(owner));
        expect(claimSessionPid(pidPath, process.pid)).toEqual({ claimed: false, ownerPid: owner });
        expect(Number.parseInt(readFileSync(pidPath, "utf-8"), 10)).toBe(owner);
    });

    // test-contract: stopping a started daemon is idempotent and releases its public ownership artifacts.
    it("stops idempotently and removes pid and socket files", async () => {
        temp = mkdtempSync(join(tmpdir(), "session-daemon-"));
        const daemonPaths = paths("owned");
        const daemon = await startSessionDaemon({
            paths: daemonPaths,
            session_id: "owned",
            idle_shutdown_ms: 0,
            state: state(),
        });
        expect(existsSync(daemonPaths.pid)).toBe(true);
        expect(existsSync(daemonPaths.socket)).toBe(true);
        await daemon.stop("test");
        await daemon.stop("again");
        expect(existsSync(daemonPaths.pid)).toBe(false);
        expect(existsSync(daemonPaths.socket)).toBe(false);
        expect(daemon.rpcInflight()).toBe(0);
    });
});
