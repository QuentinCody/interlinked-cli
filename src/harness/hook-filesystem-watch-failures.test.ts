import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startHookFilesystemWatch } from "./hook-filesystem-watch.js";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof fs>(), watch: vi.fn() }));

class WatchHandle extends EventEmitter implements fs.FSWatcher {
    closed = false;
    constructor(readonly directory: string) { super(); }
    close(): void { this.closed = true; }
    ref(): this { return this; }
    unref(): this { return this; }
}
const cleanups: Array<() => void> = [], handles: WatchHandle[] = [];
beforeEach(() => {
    vi.useFakeTimers();
    handles.length = 0;
    vi.mocked(fs.watch).mockReset().mockImplementation(directory => {
        const handle = new WatchHandle(String(directory)); handles.push(handle); return handle;
    });
});
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    vi.useRealTimers();
});
function fixture() {
    const root = fs.mkdtempSync(join(tmpdir(), "coverage-watch-failure-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const path = join(root, "source.ts");
    fs.writeFileSync(path, "original");
    const onError = vi.fn();
    const watcher = startHookFilesystemWatch({ root, reservations: () => [path], onError, reconcileMs: 1000 });
    cleanups.push(watcher.stop);
    return { path, watcher, onError };
}

it("keeps failed watch admission unmeasured until periodic reconciliation can arm it", async () => {
    vi.mocked(fs.watch).mockImplementationOnce(() => { throw new Error("EMFILE"); });
    const { watcher } = fixture();
    expect(watcher.status()).toMatchObject({ readiness: "unmeasured", unmeasured: [expect.stringContaining("EMFILE")] });
    expect(watcher.ledger.observation().pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(watcher.status()).toMatchObject({ readiness: "ready", unmeasured: [] });
    expect(watcher.ledger.observation().pending).toHaveLength(1);
});

it("replaces a failed watch and observes intervening writes without clearing their obligations", async () => {
    const { path, watcher, onError } = fixture(), original = watcher.ledger.observation().pending[0]!;
    const failed = handles[0]!;
    fs.writeFileSync(path, "written while the watch was failing");
    failed.emit("error", new Error("watch disconnected"));
    expect(failed.closed).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("watch disconnected"));
    await vi.advanceTimersByTimeAsync(50);
    const current = watcher.ledger.observation().pending[0]!;
    expect(current.id).not.toBe(original.id);
    expect(current.identity).not.toBe(original.identity);
    expect(watcher.status().readiness).toBe("ready");
    expect(handles.some(handle => handle.directory === failed.directory && handle !== failed && !handle.closed)).toBe(true);
    expect(watcher.ledger.snapshot().checks).toEqual([]);
});

it("cancels a scheduled watch repair on shutdown and leaves the durable pending version intact", async () => {
    const { watcher } = fixture(), pending = watcher.ledger.observation().pending;
    handles[0]!.emit("error", new Error("watch disconnected"));
    watcher.stop();
    const count = handles.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(handles).toHaveLength(count);
    expect(handles.every(handle => handle.closed)).toBe(true);
    expect(watcher.status().readiness).toBe("unmeasured");
    expect(watcher.ledger.observation().pending).toEqual(pending);
});
