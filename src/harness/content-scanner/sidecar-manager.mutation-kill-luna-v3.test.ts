import { makeSidecarChild } from "./test-sidecar-child.js";
import { describe, expect, it, vi } from "vitest";
import { SidecarManager, type SidecarManagerOptions } from "./sidecar-manager.js";

function makeChild(pid = 1) {
    const child = makeSidecarChild(pid);
    return Object.assign(child, { out(value: string): void { child.stdout.emit("data", value); } });
}

function options(spawn: NonNullable<SidecarManagerOptions["spawn"]>, extra: Partial<SidecarManagerOptions> = {}): SidecarManagerOptions {
    return { python_bin: "python3", script_path: "/tmp/sidecar.py", script_args: ["--mode", "test"], startup_timeout_ms: 1000, scan_timeout_ms: 1000, idle_shutdown_ms: 1000, max_restarts: 2, spawn, ...extra };
}

describe("SidecarManager", () => {
    // test-contract: live children are reused and request text is included only when supplied.
    it("reuses a live child and preserves the request envelope", async () => {
        const c = makeChild();
        const spawn = vi.fn(() => c);
        const input: string[] = [];
        c.stdin?.on("data", (value) => input.push(String(value)));
        const manager = new SidecarManager(options(spawn));
        const first = manager.send({ op: "ping" });
        const second = manager.send({ op: "scan", text: "abc" });
        expect(spawn).toHaveBeenCalledOnce();
        c.out('{"id":"2","ok":true}\n{"id":"1","ok":true}\n');
        await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
        expect(input).toEqual(['{"id":"1","op":"ping"}\n', '{"id":"2","op":"scan","text":"abc"}\n']);
    });

    // test-contract: malformed, null, array, empty-id, and whitespace-only lines never resolve a pending request.
    it("accepts only trimmed records with nonempty string ids", async () => {
        const c = makeChild();
        const manager = new SidecarManager(options(() => c));
        const result = manager.send({ op: "ping" });
        c.out("\nnull\n[]\n{\"id\":\"\",\"ok\":true}\n");
        c.out('  {"id":"1","ok":true,"error":7,"redacted_text":9}  \n');
        await expect(result).resolves.toEqual({ ok: true, error: undefined, spans: undefined, redacted_text: undefined });
    });

    // test-contract: idle shutdown writes and ends the child, then the manager reports dormant and respawns.
    it("recovers after idle shutdown", async () => {
        vi.useFakeTimers();
        try {
            const first = makeChild(1);
            const second = makeChild(2);
            const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
            const writes: string[] = [];
            first.stdin?.on("data", (value) => writes.push(String(value)));
            const manager = new SidecarManager(options(spawn, { idle_shutdown_ms: 10 }));
            const result = manager.send({ op: "ping" });
            first.out('{"id":"1","ok":true}\n');
            await result;
            await vi.advanceTimersByTimeAsync(10);
            first.emit("exit", 0);
            expect(writes).toContain('{"id":"idle-shutdown","op":"shutdown"}\n');
            expect(manager.getStatus()).toMatchObject({ state: "dormant" });
            const next = manager.send({ op: "ping" });
            second.out('{"id":"2","ok":true}\n');
            await expect(next).resolves.toEqual({ ok: true });
            expect(spawn).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    // test-contract: explicit shutdown sends its protocol message, rejects pending work, and remains disabled.
    it("permanently shuts down with exact observable reasons", async () => {
        const c = makeChild();
        const writes: string[] = [];
        c.stdin?.on("data", (value) => writes.push(String(value)));
        const manager = new SidecarManager(options(() => c));
        const pending = manager.send({ op: "ping" });
        const closing = manager.shutdown();
        c.emit("exit", null);
        await closing;
        await expect(pending).resolves.toEqual({ ok: false, error: "sidecar exited with code null" });
        expect(writes).toContain('{"id":"shutdown","op":"shutdown"}\n');
        expect(manager.getStatus()).toMatchObject({ state: "disabled", detail: "explicit shutdown" });
        await expect(manager.send({ op: "ping" })).resolves.toEqual({ ok: false, error: "sidecar is shutting down" });
    });

    // test-contract: child errors are fail-open, status callbacks are best-effort, and omitted callbacks are safe.
    it("handles errors and status callback failures", async () => {
        const c = makeChild();
        const states: string[] = [];
        const manager = new SidecarManager(options(() => c, { onStatusChange: (status) => { states.push(status.state); throw new Error("listener"); } }));
        const pending = manager.send({ op: "ping" });
        c.emit("error", new Error("broken"));
        await expect(pending).resolves.toEqual({ ok: false, error: "sidecar error: broken" });
        expect(manager.getStatus()).toMatchObject({ state: "dormant", detail: "child error: broken" });
        expect(states).toContain("dormant");
        expect(new SidecarManager(options(() => makeChild())).getStatus().state).toBe("idle");
    });

    // test-contract: consecutive spawn failures consume the configured restart budget and expose the documented disabled state.
    it("bounds restart failures", async () => {
        const spawn = vi.fn(() => {
            throw new Error("unavailable");
        });
        const manager = new SidecarManager(options(spawn, { max_restarts: 1 }));
        await expect(manager.send({ op: "ping" })).resolves.toEqual({ ok: false, error: "sidecar spawn failed: unavailable" });
        await expect(manager.send({ op: "ping" })).resolves.toEqual({ ok: false, error: "sidecar spawn failed: sidecar exceeded max_restarts (1); disabled for this session" });
        expect(manager.getStatus()).toMatchObject({ state: "disabled", restartCount: 1 });
    });
});
