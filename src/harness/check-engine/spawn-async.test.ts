import { makeFakeChild } from "./test-child-process.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProcessAsync } from "./spawn-async.js";

// Partial mock: default behavior delegates to the real `spawn` (so every
// existing real-binary test below is unaffected), but individual tests can
// swap in a fully-controllable fake child via `mockImplementationOnce` to
// drive the signal-delivery error paths that real subprocesses can't
// reliably trigger on demand (missing pid, process.kill throwing, a
// SIGKILL-grace timer still pending when 'error' fires before 'exit').
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { spawn } from "node:child_process";

/** A minimal EventEmitter-based stand-in for a Node ChildProcess, controllable
 *  enough to drive signalTree's undefined-pid / throwing-kill branches and to
 *  fire 'error' independently of 'exit'/'close'. */

describe("runProcessAsync", () => {
	afterEach(() => {
		vi.mocked(spawn).mockClear();
	});

	it("captures stdout from a successful process", async () => {
		const r = await runProcessAsync("/bin/echo", ["hello"], { timeout: 5000 });
		expect(r.stdout).toContain("hello");
		expect(r.code).toBe(0);
		expect(r.timedOut).toBe(false);
	});

	it("captures stderr separately from stdout", async () => {
		// `sh -c 'echo out; echo err 1>&2'` writes to both
		const r = await runProcessAsync("/bin/sh", ["-c", "echo out; echo err 1>&2"], {
			timeout: 5000,
		});
		expect(r.stdout).toContain("out");
		expect(r.stderr).toContain("err");
	});

	it("propagates non-zero exit code", async () => {
		const r = await runProcessAsync("/bin/sh", ["-c", "exit 7"], { timeout: 5000 });
		expect(r.code).toBe(7);
	});

	it("returns timedOut=true when the process exceeds the timeout", async () => {
		const r = await runProcessAsync("/bin/sh", ["-c", "sleep 5"], { timeout: 100 });
		expect(r.timedOut).toBe(true);
		expect(r.killed).toBe(true);
	});

	it("does not throw on a missing binary — returns code !== 0", async () => {
		const r = await runProcessAsync("/nonexistent/binary-xyz", ["arg"], { timeout: 1000 });
		// On macOS, ENOENT manifests as code === null (process never ran).
		// We capture that via a sentinel rather than throwing.
		expect(r.code).not.toBe(0);
	});

	it("cancels pending timeout/kill timers once the child exits (no signal after reap)", async () => {
		// A process that finishes well within its timeout must report killed=false:
		// the 'exit' handler cancels the timeout + SIGKILL-grace timers so nothing
		// can signal the child's (now potentially OS-recycled) pid after it is reaped
		// — closing the `process.kill(-pid)`-hits-the-wrong-group window.
		const r = await runProcessAsync("/bin/sh", ["-c", "exit 0"], { timeout: 5000 });
		expect(r.killed).toBe(false);
		expect(r.timedOut).toBe(false);
		expect(r.code).toBe(0);
	});

	it("uses the default 30s timeout when none is given", async () => {
		const r = await runProcessAsync("/bin/echo", ["hi"]);
		expect(r.stdout).toContain("hi");
		expect(r.timedOut).toBe(false);
	});

	it("merges opts.env on top of process.env", async () => {
		const r = await runProcessAsync("/bin/sh", ["-c", "echo $SPAWN_ASYNC_TEST_VAR"], {
			timeout: 5000,
			env: { SPAWN_ASYNC_TEST_VAR: "custom-value" },
		});
		expect(r.stdout).toContain("custom-value");
	});

	it("kills an already-aborted signal immediately (aborted:true at call time)", async () => {
		const controller = new AbortController();
		controller.abort();
		const r = await runProcessAsync("/bin/sh", ["-c", "sleep 5"], {
			timeout: 30_000,
			signal: controller.signal,
		});
		expect(r.killed).toBe(true);
	});

	it("escalates to SIGKILL after the grace period when the process ignores SIGTERM", async () => {
		// `trap '' TERM` makes the shell ignore SIGTERM, forcing the timeout path
		// through the full SIGKILL_GRACE_MS window before the process actually dies.
		const start = Date.now();
		const r = await runProcessAsync("/bin/sh", ["-c", "trap '' TERM; sleep 10"], {
			timeout: 100,
		});
		expect(r.timedOut).toBe(true);
		expect(r.killed).toBe(true);
		expect(Date.now() - start).toBeGreaterThanOrEqual(1000);
	}, 10_000);

	it("respects an external AbortSignal", async () => {
		const controller = new AbortController();
		const promise = runProcessAsync("/bin/sh", ["-c", "sleep 5"], {
			timeout: 30_000,
			signal: controller.signal,
		});
		// Abort after a tick.
		setTimeout(() => controller.abort(), 50);
		const r = await promise;
		expect(r.killed).toBe(true);
	});

	it("truncates stdout at MAX_BUFFER_BYTES instead of buffering unbounded output", async () => {
		// Print well past the 10 MB cap so the byte-count guard in the 'data'
		// listener actually engages and further chunks are dropped.
		const r = await runProcessAsync(
			"/bin/sh",
			["-c", "yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | head -c 11000000"],
			{ timeout: 15_000 },
		);
		expect(r.stdout.length).toBeLessThan(11_000_000);
		expect(r.code).toBe(0);
	}, 20_000);

	it("truncates stderr at MAX_BUFFER_BYTES instead of buffering unbounded output", async () => {
		const r = await runProcessAsync(
			"/bin/sh",
			["-c", "yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | head -c 11000000 1>&2"],
			{ timeout: 15_000 },
		);
		expect(r.stderr.length).toBeLessThan(11_000_000);
		expect(r.code).toBe(0);
	}, 20_000);

	it("resolves via the close-guard fallback with code=null when the process self-signals and a re-parented grandchild holds the pipe", async () => {
		// `kill -TERM $$` (no leading '-') signals only the script's own pid, not
		// its process group — so it never touches the `sleep` backgrounded from
		// a subshell, which keeps running (re-parented) holding the inherited
		// stdout fd. `exit` reports code=null (died from a signal, not us — we
		// never call killTree here: killed/timedOut stay false); 'close' is
		// delayed by the surviving grandchild, forcing the 250ms close-guard
		// fallback to take the null-code branch.
		const r = await runProcessAsync("/bin/sh", ["-c", "(sleep 5 &) ; kill -TERM $$"], {
			timeout: 30_000,
		});
		expect(r.timedOut).toBe(false);
		expect(r.killed).toBe(false);
		expect(r.code).toBeNull();
	}, 10_000);

	it("resolves promptly after the child exits even if a backgrounded grandchild holds the stdio pipe", async () => {
		// `sh` exits 0 immediately, but the backgrounded `sleep` inherits the
		// stdout pipe and keeps it OPEN — so 'close' (stdio EOF) is delayed until
		// the grandchild exits. Resolving only on 'close' let a grandchild that
		// escaped the process-group kill wedge the call — and any awaiting vitest
		// worker / daemon — indefinitely (Linux + parallel batches; finding
		// 2026-06: a 25-min CI deadlock). We must resolve shortly after exit, not
		// wait the full 3 s for the orphaned grandchild.
		const start = Date.now();
		const r = await runProcessAsync("/bin/sh", ["-c", "sleep 3 & exit 0"], { timeout: 30_000 });
		expect(r.code).toBe(0);
		expect(Date.now() - start).toBeLessThan(2000);
	}, 10_000);

	it("falls back to child.kill() in signalTree when the child has no pid", async () => {
		// A spawn failure that never assigned a pid (ENOENT detected before the
		// group-signal path has anything to target) must still deliver the
		// signal via the direct child.kill() fallback rather than throwing.
		const fakeChild = makeFakeChild(undefined);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const controller = new AbortController();
		controller.abort();
		const promise = runProcessAsync("fake-cmd", [], { signal: controller.signal, timeout: 30_000 });
		// The abort-at-call-time path runs killTree() synchronously inside the
		// Promise executor, before this line — so the fallback has already fired.
		expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
		fakeChild.emit("exit", 0);
		fakeChild.emit("close", 0);
		const r = await promise;
		expect(r.killed).toBe(true);
	});

	it("falls back to child.kill() when signalling the process group throws", async () => {
		// A pid whose process group no longer exists makes process.kill(-pid,…)
		// throw ESRCH; signalTree must swallow it and retry via child.kill()
		// rather than letting the exception escape the executor.
		const fakeChild = makeFakeChild(999_999_999);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const controller = new AbortController();
		controller.abort();
		const promise = runProcessAsync("fake-cmd", [], { signal: controller.signal, timeout: 30_000 });
		expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
		fakeChild.emit("exit", 0);
		fakeChild.emit("close", 0);
		const r = await promise;
		expect(r.killed).toBe(true);
	});

	it("swallows the error when both the group signal and child.kill() fail", async () => {
		// Both fallback layers can fail (e.g. the child was reaped between the
		// group-signal attempt and the direct one) — signalTree must not throw
		// out of the executor even then.
		const fakeChild = makeFakeChild(999_999_998);
		fakeChild.kill = vi.fn(() => {
			throw new Error("ESRCH");
		});
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const controller = new AbortController();
		controller.abort();
		const promise = runProcessAsync("fake-cmd", [], { signal: controller.signal, timeout: 30_000 });
		expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
		fakeChild.emit("exit", 0);
		fakeChild.emit("close", 0);
		const r = await promise;
		expect(r.killed).toBe(true);
	});

	it("clears a pending SIGKILL-grace timer when the child errors before exiting", async () => {
		// If 'error' fires (e.g. the kill itself later fails asynchronously)
		// while a SIGKILL-grace timer is still armed from an earlier timeout,
		// finalize() must clear that pending timer itself — 'exit' never ran to
		// do it first. Without this, a stray SIGKILL could later signal a
		// recycled pid, and the grace timer would keep the daemon's event loop
		// alive for up to SIGKILL_GRACE_MS after resolution.
		const fakeChild = makeFakeChild(999_999_997);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const promise = runProcessAsync("fake-cmd", [], { timeout: 10 });
		// Let the timeout timer fire and call killTree(), arming the grace timer.
		await new Promise((r) => setTimeout(r, 50));
		expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
		// 'error' resolves via finalize() directly — not through the 'exit'
		// handler that would otherwise have cleared the grace timer first.
		fakeChild.emit("error", new Error("boom"));
		const r = await promise;
		expect(r.code).toBeNull();
		expect(r.timedOut).toBe(true);
	});
});
