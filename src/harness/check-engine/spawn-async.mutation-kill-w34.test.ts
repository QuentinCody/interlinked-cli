import { makeFakeChild, makeFakeChildWithoutStreams } from "./test-child-process.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProcessAsync } from "./spawn-async.js";

// Mirrors spawn-async.test.ts's mock: default spawn delegates to the real
// implementation, but each test below swaps in a fully-controllable fake
// child via `mockImplementationOnce` to drive branches that a real
// subprocess can't reliably hit on demand (undefined pid, a throwing
// process.kill, a missing `unref`, exact byte-boundary buffering, etc).
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { spawn } from "node:child_process";

/** Source's SIGKILL_GRACE_MS is not exported; mirrored here (see spawn-async.ts). */
const SIGKILL_GRACE_MS = 1000;


describe("runProcessAsync — mutation-kill w34", () => {
	afterEach(() => {
		vi.mocked(spawn).mockClear();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	// test-contract: mutation-kill — kills 1b4373bf5bc85ec0/f68ab8f27c51be34 (StringLiteral
	// '""' -> "Stryker was here!" on the stdout/stderr accumulator seeds).
	it("starts stdout and stderr as exactly empty strings when no data ever arrives", async () => {
		const fakeChild = makeFakeChild(1);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const promise = runProcessAsync("fake-cmd", [], { timeout: 30_000 });
		fakeChild.emit("exit", 0);
		fakeChild.emit("close", 0);
		const r = await promise;
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("");
	});

	// test-contract: mutation-kill — kills 00af60128d7d4d05 (BooleanLiteral true->false on
	// `detached: true`); without it, signalTree's negative-pid group-kill would target the
	// daemon's own process group instead of the child's.
	it("spawns the child detached so its whole process group can be signaled", async () => {
		const fakeChild = makeFakeChild(1);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const promise = runProcessAsync("fake-cmd", ["a"], { timeout: 30_000 });
		fakeChild.emit("exit", 0);
		fakeChild.emit("close", 0);
		await promise;
		expect(vi.mocked(spawn)).toHaveBeenCalledWith(
			"fake-cmd",
			["a"],
			expect.objectContaining({ detached: true }),
		);
	});

	// test-contract: mutation-kill — kills 87c6a1abbe717d93 (ConditionalExpression
	// 'opts.signal.aborted' -> 'true'); a not-yet-aborted signal must not kill immediately.
	it("does not kill the child immediately when the signal is provided but not aborted", async () => {
		const fakeChild = makeFakeChild(undefined);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const controller = new AbortController();
		const promise = runProcessAsync("fake-cmd", [], { signal: controller.signal, timeout: 30_000 });
		expect(fakeChild.kill).not.toHaveBeenCalled();
		fakeChild.emit("exit", 0);
		fakeChild.emit("close", 0);
		const r = await promise;
		expect(r.killed).toBe(false);
	});

	// test-contract: mutation-kill — kills 2f8a929be3245100 (ObjectLiteral '{ once: true }' ->
	// '{}') and 60cc923d88703764 (BooleanLiteral true->false on the same `once` flag).
	it("registers the abort listener with {once:true} so it self-removes", async () => {
		const fakeChild = makeFakeChild(undefined);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const controller = new AbortController();
		const addSpy = vi.spyOn(controller.signal, "addEventListener");
		const promise = runProcessAsync("fake-cmd", [], { signal: controller.signal, timeout: 30_000 });
		expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
		fakeChild.emit("exit", 0);
		fakeChild.emit("close", 0);
		await promise;
	});

	// test-contract: mutation-kill — kills 612a5bd00dfec30c/66e63eaf93f2d75a (OptionalChaining
	// removed from `child.stdout?.on` / `child.stderr?.on`); without `?.`, a child spawned
	// without stdio pipes would throw synchronously instead of resolving quietly.
	it("does not throw when the spawned child has no stdout/stderr streams", async () => {
		const fakeChild = makeFakeChildWithoutStreams(1);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		expect(() => runProcessAsync("fake-cmd", [], { timeout: 30_000 })).not.toThrow();
		fakeChild.emit("exit", 0);
		fakeChild.emit("close", 0);
	});

	// test-contract: mutation-kill — kills fd021cb71e224ba8 (ConditionalExpression 'settled' ->
	// 'false') and eee5094fc74360ea (BooleanLiteral true->false on `settled = true`); together
	// they make finalize's idempotency guard a no-op, so a second settle event would re-run
	// finalize's cleanup (observable via a second removeEventListener call).
	it("finalize is idempotent — a second close event does not re-run cleanup", async () => {
		const fakeChild = makeFakeChild(55);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const controller = new AbortController();
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
		const promise = runProcessAsync("fake-cmd", [], { signal: controller.signal, timeout: 30_000 });
		fakeChild.emit("close", 0);
		fakeChild.emit("close", 1);
		const r = await promise;
		expect(r.code).toBe(0);
		expect(removeSpy).toHaveBeenCalledTimes(1);
		expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	// test-contract: mutation-kill — kills 663c866353eba7c9 (ConditionalExpression
	// 'killGraceTimer !== null' -> 'true' inside finalize); when no grace timer was ever armed,
	// finalize must not touch clearTimeout a second time.
	it("finalize does not touch clearTimeout for a grace timer that was never armed", async () => {
		const fakeChild = makeFakeChild(77);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const setSpy = vi.spyOn(global, "setTimeout");
		const clearSpy = vi.spyOn(global, "clearTimeout");
		const promise = runProcessAsync("fake-cmd", [], { timeout: 30_000 });
		fakeChild.emit("close", 0);
		const r = await promise;
		expect(r.code).toBe(0);
		expect(clearSpy).toHaveBeenCalledTimes(1);
		// The single clearTimeout call must target the deadline timer this run
		// armed (setTimeout's own return value) — not a stray/no-op id, and not
		// a second (grace-timer) clear that was never armed.
		const deadlineTimer = setSpy.mock.results[0]?.value;
		expect(clearSpy).toHaveBeenCalledWith(deadlineTimer);
	});

	// test-contract: mutation-kill — kills ebfa7cb30ee79916 (-> 'false'), bf92380bc170f2c6
	// (BlockStatement -> '{}'), and fbd074c335a652fe (EqualityOperator flipped to '===') on
	// finalize's `killGraceTimer !== null` guard; each would leave an armed SIGKILL grace timer
	// live after the promise settles, letting it fire a stray SIGKILL later.
	it("finalize clears an armed SIGKILL grace timer so nothing fires after settle", async () => {
		vi.useFakeTimers();
		const fakeChild = makeFakeChild(undefined);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const promise = runProcessAsync("fake-cmd", [], { timeout: 10 });
		await vi.advanceTimersByTimeAsync(10); // deadline fires -> killTree() arms the grace timer
		expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
		fakeChild.kill.mockClear();
		fakeChild.emit("close", 0); // settles before the grace timer would fire
		const r = await promise;
		expect(r.code).toBe(0);
		await vi.advanceTimersByTimeAsync(SIGKILL_GRACE_MS);
		expect(fakeChild.kill).not.toHaveBeenCalled();
	});

	// test-contract: mutation-kill — kills 40164259605670f8 (StringLiteral '"abort"' -> '""')
	// and 5c2272d809e765dc (ConditionalExpression 'opts.signal' -> 'false') on finalize's
	// listener cleanup.
	it("finalize removes the abort listener by its exact event name", async () => {
		const fakeChild = makeFakeChild(88);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const controller = new AbortController();
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
		const promise = runProcessAsync("fake-cmd", [], { signal: controller.signal, timeout: 30_000 });
		fakeChild.emit("close", 0);
		await promise;
		expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	// test-contract: mutation-kill — kills 8f47125649781921 (ConditionalExpression
	// 'pid !== undefined' -> 'true'); with an undefined pid, signalTree must go straight to
	// child.kill() and never attempt process.kill() at all (whose fallback catch would mask
	// the bug).
	it("never calls process.kill when the child has no pid — goes straight to child.kill", async () => {
		const fakeChild = makeFakeChild(undefined);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		const controller = new AbortController();
		controller.abort();
		const promise = runProcessAsync("fake-cmd", [], { signal: controller.signal, timeout: 30_000 });
		expect(killSpy).not.toHaveBeenCalled();
		expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
		fakeChild.emit("exit", 0);
		fakeChild.emit("close", 0);
		await promise;
	});

	// test-contract: mutation-kill — kills eba453143c42cf69 (ConditionalExpression
	// 'pid !== undefined' -> 'false'), 010f3aefcd7e180f (EqualityOperator flipped to '==='),
	// and 9c0f7992dd052d39 (UnaryOperator '-pid' -> '+pid'); with a defined pid, signalTree
	// must attempt process.kill(-pid, signal) before ever falling back to child.kill().
	it("attempts process-group signaling with the negated pid before falling back", async () => {
		const fakeChild = makeFakeChild(4242);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("ESRCH");
		});
		const controller = new AbortController();
		controller.abort();
		const promise = runProcessAsync("fake-cmd", [], { signal: controller.signal, timeout: 30_000 });
		expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
		expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
		fakeChild.emit("exit", 0);
		fakeChild.emit("close", 0);
		await promise;
	});

	// test-contract: mutation-kill — kills f968de2c75312879 (ConditionalExpression '!settled'
	// -> 'true' inside killTree's grace-period SIGKILL callback); the callback must still
	// check settled itself as a race-safety net even if the timer wasn't truly cleared.
	it("killTree's grace-period callback still checks settled before signaling SIGKILL", async () => {
		vi.useFakeTimers();
		const fakeChild = makeFakeChild(undefined);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		// Neutralize clearTimeout so the race-guard inside the callback itself — not the
		// outer clearTimeout call — is what's under test.
		vi.spyOn(global, "clearTimeout").mockImplementation(() => undefined);
		const promise = runProcessAsync("fake-cmd", [], { timeout: 10 });
		await vi.advanceTimersByTimeAsync(10); // deadline -> killTree() arms the grace timer
		fakeChild.kill.mockClear();
		fakeChild.emit("close", 0); // settles the promise without truly clearing the timer
		const r = await promise;
		expect(r.code).toBe(0);
		await vi.advanceTimersByTimeAsync(SIGKILL_GRACE_MS); // the grace timer's own callback runs
		expect(fakeChild.kill).not.toHaveBeenCalled();
	});

	// test-contract: mutation-kill — kills 695b09a523dc05d7 (EqualityOperator
	// 'stdoutBytes >= MAX_BUFFER_BYTES' -> '>'); at the exact byte boundary the cap must
	// reject, not admit, the next chunk.
	it("drops stdout data at the exact byte-cap boundary (off-by-one)", async () => {
		const fakeChild = makeFakeChild(1);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const promise = runProcessAsync("fake-cmd", [], { timeout: 30_000 });
		const capBuf = Buffer.alloc(10 * 1024 * 1024, "a");
		fakeChild.stdout.emit("data", capBuf);
		fakeChild.stdout.emit("data", Buffer.from("x"));
		fakeChild.emit("exit", 0);
		fakeChild.emit("close", 0);
		const r = await promise;
		expect(r.stdout.length).toBe(10 * 1024 * 1024);
	});

	// test-contract: mutation-kill — kills c8e4c869680b3e64 (EqualityOperator
	// 'stderrBytes >= MAX_BUFFER_BYTES' -> '>'); mirrors the stdout boundary case for stderr.
	it("drops stderr data at the exact byte-cap boundary (off-by-one)", async () => {
		const fakeChild = makeFakeChild(1);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const promise = runProcessAsync("fake-cmd", [], { timeout: 30_000 });
		const capBuf = Buffer.alloc(10 * 1024 * 1024, "a");
		fakeChild.stderr.emit("data", capBuf);
		fakeChild.stderr.emit("data", Buffer.from("x"));
		fakeChild.emit("exit", 0);
		fakeChild.emit("close", 0);
		const r = await promise;
		expect(r.stderr.length).toBe(10 * 1024 * 1024);
	});

	// test-contract: bug — a wrapper exit is not proof its compiler descendants exited;
	// project admission must remain held until the detached group itself disappears.
	it("keeps the kill grace armed after wrapper exit until the process group is gone", async () => {
		vi.useFakeTimers();
		const fakeChild = makeFakeChild(4242);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		let groupAlive = true;
		vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid === -4242 && signal === 0) {
				if (groupAlive) return true;
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			}
			return true;
		});
		const promise = runProcessAsync("fake-cmd", [], { timeout: 10 });
		await vi.advanceTimersByTimeAsync(10);
		let settled = false;
		void promise.then(() => {
			settled = true;
		});
		const clearSpy = vi.spyOn(global, "clearTimeout");
		fakeChild.emit("exit", 0);
		expect(clearSpy).not.toHaveBeenCalled();
		expect(settled).toBe(false);
		groupAlive = false;
		await vi.advanceTimersByTimeAsync(10);
		await promise;
		expect(settled).toBe(true);
		expect(clearSpy).toHaveBeenCalledTimes(2);
	});

	// test-contract: bug — a TERM-resistant descendant must still receive the
	// SIGKILL escalation even after its wrapper has already emitted `exit`.
	it("escalates the surviving process group after its wrapper exits", async () => {
		vi.useFakeTimers();
		const fakeChild = makeFakeChild(4343);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		let groupAlive = true;
		const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid === -4343 && signal === "SIGKILL") groupAlive = false;
			if (pid === -4343 && signal === 0 && !groupAlive) {
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			}
			return true;
		});
		const promise = runProcessAsync("fake-cmd", [], { timeout: 10 });
		await vi.advanceTimersByTimeAsync(10);
		fakeChild.emit("exit", 0);
		await vi.advanceTimersByTimeAsync(SIGKILL_GRACE_MS);
		expect(killSpy).toHaveBeenCalledWith(-4343, "SIGKILL");
		await vi.advanceTimersByTimeAsync(10);
		await promise;
	});

	// test-contract: bug — platforms without POSIX process-group observation
	// still need the inherited-pipe close guard after a killed wrapper exits.
	it("settles a killed no-group child through the close guard when close never arrives", async () => {
		vi.useFakeTimers();
		const fakeChild = makeFakeChild(undefined);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const promise = runProcessAsync("fake-cmd", [], { timeout: 10 });
		await vi.advanceTimersByTimeAsync(10);
		let settled = false;
		void promise.then(() => {
			settled = true;
		});
		fakeChild.emit("exit", 0);
		await vi.advanceTimersByTimeAsync(249);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await promise;
		expect(settled).toBe(true);
	});

	// test-contract: mutation-kill — kills 59231acf56a05f07 (StringLiteral '"abort"' -> '""')
	// and 4b13ba90e3bf7b02 (ConditionalExpression 'opts.signal' -> 'false') on the exit
	// handler's own abort-listener cleanup (a separate code path from finalize's).
	it("exit handler removes the abort listener by its exact event name", async () => {
		const fakeChild = makeFakeChild(undefined);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const controller = new AbortController();
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
		const promise = runProcessAsync("fake-cmd", [], { signal: controller.signal, timeout: 30_000 });
		fakeChild.emit("exit", 0);
		expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
		fakeChild.emit("close", 0);
		await promise;
	});

	// test-contract: mutation-kill — kills 5009435de3dea522 (OptionalChaining removed from
	// `closeGuard.unref?.()`); without `?.`, a timer handle lacking `unref` (e.g. a polyfilled
	// environment) would throw synchronously inside the 'exit' handler.
	it("does not throw when the closeGuard timer handle lacks an unref method", async () => {
		const fakeChild = makeFakeChild(1);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const timerFactory = new Proxy(global.setTimeout, {
			apply(target, thisArg, callArgs) {
				const handle: unknown = Reflect.apply(target, thisArg, callArgs);
				if (callArgs[1] === 250 && typeof handle === "object" && handle !== null) {
					Reflect.set(handle, "unref", undefined);
				}
				return handle;
			},
		});
		vi.spyOn(global, "setTimeout").mockImplementation(timerFactory);
		const promise = runProcessAsync("fake-cmd", [], { timeout: 30_000 });
		expect(() => fakeChild.emit("exit", 0)).not.toThrow();
		fakeChild.emit("close", 0);
		await promise;
	});

	// test-contract: mutation-kill — kills c60db83dae16711d (ConditionalExpression 'settled' ->
	// 'false' inside the closeGuard callback); once 'close' has already resolved the promise,
	// the closeGuard firing later must be a pure no-op.
	it("closeGuard is a no-op once close has already resolved the promise", async () => {
		vi.useFakeTimers();
		const fakeChild = makeFakeChild(42);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const promise = runProcessAsync("fake-cmd", [], { timeout: 30_000 });
		fakeChild.emit("exit", 0);
		fakeChild.emit("close", 0);
		const r = await promise;
		expect(r.code).toBe(0);
		await vi.advanceTimersByTimeAsync(250);
		expect(fakeChild.stdout.destroy).not.toHaveBeenCalled();
		expect(fakeChild.stderr.destroy).not.toHaveBeenCalled();
	});

	// test-contract: mutation-kill — kills 85e6069edbee35df/b6c44d4bb0fcc5f6 (OptionalChaining
	// removed from `child.stdout?.destroy` / `child.stderr?.destroy` inside closeGuard); when
	// stdio streams are absent, the guard must not throw trying to destroy them.
	it("closeGuard survives missing stdout/stderr streams without throwing", async () => {
		vi.useFakeTimers();
		const fakeChild = makeFakeChildWithoutStreams(11);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const promise = runProcessAsync("fake-cmd", [], { timeout: 30_000 });
		fakeChild.emit("exit", 3); // 'close' never fires — closeGuard must resolve it
		await vi.advanceTimersByTimeAsync(250);
		const r = await promise;
		expect(r.code).toBe(3);
	});

	// test-contract: mutation-kill — kills db6899b11f6234cd (ArithmeticOperator
	// '10*1024*1024' -> '10*1024/1024') and 9acd233ce3375f36 ('10*1024' -> '10/1024'); both
	// collapse MAX_BUFFER_BYTES to 10, which this exact-boundary buffer would expose.
	it("keeps buffering stdout well past a few bytes (guards MAX_BUFFER_BYTES's value)", async () => {
		const fakeChild = makeFakeChild(1);
		vi.mocked(spawn).mockImplementationOnce(() => fakeChild);
		const promise = runProcessAsync("fake-cmd", [], { timeout: 30_000 });
		fakeChild.stdout.emit("data", Buffer.from("0123456789")); // 10 bytes
		fakeChild.stdout.emit("data", Buffer.from("abcde")); // 5 more bytes
		fakeChild.emit("exit", 0);
		fakeChild.emit("close", 0);
		const r = await promise;
		expect(r.stdout).toBe("0123456789abcde");
	});
});
