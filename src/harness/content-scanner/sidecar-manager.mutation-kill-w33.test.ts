import { makeSidecarChild } from "./test-sidecar-child.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidecarManager, type SidecarManagerOptions } from "./sidecar-manager.js";

// ===========================================
// Local fixtures (self-contained — no cross-file coupling)
// ===========================================

function must<T>(v: T | undefined): T {
	if (v === undefined) throw new Error("expected a defined value in test fixture");
	return v;
}

function makeFakeChild(pid = 1234) { return makeSidecarChild(pid); }

function makeOpts(overrides: Partial<SidecarManagerOptions> = {}): SidecarManagerOptions {
	return {
		python_bin: "python3",
		script_path: "/tmp/fake-sidecar.py",
		startup_timeout_ms: 500,
		scan_timeout_ms: 100,
		idle_shutdown_ms: 10_000,
		max_restarts: 3,
		stderrSink: () => {},
		...overrides,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

// ===========================================
// Tests
// ===========================================

describe("SidecarManager — fresh-instance initial field values", () => {
	// test-contract: invariant — lineBuffer must start empty; a garbage prefix would corrupt the first parsed line.
	it("delivers the very first response correctly (lineBuffer starts empty)", async () => {
		const child = makeFakeChild();
		const spawn = vi.fn(() => child);
		const mgr = new SidecarManager(makeOpts({ spawn }));
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		const sentId = JSON.parse(must(child.stdinLines[0])).id;
		child.respond({ id: sentId, ok: true });
		const resp = await p;
		expect(resp).toEqual({ ok: true, error: undefined, spans: undefined, redacted_text: undefined });
	});

	// test-contract: invariant — booted starts false, so the first call uses startup_timeout_ms and only flips to
	// "ready" once the first response actually arrives.
	it("is not pre-booted: uses startup_timeout_ms and stays pending past scan_timeout_ms on the first call", async () => {
		const child = makeFakeChild();
		const spawn = vi.fn(() => child);
		const mgr = new SidecarManager(makeOpts({ spawn, startup_timeout_ms: 500, scan_timeout_ms: 50 }));
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();

		// Past scan_timeout_ms but well under startup_timeout_ms — must still be pending if booted
		// really started false (uses the startup budget, not the scan budget).
		await vi.advanceTimersByTimeAsync(60);
		let settled = false;
		void p.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(mgr.getStatus().state).toBe("spawning");

		child.respond({ id: JSON.parse(must(child.stdinLines[0])).id, ok: true });
		const resp = await p;
		expect(resp.ok).toBe(true);
		expect(mgr.getStatus().state).toBe("ready");
	});

	// test-contract: invariant — dormant starts false, so the very first spawn reports "starting", never
	// "re-spawning after dormant".
	it("reports 'starting' (never 'dormant') detail on the very first spawn", async () => {
		const child = makeFakeChild();
		const spawn = vi.fn(() => child);
		const mgr = new SidecarManager(makeOpts({ spawn }));
		void mgr.send({ op: "ping" });
		await Promise.resolve();
		expect(mgr.getStatus()).toMatchObject({ state: "spawning", detail: "starting" });
	});
});

describe("SidecarManager — dormant flag drives the respawn detail string", () => {
	// test-contract: invariant — after a crash-exit, the manager must be marked dormant so the next spawn's
	// status detail reads "re-spawning after dormant" (not "starting").
	it("reports 're-spawning after dormant' after respawning post crash-exit", async () => {
		const child1 = makeFakeChild(1);
		const child2 = makeFakeChild(2);
		const children = [child1, child2];
		const spawn = vi.fn(() => {
			const c = children.shift();
			if (!c) throw new Error("no more fake children");
			return c;
		});
		const mgr = new SidecarManager(makeOpts({ spawn }));

		const p1 = mgr.send({ op: "ping" });
		await Promise.resolve();
		child1.respond({ id: JSON.parse(must(child1.stdinLines[0])).id, ok: true });
		await p1;

		child1.exit(1);
		await Promise.resolve();
		expect(mgr.getStatus().state).toBe("dormant");

		const p2 = mgr.send({ op: "ping" });
		await Promise.resolve();
		expect(mgr.getStatus()).toMatchObject({ state: "spawning", detail: "re-spawning after dormant" });
		child2.respond({ id: JSON.parse(must(child2.stdinLines[0])).id, ok: true });
		await p2;
	});

	// test-contract: invariant — same as above, but the crash arrives via the child's "error" event rather
	// than "exit" — exercises the sibling dormant-flag assignment in the error handler.
	it("reports 're-spawning after dormant' after respawning post child 'error' event", async () => {
		const child1 = makeFakeChild(1);
		const child2 = makeFakeChild(2);
		const children = [child1, child2];
		const spawn = vi.fn(() => {
			const c = children.shift();
			if (!c) throw new Error("no more fake children");
			return c;
		});
		const mgr = new SidecarManager(makeOpts({ spawn }));

		const p1 = mgr.send({ op: "ping" });
		await Promise.resolve();
		child1.respond({ id: JSON.parse(must(child1.stdinLines[0])).id, ok: true });
		await p1;

		child1.emit("error", new Error("ECONNRESET"));
		await Promise.resolve();
		expect(mgr.getStatus().state).toBe("dormant");

		const p2 = mgr.send({ op: "ping" });
		await Promise.resolve();
		expect(mgr.getStatus()).toMatchObject({ state: "spawning", detail: "re-spawning after dormant" });
		child2.respond({ id: JSON.parse(must(child2.stdinLines[0])).id, ok: true });
		await p2;
	});
});

describe("SidecarManager — exit code formatting in the dormant detail", () => {
	// test-contract: invariant — a truthy, non-null exit code (e.g. 1) must be rendered
	// verbatim in the dormant status detail, not coerced to the literal "null".
	it("reports the real exit code in the dormant detail for a nonzero code", async () => {
		const child = makeFakeChild();
		const spawn = vi.fn(() => child);
		const mgr = new SidecarManager(makeOpts({ spawn }));
		void mgr.send({ op: "ping" });
		await Promise.resolve();
		child.exit(1);
		await Promise.resolve();
		expect(mgr.getStatus()).toMatchObject({
			state: "dormant",
			detail: "child exited (code=1)",
		});
	});
});

describe("SidecarManager — idle timer bookkeeping", () => {
	// test-contract: invariant — shutdown() must clear any pending idle timer before arming its own force-kill
	// timer, so the net pending-timer count does not grow.
	it("clears the pending idle timer during shutdown (no leaked timer)", async () => {
		const child = makeFakeChild();
		const spawn = vi.fn(() => child);
		const mgr = new SidecarManager(makeOpts({ spawn, idle_shutdown_ms: 5000 }));

		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		child.respond({ id: JSON.parse(must(child.stdinLines[0])).id, ok: true });
		await p;

		// Exactly one timer pending: the idle timer armed by the successful send().
		expect(vi.getTimerCount()).toBe(1);

		const shutdownPromise = mgr.shutdown();
		// shutdown() synchronously clears the idle timer and arms its own 1s force-kill
		// timer — net count must stay at 1, not grow to 2.
		expect(vi.getTimerCount()).toBe(1);

		child.exit(0);
		await shutdownPromise;
	});

	// test-contract: invariant — each send() must clear the PREVIOUS idle timer before arming a new one —
	// otherwise repeated sends leak one idle timer per call.
	it("clears the previous idle timer before arming a new one on repeated sends", async () => {
		const child = makeFakeChild();
		const spawn = vi.fn(() => child);
		const mgr = new SidecarManager(makeOpts({ spawn, idle_shutdown_ms: 5000 }));

		const p1 = mgr.send({ op: "ping" });
		await Promise.resolve();
		child.respond({ id: JSON.parse(must(child.stdinLines[0])).id, ok: true });
		await p1;
		expect(vi.getTimerCount()).toBe(1);

		const p2 = mgr.send({ op: "ping" });
		await Promise.resolve();
		child.respond({ id: JSON.parse(must(child.stdinLines[1])).id, ok: true });
		await p2;
		expect(vi.getTimerCount()).toBe(1);

		const p3 = mgr.send({ op: "ping" });
		await Promise.resolve();
		child.respond({ id: JSON.parse(must(child.stdinLines[2])).id, ok: true });
		await p3;
		expect(vi.getTimerCount()).toBe(1);
	});
});

describe("SidecarManager — shutdown reason for a request that outlives graceful shutdown", () => {
	// test-contract: invariant — a request still pending when the graceful-shutdown wait resolves without ever
	// observing an "exit" event must be rejected with the exact literal "sidecar shut down".
	it("rejects a request still pending after the force-kill window with 'sidecar shut down'", async () => {
		const child = makeFakeChild();
		// Simulate an unresponsive child: kill() never causes an "exit" event, so the
		// exit-handler's own rejectAllPending never runs — only shutdown()'s own
		// end-of-function rejectAllPending("sidecar shut down") can settle the pending request.
		child.kill = vi.fn(() => true);
		const spawn = vi.fn(() => child);
		// startup_timeout_ms must exceed the 1s force-kill window — otherwise the
		// per-request timer (not shutdown()'s rejectAllPending) settles the promise
		// first, which is what this test is trying to rule out.
		const mgr = new SidecarManager(makeOpts({ spawn, startup_timeout_ms: 5000 }));

		const pending = mgr.send({ op: "scan", text: "x" });
		await Promise.resolve();

		const shutdownPromise = mgr.shutdown();
		await vi.advanceTimersByTimeAsync(1100); // past the 1s force-kill grace window
		await shutdownPromise;

		await expect(pending).resolves.toEqual({ ok: false, error: "sidecar shut down" });
	});
});
