import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { antiStompDepsFor, reapZombieIncumbent, type ZombieReapDeps } from "./anti-stomp.js";
import { startupLockPath } from "../startup-lock.js";

const roots: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function reap(deps: ZombieReapDeps) {
    return reapZombieIncumbent({ pid: 4242, cwd: "/repo", logAlways: vi.fn(), deps });
}

function clockedDeps() {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    return { identify: vi.fn(() => "original"), isAlive: vi.fn(() => true), kill: vi.fn<(pid: number, signal: "SIGTERM" | "SIGKILL") => void>(),
        sleep: async (ms: number) => { vi.setSystemTime(Date.now() + ms); } };
}

describe("zombie reaping at identity and termination boundaries", () => {
    it("rejects identity replacement between the initial two reads without signaling", async () => {
        const deps = clockedDeps();
        deps.identify.mockReturnValueOnce("original").mockReturnValueOnce("replacement");
        expect(await reap(deps)).toBe("unverified");
        expect(deps.kill).not.toHaveBeenCalled();
    });

    it("fails safely when signaling throws a primitive instead of an errno object", async () => {
        const deps = clockedDeps();
        deps.kill.mockImplementation(() => { throw "signal transport failed"; });
        expect(await reap(deps)).toBe("failed");
        expect(deps.kill).toHaveBeenCalledExactlyOnceWith(4242, "SIGTERM");
    });

    it("accepts exit at the grace deadline without escalating", async () => {
        const deps = clockedDeps();
        deps.isAlive.mockImplementation(() => Date.now() < 1000);
        expect(await reap(deps)).toBe("gone");
        expect(deps.kill).toHaveBeenCalledExactlyOnceWith(4242, "SIGTERM");
    });

    it("accepts exit between the final grace poll and escalation without signaling again", async () => {
        const deps = clockedDeps();
        let deadlinePolls = 0;
        deps.isAlive.mockImplementation(() => Date.now() < 1000 || ++deadlinePolls === 1);
        expect(await reap(deps)).toBe("gone");
        expect(deps.kill).toHaveBeenCalledExactlyOnceWith(4242, "SIGTERM");
    });

    it("preserves a replacement first detected at the escalation identity check", async () => {
        const deps = clockedDeps();
        deps.identify.mockImplementation(() => Date.now() < 1000 ? "original" : "replacement");
        expect(await reap(deps)).toBe("replaced");
        expect(deps.kill).toHaveBeenCalledExactlyOnceWith(4242, "SIGTERM");
    });

    it.each(["ESRCH", "EPERM"])("handles %s during escalation without falsely confirming termination", async (code) => {
        const deps = clockedDeps();
        deps.kill.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw Object.assign(new Error(code), { code }); });
        expect(await reap(deps)).toBe(code === "ESRCH" ? "gone" : "failed");
        expect(deps.kill.mock.calls).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    });

    it("does not grant takeover when the incumbent remains alive after SIGKILL", async () => {
        const deps = clockedDeps();
        expect(await reap(deps)).toBe("failed");
        expect(Date.now()).toBe(1500);
        expect(deps.kill.mock.calls).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    });

    it("uses the real process signaling adapter without an injected kill dependency", async () => {
        const kill = vi.spyOn(process, "kill").mockReturnValue(true);
        const isAlive = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
        expect(await reap({ identify: () => "original", isAlive })).toBe("gone");
        expect(kill).toHaveBeenCalledExactlyOnceWith(4242, "SIGTERM");
    });

    it("treats permission-denied liveness as alive and still requires verified identity", async () => {
        const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
        expect(await reap({ identify: () => null })).toBe("unverified");
        expect(kill).toHaveBeenCalledExactlyOnceWith(4242, 0);
    });

    it("does not mistake the live test runner for a daemon when using native identity verification", async () => {
        const kill = vi.spyOn(process, "kill").mockReturnValue(true);
        const result = await reapZombieIncumbent({ pid: process.pid, cwd: "/not-a-daemon-workspace", logAlways: vi.fn() });
        expect(result).toBe("unverified");
        expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, 0);
    });

    it("releases this process's startup lock before terminating the loser", () => {
        const root = mkdtempSync(join(tmpdir(), "anti-stomp-release-"));
        roots.push(root);
        mkdirSync(join(root, ".interlinked"));
        const lock = startupLockPath(root);
        writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
        const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exited"); });
        expect(() => antiStompDepsFor(root, vi.fn()).exit()).toThrow("exited");
        expect(exit).toHaveBeenCalledExactlyOnceWith(0);
        expect(existsSync(lock)).toBe(false);
    });
});
