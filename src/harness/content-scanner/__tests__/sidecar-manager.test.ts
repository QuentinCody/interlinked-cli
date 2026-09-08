import { makeSidecarChild as makeFakeChild, type FakeSidecarChild as FakeChild } from "../test-sidecar-child.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import type { SidecarManagerOptions, SpawnFn } from "../sidecar-manager.js";
import { SidecarManager } from "../sidecar-manager.js";

// ===========================================
// Fake child process
// ===========================================

function makeOpts(overrides: Partial<SidecarManagerOptions> = {}): SidecarManagerOptions {
	const child = makeFakeChild();
	const spawn = vi.fn<SpawnFn>(() => child);
	return {
		python_bin: "python3",
		script_path: "/tmp/fake-sidecar.py",
		startup_timeout_ms: 500,
		scan_timeout_ms: 100,
		idle_shutdown_ms: 10_000,
		max_restarts: 3,
		spawn,
		stderrSink: () => {},
		...overrides,
	};
}

// ===========================================
// Test fixtures
// ===========================================

type ManagerCtx = {
	mgr: SidecarManager;
	child: FakeChild;
	spawn: ReturnType<typeof vi.fn<SpawnFn>>;
};

function makeManager(overrides: Partial<SidecarManagerOptions> = {}): ManagerCtx {
	const child = makeFakeChild();
	const spawn = vi.fn<SpawnFn>(() => child);
	const opts = { ...makeOpts(), ...overrides, spawn };
	return { mgr: new SidecarManager(opts), child, spawn };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

// ===========================================
// Tests
// ===========================================

describe("SidecarManager — spawn args", () => {
	it("spawns with [script_path] only when script_args is omitted", async () => {
		const { mgr, child, spawn } = makeManager();
		const stdoutEncoding = vi.spyOn(child.stdout, "setEncoding");
		const stderrEncoding = vi.spyOn(child.stderr, "setEncoding");
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		expect(spawn).toHaveBeenCalledOnce();
		const callArgs = spawn.mock.calls[0];
		expect(nonNull(callArgs)[0]).toBe("python3");
		expect(nonNull(callArgs)[1]).toEqual(["/tmp/fake-sidecar.py"]);
		expect(nonNull(callArgs)[2]).toMatchObject({ stdio: ["pipe", "pipe", "pipe"] });
		expect(stdoutEncoding).toHaveBeenCalledWith("utf8");
		expect(stderrEncoding).toHaveBeenCalledWith("utf8");
		const sent = JSON.parse(nonNull(child.stdinLines[0]));
		child.respond({ id: sent.id, ok: true });
		await p;
	});

	it("appends script_args after script_path on spawn", async () => {
		const args = ["--viterbi-calibration-path", "/abs/path/to/high_precision.json"];
		const { mgr, child, spawn } = makeManager({ script_args: args });
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		expect(spawn).toHaveBeenCalledOnce();
		const callArgs = spawn.mock.calls[0];
		expect(nonNull(callArgs)[1]).toEqual(["/tmp/fake-sidecar.py", ...args]);
		expect(nonNull(callArgs)[2]).toMatchObject({ stdio: ["pipe", "pipe", "pipe"] });
		const sent = JSON.parse(nonNull(child.stdinLines[0]));
		child.respond({ id: sent.id, ok: true });
		await p;
	});
});

describe("SidecarManager — happy path", () => {
	it("spawns lazily on first send, forwards request, correlates response by id", async () => {
		const { mgr, child, spawn } = makeManager();
		expect(spawn).not.toHaveBeenCalled();

		const p = mgr.send({ op: "ping" });
		expect(spawn).toHaveBeenCalledOnce();

		// Advance enough microtasks for the Promise chain to register the pending entry.
		await Promise.resolve();
		expect(child.stdinLines).toHaveLength(1);
		const sent = JSON.parse(nonNull(child.stdinLines[0]));
		expect(sent.op).toBe("ping");
		expect(typeof sent.id).toBe("string");

		child.respond({ id: sent.id, ok: true });
		const resp = await p;
		expect(resp.ok).toBe(true);
	});

	it("retains valid spans beside malformed sidecar response entries", async () => {
		const { mgr, child } = makeManager();
		const pending = mgr.send({ op: "scan", text: "alice@example.com" });
		await Promise.resolve();
		const sent = JSON.parse(nonNull(child.stdinLines[0]));
		const valid = { label: "EMAIL", start: 0, end: 17, text: "alice@example.com", score: 0.95 };
		child.respond({ id: sent.id, ok: true, spans: [
			null, { ...valid, start: "0" }, { ...valid, end: -1 }, { ...valid, score: "high" }, valid,
		] });
		expect((await pending).spans).toEqual([valid]);
	});

	it("delivers spans and redacted_text on scan responses", async () => {
		const { mgr, child } = makeManager();
		const p = mgr.send({ op: "scan", text: "alice@example.com" });
		await Promise.resolve();
		const sent = JSON.parse(nonNull(child.stdinLines[0]));
		expect(sent.text).toBe("alice@example.com");

		child.respond({
			id: sent.id,
			ok: true,
			spans: [{ label: "private_email", start: 0, end: 17, text: "alice@example.com" }],
			redacted_text: "<PRIVATE_EMAIL>",
		});
		const resp = await p;
		expect(resp.ok).toBe(true);
		expect(resp.spans).toHaveLength(1);
		expect(nonNull(resp.spans?.[0]).label).toBe("private_email");
		expect(resp.redacted_text).toBe("<PRIVATE_EMAIL>");
	});

	it("multiple concurrent requests are correlated by id", async () => {
		const { mgr, child } = makeManager();
		const p1 = mgr.send({ op: "scan", text: "a" });
		const p2 = mgr.send({ op: "scan", text: "b" });
		await Promise.resolve();
		const [sent1, sent2] = child.stdinLines.map((l) => JSON.parse(l));

		// Respond out of order — p2 first, then p1.
		child.respond({ id: sent2.id, ok: true, spans: [], redacted_text: "b" });
		child.respond({ id: sent1.id, ok: true, spans: [], redacted_text: "a" });
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1.redacted_text).toBe("a");
		expect(r2.redacted_text).toBe("b");
	});

	it("assigns monotonically increasing request IDs and omits an unset text field", async () => {
		const { mgr, child } = makeManager();
		const p1 = mgr.send({ op: "ping" });
		const p2 = mgr.send({ op: "scan" });
		await Promise.resolve();

		const sent = child.stdinLines.map((line) => JSON.parse(line));
		expect(sent.map((request) => request.id)).toEqual(["1", "2"]);
		expect(sent[0]).not.toHaveProperty("text");
		expect(sent[1]).not.toHaveProperty("text");
		child.respond({ id: sent[0].id, ok: true });
		child.respond({ id: sent[1].id, ok: true });
		await Promise.all([p1, p2]);
	});

	it("does not treat numeric or empty response IDs as pending request IDs", async () => {
		const { mgr, child } = makeManager({ startup_timeout_ms: 50 });
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		const id = JSON.parse(nonNull(child.stdinLines[0])).id;

		child.respond({ id: 42, ok: true });
		child.respond({ id: "", ok: true });
		child.respond({ id, ok: true });
		expect(await p).toEqual({
			ok: true,
			error: undefined,
			spans: undefined,
			redacted_text: undefined,
		});
	});
});

describe("SidecarManager — timeouts", () => {
	it("uses startup_timeout_ms for the first call (cold load)", async () => {
		const { mgr, child } = makeManager({ startup_timeout_ms: 500, scan_timeout_ms: 50 });
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();

		// Less than startup budget but more than scan budget — should still be pending.
		await vi.advanceTimersByTimeAsync(200);
		child.respond({ id: JSON.parse(nonNull(child.stdinLines[0])).id, ok: true });
		const resp = await p;
		expect(resp.ok).toBe(true);
	});

	it("uses scan_timeout_ms for subsequent calls after first response", async () => {
		const { mgr, child } = makeManager({ startup_timeout_ms: 500, scan_timeout_ms: 100 });
		// First (warm-up) call completes fast.
		const p1 = mgr.send({ op: "ping" });
		await Promise.resolve();
		child.respond({ id: JSON.parse(nonNull(child.stdinLines[0])).id, ok: true });
		await p1;

		// Second call — no response; should time out at scan_timeout_ms.
		const p2 = mgr.send({ op: "scan", text: "x" });
		await vi.advanceTimersByTimeAsync(101);
		const resp = await p2;
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("timeout after 100ms");
	});

	it("aborts on AbortSignal", async () => {
		const { mgr } = makeManager();
		const controller = new AbortController();
		const p = mgr.send({ op: "scan", text: "x", signal: controller.signal });
		await Promise.resolve();
		controller.abort();
		const resp = await p;
		expect(resp.ok).toBe(false);
		expect(resp.error).toBe("aborted");
	});
});

describe("SidecarManager — crash handling", () => {
	it("rejects all pending with error when the child exits unexpectedly", async () => {
		const { mgr, child } = makeManager();
		const p1 = mgr.send({ op: "scan", text: "a" });
		const p2 = mgr.send({ op: "scan", text: "b" });
		await Promise.resolve();

		child.exit(1);
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1.ok).toBe(false);
		expect(r1.error).toContain("exited with code 1");
		expect(r2.ok).toBe(false);
	});

	it("reports a null exit code in the dormant status detail", async () => {
		const { mgr, child } = makeManager();
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		child.exit(null);
		await p;
		expect(mgr.getStatus()).toMatchObject({
			state: "dormant",
			detail: "child exited (code=null)",
			pid: undefined,
		});
	});

	it("honors max_restarts when the child keeps dying", async () => {
		// Build a spawn function that always returns a dying child.
		const spawn = vi.fn(() => {
			const c = makeFakeChild();
			queueMicrotask(() => c.exit(1));
			return c;
		});
		const mgr = new SidecarManager({ ...makeOpts(), spawn, max_restarts: 2 });

		// First two calls — each triggers a spawn (child dies instantly).
		const r1 = await mgr.send({ op: "ping" });
		expect(r1.ok).toBe(false);
		const r2 = await mgr.send({ op: "ping" });
		expect(r2.ok).toBe(false);

		// Third call should fail-open with "exceeded max_restarts" — no spawn attempt.
		const r3 = await mgr.send({ op: "ping" });
		expect(r3.ok).toBe(false);
		expect(r3.error).toContain("exceeded max_restarts");
		expect(mgr.getStatus()).toMatchObject({
			state: "disabled",
			detail: "exceeded max_restarts (2)",
		});
		expect(spawn).toHaveBeenCalledTimes(2);
	});
});

describe("SidecarManager — shutdown", () => {
	it("sends a shutdown request and force-kills after the grace window", async () => {
		const { mgr, child } = makeManager();
		// Kick off a send to force spawn. Don't await — fake timers won't resolve it.
		void mgr.send({ op: "ping" });
		await Promise.resolve();
		expect(child.stdinLines.length).toBeGreaterThan(0);

		const p = mgr.shutdown();
		// After 1s (force-kill timer), we expect SIGKILL.
		await vi.advanceTimersByTimeAsync(1100);
		await p;
		expect(child.killed).toBe(true);
		expect(child.killSignals).toEqual(["SIGKILL"]);
		expect(JSON.parse(nonNull(child.stdinLines.at(-1)))).toEqual({
			id: "shutdown",
			op: "shutdown",
		});
	});

	it("resolves immediately when the child exits during graceful shutdown", async () => {
		const { mgr, child } = makeManager();
		const pending = mgr.send({ op: "ping" });
		await Promise.resolve();

		const shutdown = mgr.shutdown();
		child.exit(0);
		await shutdown;
		expect(child.killSignals).toEqual([]);
		expect(await pending).toEqual({ ok: false, error: "sidecar exited with code 0" });
	});

	it("returns {ok:false} when called while shutting down", async () => {
		const { mgr, child } = makeManager();
		void mgr.send({ op: "ping" });
		await Promise.resolve();

		const shutdownPromise = mgr.shutdown();
		const r = await mgr.send({ op: "ping" });
		expect(r.ok).toBe(false);
		expect(r.error).toContain("shutting down");
		// Clean up the in-flight shutdown.
		child.exit(0);
		await vi.advanceTimersByTimeAsync(1100);
		await shutdownPromise;
	});
});

describe("SidecarManager — write/spawn failure paths", () => {
	it("resolves failResponse when stdin.write throws (Error)", async () => {
		const { mgr, child } = makeManager();
		// Force the write to throw synchronously.
		child.stdin.write = () => {
			throw new Error("EPIPE");
		};
		const resp = await mgr.send({ op: "ping" });
		expect(resp).toEqual({ ok: false, error: "write failed: EPIPE" });
	});

	it("resolves failResponse when stdin.write throws a non-Error value", async () => {
		const { mgr, child } = makeManager();
		child.stdin.write = () => {
			// Exercising formatErr's non-Error branch.
			throw "boom";
		};
		const resp = await mgr.send({ op: "ping" });
		expect(resp).toEqual({ ok: false, error: "write failed: boom" });
	});

	it("resolves failResponse when spawnFn throws synchronously, and disables after max_restarts", async () => {
		const spawn = vi.fn(() => {
			throw new Error("no python3 on PATH");
		});
		const mgr = new SidecarManager({ ...makeOpts(), spawn, max_restarts: 3 });
		const resp = await mgr.send({ op: "ping" });
		expect(resp).toEqual({ ok: false, error: "sidecar spawn failed: no python3 on PATH" });
		expect(mgr.getStatus().state).toBe("disabled");
		expect(mgr.getStatus().detail).toBe("spawn failed: no python3 on PATH");
	});
});

describe("SidecarManager — child error event", () => {
	it("rejects pending and goes dormant (not disposed) on a child 'error' event", async () => {
		const { mgr, child } = makeManager();
		const p = mgr.send({ op: "scan", text: "x" });
		await Promise.resolve();

		child.emit("error", new Error("ECONNRESET"));
		const resp = await p;
		expect(resp).toEqual({ ok: false, error: "sidecar error: ECONNRESET" });
		expect(mgr.getStatus().state).toBe("dormant");
		expect(mgr.getStatus().detail).toBe("child error: ECONNRESET");
	});

	it("stays disposed (no dormant transition) when a child 'error' fires after shutdown", async () => {
		const { mgr, child } = makeManager();
		void mgr.send({ op: "ping" });
		await Promise.resolve();

		const shutdownPromise = mgr.shutdown();
		child.emit("error", new Error("late error"));
		child.exit(0);
		await vi.advanceTimersByTimeAsync(1100);
		await shutdownPromise;
		expect(mgr.getStatus().state).toBe("disabled");
	});
});

describe("SidecarManager — optional child streams", () => {
	it("keeps the request alive when stdout is absent", async () => {
		const { mgr, child } = makeManager({ startup_timeout_ms: 25 });
		Reflect.set(child, "stdout", undefined);
		const p = mgr.send({ op: "ping" });
		await vi.advanceTimersByTimeAsync(26);
		expect(await p).toEqual({ ok: false, error: "timeout after 25ms" });
	});

	it("keeps the request alive when stderr is absent", async () => {
		const { mgr, child } = makeManager({ startup_timeout_ms: 25 });
		Reflect.set(child, "stderr", undefined);
		const p = mgr.send({ op: "ping" });
		await vi.advanceTimersByTimeAsync(26);
		expect(await p).toEqual({ ok: false, error: "timeout after 25ms" });
	});

	it("keeps the request alive when stdin is absent", async () => {
		const { mgr, child } = makeManager({ startup_timeout_ms: 25 });
		Reflect.set(child, "stdin", undefined);
		const p = mgr.send({ op: "ping" });
		await vi.advanceTimersByTimeAsync(26);
		expect(await p).toEqual({ ok: false, error: "timeout after 25ms" });
	});
});

describe("SidecarManager — malformed/edge protocol lines", () => {
	it("silently drops a malformed JSON line and still delivers the next valid line", async () => {
		const { mgr, child } = makeManager();
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		const sent = JSON.parse(nonNull(child.stdinLines[0]));

		child.stdout.write("{not valid json\n");
		child.respond({ id: sent.id, ok: true });
		const resp = await p;
		expect(resp.ok).toBe(true);
	});

	it("ignores a blank line in the stdout stream", async () => {
		const { mgr, child } = makeManager();
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		const sent = JSON.parse(nonNull(child.stdinLines[0]));

		child.stdout.write("\n");
		child.respond({ id: sent.id, ok: true });
		const resp = await p;
		expect(resp.ok).toBe(true);
	});

	it("drops a parsed line that is not a record (e.g. a JSON array)", async () => {
		const { mgr, child } = makeManager();
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		const sent = JSON.parse(nonNull(child.stdinLines[0]));

		child.stdout.write("[1,2,3]\n");
		child.respond({ id: sent.id, ok: true });
		const resp = await p;
		expect(resp.ok).toBe(true);
	});

	it("drops a parsed line that is a bare primitive (JSON null)", async () => {
		const { mgr, child } = makeManager();
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		const sent = JSON.parse(nonNull(child.stdinLines[0]));

		child.stdout.write("null\n");
		child.respond({ id: sent.id, ok: true });
		const resp = await p;
		expect(resp.ok).toBe(true);
	});

	it("drops a parsed string primitive before processing the next response", async () => {
		const { mgr, child } = makeManager();
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		const id = JSON.parse(nonNull(child.stdinLines[0])).id;

		child.stdout.write('"startup noise"\n');
		child.respond({ id, ok: true });
		expect(await p).toMatchObject({ ok: true });
	});

	it("passes through a string error field from the sidecar response", async () => {
		const { mgr, child } = makeManager();
		const p = mgr.send({ op: "scan", text: "x" });
		await Promise.resolve();
		const sent = JSON.parse(nonNull(child.stdinLines[0]));

		child.respond({ id: sent.id, ok: false, error: "python trace: ValueError" });
		const resp = await p;
		expect(resp).toEqual({
			ok: false,
			error: "python trace: ValueError",
			spans: undefined,
			redacted_text: undefined,
		});
	});

	it("drops a response with no id field", async () => {
		const { mgr, child } = makeManager();
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		const sent = JSON.parse(nonNull(child.stdinLines[0]));

		child.respond({ ok: true }); // no id — startup noise
		child.respond({ id: sent.id, ok: true });
		const resp = await p;
		expect(resp.ok).toBe(true);
	});

	it("drops a response whose id has no matching pending entry", async () => {
		const { mgr, child } = makeManager();
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		const sent = JSON.parse(nonNull(child.stdinLines[0]));

		child.respond({ id: "unknown-id", ok: true });
		child.respond({ id: sent.id, ok: true });
		const resp = await p;
		expect(resp.ok).toBe(true);
	});

	it("defaults error to undefined when the response's error field is not a string", async () => {
		const { mgr, child } = makeManager();
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		const sent = JSON.parse(nonNull(child.stdinLines[0]));

		child.respond({ id: sent.id, ok: false, error: 42 });
		const resp = await p;
		expect(resp).toEqual({ ok: false, error: undefined, spans: undefined, redacted_text: undefined });
	});

	it("defaults redacted_text to undefined when the response field is not a string", async () => {
		const { mgr, child } = makeManager();
		const p = mgr.send({ op: "scan", text: "x" });
		await Promise.resolve();
		const id = JSON.parse(nonNull(child.stdinLines[0])).id;

		child.respond({ id, ok: true, redacted_text: 123 });
		expect(await p).toEqual({
			ok: true,
			error: undefined,
			spans: undefined,
			redacted_text: undefined,
		});
	});

	it("splits multiple newline-delimited responses from one stdout chunk", async () => {
		const { mgr, child } = makeManager();
		const p1 = mgr.send({ op: "ping" });
		const p2 = mgr.send({ op: "ping" });
		await Promise.resolve();
		const [first, second] = child.stdinLines.map((line) => JSON.parse(line));

		child.stdout.write(`${JSON.stringify({ id: first.id, ok: true })}\n${JSON.stringify({ id: second.id, ok: true })}\n`);
		expect((await p1).ok).toBe(true);
		expect((await p2).ok).toBe(true);
	});
});

describe("SidecarManager — late timeout/abort races", () => {
	it("does not double-resolve when the timeout timer fires after the response already arrived", async () => {
		const { mgr, child } = makeManager({ scan_timeout_ms: 100 });
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		const sent = JSON.parse(nonNull(child.stdinLines[0]));

		child.respond({ id: sent.id, ok: true });
		const resp = await p;
		expect(resp.ok).toBe(true);

		// The (already-cleared) timer's callback body still runs under fake timers
		// only if not cleared — here we assert no crash / no second resolution by
		// advancing well past the original timeout window.
		await vi.advanceTimersByTimeAsync(1000);
		expect(resp.ok).toBe(true);
	});

	it("does not throw when abort fires after the response already arrived", async () => {
		const { mgr, child } = makeManager();
		const controller = new AbortController();
		const p = mgr.send({ op: "scan", text: "x", signal: controller.signal });
		await Promise.resolve();
		const sent = JSON.parse(nonNull(child.stdinLines[0]));

		child.respond({ id: sent.id, ok: true });
		const resp = await p;
		expect(resp.ok).toBe(true);

		// Fires the abort listener's "entry not found" branch — must not throw.
		expect(() => controller.abort()).not.toThrow();
	});

	it("removes the abort listener when a response settles the request", async () => {
		const { mgr, child } = makeManager();
		const controller = new AbortController();
		const add = vi.spyOn(controller.signal, "addEventListener");
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const p = mgr.send({ op: "scan", text: "x", signal: controller.signal });
		await Promise.resolve();
		const id = JSON.parse(nonNull(child.stdinLines[0])).id;

		child.respond({ id, ok: true });
		await p;
		expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
		const listener = add.mock.calls[0]?.[1];
		expect(remove).toHaveBeenCalledWith("abort", listener);
	});
});

describe("SidecarManager — idle close after crash leaves no child to close", () => {
	it("closeChildForIdle no-ops when the child already crashed to null before the idle timer fires", async () => {
		const { mgr, child } = makeManager({ idle_shutdown_ms: 5000 });
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		child.respond({ id: JSON.parse(nonNull(child.stdinLines[0])).id, ok: true });
		await p;

		// Crash the child directly (sets this.child = null) without clearing the
		// idle timer that was armed by the successful send().
		child.exit(1);
		await Promise.resolve();
		expect(mgr.getStatus().state).toBe("dormant");

		// The idle timer still fires — closeChildForIdle must no-op (no child).
		await expect(vi.advanceTimersByTimeAsync(5000)).resolves.not.toThrow();
	});
});

describe("SidecarManager — status sinceIso stability", () => {
	it("keeps the same sinceIso when setStatus patches without changing state", async () => {
		const { mgr, child } = makeManager();
		void mgr.send({ op: "ping" });
		await Promise.resolve();

		const firstShutdown = mgr.shutdown();
		await vi.advanceTimersByTimeAsync(1100);
		await firstShutdown;
		const sinceAfterFirst = mgr.getStatus().sinceIso;

		// Second shutdown() call: state is already "disabled" — setStatus patches
		// with the same state, so sinceIso must be left untouched.
		const secondShutdown = mgr.shutdown();
		await secondShutdown;
		expect(mgr.getStatus().sinceIso).toBe(sinceAfterFirst);
		void child;
	});

	it("updates sinceIso whenever the lifecycle state changes", async () => {
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const { mgr, child } = makeManager();
		const initial = mgr.getStatus().sinceIso;

		vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		const spawning = mgr.getStatus().sinceIso;
		expect(spawning).toBe("2026-01-01T00:00:01.000Z");
		expect(spawning).not.toBe(initial);

		vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
		child.respond({ id: JSON.parse(nonNull(child.stdinLines[0])).id, ok: true });
		await p;
		expect(mgr.getStatus().sinceIso).toBe("2026-01-01T00:00:02.000Z");
	});
});

describe("SidecarManager — default stderr sink", () => {
	it("writes to process.stderr with the [opf-sidecar] prefix when no stderrSink override is given", async () => {
		const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const child = makeFakeChild();
			const spawn = vi.fn<SpawnFn>(() => child);
			const mgr = new SidecarManager({
				python_bin: "python3",
				script_path: "/tmp/fake-sidecar.py",
				startup_timeout_ms: 500,
				scan_timeout_ms: 100,
				idle_shutdown_ms: 10_000,
				max_restarts: 3,
				spawn,
				// no stderrSink override — exercises defaultStderrSink
			});
			void mgr.send({ op: "ping" });
			await Promise.resolve();
			child.stderr.write("model load warning\n");
			await Promise.resolve();
			expect(writeSpy).toHaveBeenCalledWith("[opf-sidecar] model load warning\n");
		} finally {
			writeSpy.mockRestore();
		}
	});
});

describe("SidecarManager — default spawn function", () => {
	it("falls back to node:child_process.spawn when no spawn override is given", async () => {
		vi.useRealTimers();
		try {
			const mgr = new SidecarManager({
				python_bin: process.execPath,
				script_path: "-e",
				script_args: ["process.exit(0)"],
				startup_timeout_ms: 5000,
				scan_timeout_ms: 5000,
				idle_shutdown_ms: 60_000,
				max_restarts: 1,
				stderrSink: () => {},
			});
			const resp = await mgr.send({ op: "ping" });
			expect(resp).toEqual({ ok: false, error: "sidecar exited with code 0" });
			await mgr.shutdown();
		} finally {
			vi.useFakeTimers();
		}
	}, 10_000);
});

describe("SidecarManager — idle recovery", () => {
	// Regression for the bug where idle-timer close permanently bricked the
	// scanner (shuttingDown latched true). Next send() must respawn.
	it("goes dormant on idle, respawns on next send", async () => {
		const child1 = makeFakeChild();
		const child2 = makeFakeChild();
		const children = [child1, child2];
		const spawn = vi.fn(() => {
			const c = children.shift();
			if (!c) throw new Error("no more fake children");
			return c;
		});
		const mgr = new SidecarManager({ ...makeOpts(), spawn, idle_shutdown_ms: 5000 });

		// First send boots the sidecar.
		const p1 = mgr.send({ op: "ping" });
		await Promise.resolve();
		child1.respond({ id: JSON.parse(nonNull(child1.stdinLines[0])).id, ok: true });
		expect((await p1).ok).toBe(true);
		expect(mgr.getStatus().state).toBe("ready");

		// Fire idle timer — child closes but instance stays recoverable.
		await vi.advanceTimersByTimeAsync(5000);
		expect(JSON.parse(nonNull(child1.stdinLines.at(-1)))).toEqual({
			id: "idle-shutdown",
			op: "shutdown",
		});
		// closeChildForIdle writes a shutdown frame + SIGKILL grace.
		await vi.advanceTimersByTimeAsync(1100);
		expect(child1.killSignals).toContain("SIGKILL");
		child1.exit(0);
		await Promise.resolve();
		expect(mgr.getStatus().state).toBe("dormant");

		// Next send triggers a fresh spawn.
		const p2 = mgr.send({ op: "ping" });
		await Promise.resolve();
		expect(spawn).toHaveBeenCalledTimes(2);
		child2.respond({ id: JSON.parse(nonNull(child2.stdinLines[0])).id, ok: true });
		expect((await p2).ok).toBe(true);
		expect(mgr.getStatus().state).toBe("ready");
	});

	it("resets the idle deadline after each request", async () => {
		const { mgr, child } = makeManager({ idle_shutdown_ms: 1000 });
		const first = mgr.send({ op: "ping" });
		await Promise.resolve();
		child.respond({ id: JSON.parse(nonNull(child.stdinLines[0])).id, ok: true });
		await first;

		await vi.advanceTimersByTimeAsync(900);
		const second = mgr.send({ op: "ping" });
		await Promise.resolve();
		child.respond({ id: JSON.parse(nonNull(child.stdinLines[1])).id, ok: true });
		await second;

		// The original timer would have fired at t=1000; the second request
		// moved the deadline to t=1900, so the child must still be alive here.
		await vi.advanceTimersByTimeAsync(101);
		expect(child.killSignals).toEqual([]);
		await vi.advanceTimersByTimeAsync(899);
		expect(child.stdinLines.map((line) => JSON.parse(line))).toContainEqual({
			id: "idle-shutdown",
			op: "shutdown",
		});
	});

	it("does not idle-close a child after explicit shutdown has begun", async () => {
		const { mgr, child } = makeManager({ idle_shutdown_ms: 100 });
		const ping = mgr.send({ op: "ping" });
		await Promise.resolve();
		child.respond({ id: JSON.parse(nonNull(child.stdinLines[0])).id, ok: true });
		await ping;

		const shutdown = mgr.shutdown();
		const linesAfterShutdown = child.stdinLines.length;
		await vi.advanceTimersByTimeAsync(100);
		expect(child.stdinLines).toHaveLength(linesAfterShutdown);
		expect(child.killSignals).toEqual([]);

		child.exit(0);
		await shutdown;
	});

	it("uses the startup timeout after an idle respawn", async () => {
		const child1 = makeFakeChild();
		const child2 = makeFakeChild();
		const children = [child1, child2];
		const spawn = vi.fn(() => {
			const child = children.shift();
			if (!child) throw new Error("no more fake children");
			return child;
		});
		const mgr = new SidecarManager({
			...makeOpts(),
			spawn,
			startup_timeout_ms: 500,
			scan_timeout_ms: 100,
			idle_shutdown_ms: 5000,
		});

		const first = mgr.send({ op: "ping" });
		await Promise.resolve();
		child1.respond({ id: JSON.parse(nonNull(child1.stdinLines[0])).id, ok: true });
		await first;
		await vi.advanceTimersByTimeAsync(6100);
		child1.exit(0);
		await Promise.resolve();

		const second = mgr.send({ op: "ping" });
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(200);
		// A respawn is cold again, so it must still be waiting after the warm
		// scan timeout has elapsed.
		let settled = false;
		void second.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(300);
		expect(await second).toEqual({ ok: false, error: "timeout after 500ms" });
	});

	it("resets restartCount on first successful response so long sessions never exhaust the budget", async () => {
		const child1 = makeFakeChild();
		const child2 = makeFakeChild();
		const child3 = makeFakeChild();
		const children = [child1, child2, child3];
		const spawn = vi.fn(() => {
			const c = children.shift();
			if (!c) throw new Error("no more fake children");
			return c;
		});
		const mgr = new SidecarManager({ ...makeOpts(), spawn, max_restarts: 2, idle_shutdown_ms: 5000 });

		// Cycle boot → idle → respawn → idle → respawn → each "ready" must clear
		// the restart counter, so three cycles in a row don't trip max_restarts=2.
		for (const child of [child1, child2, child3]) {
			const p = mgr.send({ op: "ping" });
			await Promise.resolve();
			child.respond({ id: JSON.parse(nonNull(child.stdinLines[0])).id, ok: true });
			expect((await p).ok).toBe(true);
			expect(mgr.getStatus().restartCount).toBe(0);
			// Fire idle close.
			await vi.advanceTimersByTimeAsync(5000);
			await vi.advanceTimersByTimeAsync(1100);
			child.exit(0);
			await Promise.resolve();
		}
		expect(spawn).toHaveBeenCalledTimes(3);
	});

	it("fires onStatusChange on every lifecycle transition", async () => {
		const statuses: string[] = [];
		const child = makeFakeChild();
		const spawn = vi.fn<SpawnFn>(() => child);
		const mgr = new SidecarManager({
			...makeOpts(),
			spawn,
			onStatusChange: (s) => statuses.push(s.state),
		});

		// Constructor fires "idle".
		expect(statuses[0]).toBe("idle");

		const p = mgr.send({ op: "ping" });
		await Promise.resolve();
		expect(statuses).toContain("spawning");

		child.respond({ id: JSON.parse(nonNull(child.stdinLines[0])).id, ok: true });
		await p;
		expect(statuses).toContain("ready");

		const readyCountAfterFirstResponse = statuses.filter((state) => state === "ready").length;
		const second = mgr.send({ op: "ping" });
		await Promise.resolve();
		child.respond({ id: JSON.parse(nonNull(child.stdinLines[1])).id, ok: true });
		await second;
		expect(statuses.filter((state) => state === "ready")).toHaveLength(readyCountAfterFirstResponse);

		// shutdown() awaits a 1s force-kill race; under fake timers we must
		// advance past the grace window (or exit the child) for it to resolve.
		const done = mgr.shutdown();
		await vi.advanceTimersByTimeAsync(1100);
		await done;
		expect(statuses).toContain("disabled");
	});
});
