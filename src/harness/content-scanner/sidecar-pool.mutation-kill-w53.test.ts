import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { SidecarPool, type SidecarPoolOptions } from "./sidecar-pool.js";
import { makeSidecarChild, type FakeSidecarChild } from "./test-sidecar-child.js";

function makePool(children: FakeSidecarChild[], overrides: Partial<SidecarPoolOptions> = {}) {
	const available = [...children];
	return new SidecarPool({
		python_bin: "python3", script_path: "/dev/null",
		startup_timeout_ms: 1000, scan_timeout_ms: 1000, idle_shutdown_ms: 1000,
		max_restarts: 1, pool_size: children.length,
		spawn: () => nonNull(available.shift()),
		stderrSink: () => {},
		...overrides,
	});
}

function respond(child: FakeSidecarChild): void {
	const request = JSON.parse(nonNull(child.stdinLines.at(-1)));
	child.respond({ id: request.id, ok: true });
}

describe("SidecarPool — public aggregate lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("retains idle slots and sums restart counts when spawning fails", async () => {
		const first = makeSidecarChild(10);
		const second = makeSidecarChild(20);
		const pool = makePool([first, second], { spawn: () => { throw new Error("spawn failed"); } });
		await pool.send({ op: "ping" });
		expect(pool.getStatus()).toMatchObject({ state: "idle", restartCount: 1, detail: "0/2 ready" });

		await pool.send({ op: "ping" });
		expect(pool.getStatus()).toMatchObject({ state: "disabled", restartCount: 2, detail: "0/2 ready" });
	});

	it("reports the first ready pool slot even when children finish in reverse order", async () => {
		const first = makeSidecarChild(10);
		const second = makeSidecarChild(20);
		const pool = makePool([first, second]);
		const firstRequest = pool.send({ op: "ping" });
		const secondRequest = pool.send({ op: "ping" });
		await Promise.resolve();
		respond(second);
		await secondRequest;
		expect(pool.getStatus()).toMatchObject({ state: "ready", pid: 20, detail: "1/2 ready" });
		respond(first);
		await firstRequest;
		expect(pool.getStatus()).toMatchObject({ state: "ready", pid: 10, detail: "2/2 ready" });
	});

	it("emits only aggregate changes and preserves sinceIso while the state stays ready", async () => {
		const first = makeSidecarChild(10);
		const second = makeSidecarChild(20);
		const onStatusChange = vi.fn();
		const pool = makePool([first, second], { onStatusChange });
		const firstRequest = pool.send({ op: "ping" });
		await Promise.resolve();
		respond(first);
		await firstRequest;
		const readySince = pool.getStatus().sinceIso;
		onStatusChange.mockClear();

		vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
		const secondRequest = pool.send({ op: "ping" });
		await Promise.resolve();
		expect(onStatusChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
			state: "ready", pid: 10, detail: "1/2 ready", restartCount: 1, sinceIso: readySince,
		}));
		onStatusChange.mockClear();
		second.exit(1);
		await secondRequest;
		expect(onStatusChange).not.toHaveBeenCalled();
		expect(pool.getStatus().sinceIso).toBe(readySince);
	});

	it("updates sinceIso on dormancy and keeps serving when a status listener throws", async () => {
		const child = makeSidecarChild(10);
		const pool = makePool([child], { onStatusChange: () => { throw new Error("listener failed"); } });
		const request = pool.send({ op: "ping" });
		await Promise.resolve();
		respond(child);
		expect((await request).ok).toBe(true);
		const readySince = pool.getStatus().sinceIso;
		await vi.advanceTimersByTimeAsync(1000);
		child.exit(0);
		await Promise.resolve();
		expect(pool.getStatus()).toMatchObject({ state: "dormant", detail: "0/1 ready" });
		expect(pool.getStatus().sinceIso).not.toBe(readySince);
	});
});
