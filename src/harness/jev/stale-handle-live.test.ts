// Pin request ownership after an idle sidecar is replaced. The error case
// injects a late lifecycle event independently of platform delivery timing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSidecarChild, type FakeSidecarChild } from "../content-scanner/test-sidecar-child.js";
import { SidecarManager, type SpawnFn } from "../content-scanner/sidecar-manager.js";

/** A child whose kill() behaves like the real one: `killed` flips at once, `exit` arrives later. */
function slowDyingChild(): FakeSidecarChild {
	const child = makeSidecarChild(101);
	child.kill = ((signal?: NodeJS.Signals | number) => {
		child.killSignals.push(signal === undefined ? "" : String(signal));
		child.killed = true;
		return true;
	}) as FakeSidecarChild["kill"];
	return child;
}

function idOf(child: FakeSidecarChild, index: number): string {
	return (JSON.parse(child.stdinLines[index] ?? "{}") as { id: string }).id;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SidecarManager request ownership", () => {
	it.each([["exit", null], ["error", new Error("previous sidecar failed")]] as const)(
		"a late %s from the idle-killed child preserves the replacement's pending and subsequent requests", async (event, payload) => {
		const a = slowDyingChild();
		const b = makeSidecarChild(202);
		const c = makeSidecarChild(303);
		const queue = [a, b, c];
		const spawn = vi.fn<SpawnFn>(() => queue.shift() as FakeSidecarChild);
		const mgr = new SidecarManager({
			python_bin: "python3", script_path: "/tmp/fake.py", startup_timeout_ms: 5_000, scan_timeout_ms: 5_000,
			idle_shutdown_ms: 1_000, max_restarts: 5, spawn, stderrSink: () => {},
		});

		const first = mgr.send({ op: "ping" });
		await Promise.resolve();
		a.respond({ id: idOf(a, 0), ok: true });
		expect((await first).ok).toBe(true);

		// Idle close: `shutdown` op, then the SIGKILL fallback 1s later. A hung
		// sidecar ignores the op; kill() marks it killed, its exit is not yet delivered.
		await vi.advanceTimersByTimeAsync(1_000 + 1_000);
		expect(a.killed).toBe(true);

		// A send in that window sees `child.killed` and spawns generation B.
		const second = mgr.send({ op: "ping" });
		await Promise.resolve();
		expect(spawn).toHaveBeenCalledTimes(2);

		a.emit(event, payload);
		b.respond({ id: idOf(b, 0), ok: true });
		const res = await second;

		expect(res).toEqual(expect.objectContaining({ ok: true }));
		expect(mgr.getStatus().state).not.toBe("dormant");
		const third = mgr.send({ op: "ping" });
		await Promise.resolve();
		expect(spawn).toHaveBeenCalledTimes(2); // B is reused, not leaked behind a fresh C
		b.respond({ id: idOf(b, 1), ok: true });
		expect(await third).toMatchObject({ ok: true });
	});
});
