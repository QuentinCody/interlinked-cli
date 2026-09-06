import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { createTsgoRunner, parseTsgoOutput, type TsgoRunner } from "./tsgo-runner.js";
import { WatchProcess } from "./tsgo-runner-watch.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-tsgo-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

// --- helpers for the warm-watch tests -------------------------------------

/** Minimal strict tsconfig.json so `tsgo --watch` has a project to compile. */
const TEST_TSCONFIG = JSON.stringify({
	compilerOptions: {
		noEmit: true,
		strict: true,
		module: "nodenext",
		moduleResolution: "nodenext",
		target: "es2022",
		skipLibCheck: true,
	},
	include: ["*.ts"],
});

/** Write a tsconfig.json + named .ts files into the temp dir; returns paths. */
function makeProject(files: Record<string, string>): Record<string, string> {
	writeFileSync(join(tmp, "tsconfig.json"), TEST_TSCONFIG);
	const paths: Record<string, string> = {};
	for (const [name, content] of Object.entries(files)) {
		const p = join(tmp, name);
		writeFileSync(p, content);
		paths[name] = p;
	}
	return paths;
}

/** Poll cadence for `waitFor` — one real macrotask tick between checks. */
const POLL_TICK_MS = 25;

/**
 * Wait until `pred` holds, polling on real `setTimeout` macrotask ticks.
 *
 * Deliberately NOT `vi.waitFor`: these tests assert on the warm `tsgo --watch`
 * child's idle-eviction, which is driven by an `.unref()`'d `setTimeout` inside
 * the runner. `vi.waitFor`'s retry scheduler starves an unref'd timer — it
 * never gets a turn between polls, so eviction is never observed (verified:
 * `vi.waitFor` times out at 8s while a plain `await setTimeout` sees the
 * eviction in ~300ms). A `setTimeout`-tick poll yields a genuine macrotask
 * boundary each iteration, letting the unref'd timer fire.
 *
 * It is still a deterministic-predicate poll with early exit — it resolves the
 * instant `pred()` holds and rejects on timeout — not a fixed-duration sleep.
 */
function waitFor(pred: () => boolean, budgetMs: number): Promise<void> {
	// Tick-counted bound (no wall-clock read, no division): elapsed is tracked
	// as `ticksElapsed * POLL_TICK_MS`. Deterministic relative to the poll
	// cadence — no `Date.now()` to flake on.
	return new Promise<void>((resolve, reject) => {
		let elapsedMs = 0;
		const tick = (): void => {
			if (pred()) {
				resolve();
				return;
			}
			elapsedMs += POLL_TICK_MS;
			if (elapsedMs >= budgetMs) {
				reject(new Error(`waitFor: predicate not satisfied within ${budgetMs}ms`));
				return;
			}
			setTimeout(tick, POLL_TICK_MS);
		};
		tick();
	});
}

/** Dispose a runner if it exposes the optional hook (keeps tests leak-free). */
function disposeRunner(runner: TsgoRunner): void {
	runner.dispose?.();
}

/** A real cross-platform executable that exits zero and emits no diagnostics.
 * `--` makes every compiler-shaped argument a script argument, not a Node flag. */
function createNoOutputRunner(): TsgoRunner {
	return createTsgoRunner({
		executable: process.execPath,
		extraArgs: ["-e", "", "--"],
		timeoutMs: 200,
	});
}

describe("parseTsgoOutput — form 1", () => {
	it("parses parenthesized location format", () => {
		const raw = `src/foo.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.`;
		const [diag] = parseTsgoOutput(raw, "src/foo.ts");
		expect(nonNull(diag).file).toBe("src/foo.ts");
		expect(nonNull(diag).line).toBe(12);
		expect(nonNull(diag).column).toBe(3);
		expect(nonNull(diag).severity).toBe("error");
		expect(nonNull(diag).code).toBe(2322);
		expect(nonNull(diag).message.startsWith("Type 'string'")).toBe(true);
	});
});

describe("parseTsgoOutput — form 2", () => {
	it("parses colon-colon-dash format", () => {
		const raw = `src/foo.ts:5:9 - warning TS7006: Parameter 'x' implicitly has an 'any' type.`;
		const [diag] = parseTsgoOutput(raw, "src/foo.ts");
		expect(nonNull(diag).severity).toBe("warning");
		expect(nonNull(diag).code).toBe(7006);
		expect(nonNull(diag).line).toBe(5);
	});
});

describe("parseTsgoOutput — mixed and empty", () => {
	it("returns empty for empty output", () => {
		expect(parseTsgoOutput("", "/a")).toEqual([]);
	});

	it("skips lines that don't match the diagnostic shape", () => {
		const raw = [
			"compiling project...",
			"src/a.ts(1,1): error TS1000: one.",
			"",
			"src/a.ts(2,2): error TS1001: two.",
			"Done.",
		].join("\n");
		const diags = parseTsgoOutput(raw, "/a");
		expect(diags.length).toBe(2);
	});
});

describe("createTsgoRunner — unavailable backend", () => {
	const runner = createTsgoRunner({ executable: "/nonexistent/tsgo-does-not-exist-xyz" });
	// available() returns true because we only verify existence via the
	// INTERLINKED_TSGO env var path. Spawn failures are handled gracefully
	// and return empty diagnostics. The important invariants are: never
	// throw, never hang.
	it("reports cache size from stats()", () => {
		expect(runner.stats().cache_size).toBe(0);
	});

	it("returns empty diagnostics when the file doesn't exist", async () => {
		const out = await runner.checkFile("/nonexistent/file.ts");
		expect(out.diagnostics).toEqual([]);
		expect(out.cached).toBe(false);
	});
});

describe("createTsgoRunner — caching", () => {
	it("caches results for the same file+mtime", async () => {
		// We stub the runner with a custom executable that does not exist,
		// so the check returns empty diagnostics quickly. What we care about
		// here is the caching hit/miss semantics.
		const runner = createTsgoRunner({ executable: "/bin/true", timeoutMs: 200 });
		const path = join(tmp, "a.ts");
		writeFileSync(path, "export const x: number = 1;\n");

		const first = await runner.checkFile(path);
		const second = await runner.checkFile(path);
		expect(first.cached).toBe(false);
		expect(second.cached).toBe(true);
	});

	it("invalidate() drops the cache for a path", async () => {
		const runner = createTsgoRunner({ executable: "/bin/true", timeoutMs: 200 });
		const path = join(tmp, "b.ts");
		writeFileSync(path, "export const y: number = 1;\n");

		await runner.checkFile(path);
		runner.invalidate(path);
		const again = await runner.checkFile(path);
		expect(again.cached).toBe(false);
	});
});

describe("createTsgoRunner — simulateEdit", () => {
	it("returns empty diagnostics when the file doesn't exist", async () => {
		const runner = createTsgoRunner({ executable: "/bin/true", timeoutMs: 200 });
		const out = await runner.simulateEdit("/nonexistent.ts", "x", "y");
		expect(out.new_diagnostics).toEqual([]);
	});

	it("returns empty diagnostics when old_string is absent", async () => {
		mkdirSync(tmp, { recursive: true });
		const path = join(tmp, "sim.ts");
		writeFileSync(path, "export const z = 1;\n");
		const runner = createTsgoRunner({ executable: "/bin/true", timeoutMs: 200 });
		const out = await runner.simulateEdit(path, "absent", "present");
		expect(out.new_diagnostics).toEqual([]);
	});
});

// ===========================================================================
// Warm `tsgo --watch` daemon — lazy spawn, reuse, idle eviction, crash, cold
// fallback. These tests use the real tsgo binary against tiny temp projects.
// ===========================================================================

describe("createTsgoRunner — warm watch: lazy spawn", () => {
	it("createTsgoRunner() alone spawns no child", () => {
		// Constructing the runner must NOT spawn anything — a codebase with no
		// TypeScript should never pay any tsgo cost.
		const runner = createTsgoRunner();
		expect(runner.stats().watch_process).toBe("not-started");
		disposeRunner(runner);
	});

	it("a non-TS checkFile() still spawns no watch child", async () => {
		// Only .ts/.tsx checks may trigger a spawn; a .js check must not.
		const runner = createTsgoRunner();
		const jsPath = join(tmp, "plain.js");
		writeFileSync(jsPath, "module.exports = 1;\n");
		await runner.checkFile(jsPath);
		expect(runner.stats().watch_process).toBe("not-started");
		disposeRunner(runner);
	});

	it("the first .ts checkFile() lazily spawns the watch child", async () => {
		const { "good.ts": good } = makeProject({ "good.ts": "export const a: number = 1;\n" });
		const runner = createTsgoRunner();
		expect(runner.stats().watch_process).toBe("not-started");
		await runner.checkFile(nonNull(good));
		// After a real TS check the warm child must have been started.
		await waitFor(() => runner.stats().watch_process === "running", 12000);
		expect(runner.stats().watch_process).toBe("running");
		disposeRunner(runner);
	}, 20000);

	it("reports disabled when the warm path is turned off", async () => {
		const { "good.ts": good } = makeProject({ "good.ts": "export const a: number = 1;\n" });
		const runner = createTsgoRunner({ disableWatch: true });
		await runner.checkFile(nonNull(good));
		expect(runner.stats().watch_process).toBe("disabled");
		disposeRunner(runner);
	}, 20000);

	it("falls through to not-started when a registered watcher never left its construction state", async () => {
		// summarizeWatchers()'s loop only sets its sawCrashed/sawEvicted flags for
		// CRASHED/IDLE_EVICTED watchers and returns immediately on RUNNING, so if
		// a watcher is ever present in the map without transitioning out of its
		// "not-started" construction state, the loop exhausts with neither flag
		// set — the defensive fallback this test targets. Force that precondition
		// by stubbing WatchProcess.start() to a no-op: the map still gains a real
		// entry (proven below via the spy call count, unlike the "no watcher yet"
		// case above) but that entry's state never advances off "not-started".
		const startSpy = vi.spyOn(WatchProcess.prototype, "start").mockImplementation(() => {});
		const { "good.ts": good } = makeProject({ "good.ts": "export const a: number = 1;\n" });
		const runner = createNoOutputRunner();
		await runner.checkFile(nonNull(good));
		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(runner.stats().watch_process).toBe("not-started");
		startSpy.mockRestore();
		disposeRunner(runner);
	});
});

describe("createTsgoRunner — warm watch: reuse + diagnostics", () => {
	it("a second check reuses the same warm child", async () => {
		const paths = makeProject({
			"a.ts": "export const a: number = 1;\n",
			"b.ts": "export const b: number = 2;\n",
		});
		const runner = createTsgoRunner();
		await runner.checkFile(nonNull(paths["a.ts"]));
		await waitFor(() => runner.stats().watch_process === "running", 12000);
		// A second check against the same project must keep using the warm
		// child — still exactly one process, still "running".
		await runner.checkFile(nonNull(paths["b.ts"]));
		expect(runner.stats().watch_process).toBe("running");
		disposeRunner(runner);
	}, 20000);

	it("detects a real type error through the warm path", async () => {
		const { "bad.ts": bad } = makeProject({
			"bad.ts": "export const b: string = 123;\n",
		});
		const runner = createTsgoRunner();
		const out = await runner.checkFile(nonNull(bad));
		expect(runner.stats().watch_process).toBe("running");
		// TS2322: number is not assignable to string.
		expect(out.diagnostics.length).toBeGreaterThan(0);
		expect(out.diagnostics.some((d) => d.code === 2322)).toBe(true);
		disposeRunner(runner);
	}, 20000);

	it("returns no diagnostics for a clean file through the warm path", async () => {
		const { "clean.ts": clean } = makeProject({
			"clean.ts": "export const ok: number = 7;\n",
		});
		const runner = createTsgoRunner();
		const out = await runner.checkFile(nonNull(clean));
		expect(out.diagnostics).toEqual([]);
		disposeRunner(runner);
	}, 20000);
});

describe("createTsgoRunner — warm watch: idle eviction", () => {
	it("evicts the watch child after the idle window, then respawns on next use", async () => {
		// Two files: the first check warms the child, the post-eviction check
		// targets the SECOND (uncached) file so it is a genuine cache miss that
		// re-enters the watcher path — checking the same file again would be a
		// cache hit and (correctly) never touch the warm child.
		const paths = makeProject({
			"first.ts": "export const f: number = 1;\n",
			"second.ts": "export const s: number = 2;\n",
		});
		// Short idle window so the timer fires fast — but long enough to clear
		// the warm first check (the idle timer is kept fresh while a check is
		// in flight, then starts counting once checkFile() resolves).
		const runner = createTsgoRunner({ watchIdleMs: 300 });
		await runner.checkFile(nonNull(paths["first.ts"]));
		// The first check spawned the watch child. With no further TS check the
		// idle timer must evict it — reaching "idle-evicted" proves both the
		// lazy spawn and the timer-based eviction.
		await waitFor(() => runner.stats().watch_process === "idle-evicted", 8000);
		expect(runner.stats().watch_process).toBe("idle-evicted");
		// A genuine cache-miss check must lazily respawn a fresh watch child.
		await runner.checkFile(nonNull(paths["second.ts"]));
		expect(runner.stats().watch_process).toBe("running");
		disposeRunner(runner);
	}, 30000);
});

describe("createTsgoRunner — warm watch: crash resilience", () => {
	it("marks the child crashed when it exits unexpectedly, without throwing", async () => {
		const { "good.ts": good } = makeProject({ "good.ts": "export const a: number = 1;\n" });
		// `/bin/echo` exits immediately — stands in for a tsgo that dies right
		// after spawn. The watch child's `exit` event must flip state to
		// "crashed" and the runner must still return a (cold-fallback) result.
		const runner = createTsgoRunner({ executable: "/bin/echo", timeoutMs: 400 });
		const first = await runner.checkFile(nonNull(good));
		expect(first.diagnostics).toEqual([]); // graceful degradation, no throw
		await waitFor(() => runner.stats().watch_process === "crashed", 5000);
		expect(runner.stats().watch_process).toBe("crashed");
		// A subsequent check must not throw either — it respawns (and that
		// respawn crashes again, but the contract is "never throw, degrade").
		const second = await runner.checkFile(nonNull(good));
		expect(second.diagnostics).toEqual([]);
		disposeRunner(runner);
	}, 20000);

});

describe("createTsgoRunner — warm watch: cold fallback detects errors", () => {
	it("falls back to the cold path for diagnostics when the warm path is off", async () => {
		// disableWatch routes every check through the cold one-shot path. The
		// cold path must still surface a real type error — graceful degradation
		// is not the same as losing coverage. The cold one-shot uses the real
		// tsgo on $PATH (the runner's default executable).
		const { "bad.ts": bad } = makeProject({
			"bad.ts": "export const b: string = 123;\n",
		});
		const runner = createTsgoRunner({ disableWatch: true });
		const out = await runner.checkFile(nonNull(bad));
		expect(out.diagnostics.some((d) => d.code === 2322)).toBe(true);
		expect(runner.stats().watch_process).toBe("disabled");
		disposeRunner(runner);
	}, 20000);
});

describe("createTsgoRunner — warm watch: cache + dispose", () => {
	it("keeps the (path,mtime,size) cache so an unchanged file stays cached", async () => {
		const { "good.ts": good } = makeProject({ "good.ts": "export const a: number = 1;\n" });
		const runner = createTsgoRunner();
		const first = await runner.checkFile(nonNull(good));
		const second = await runner.checkFile(nonNull(good));
		expect(first.cached).toBe(false);
		expect(second.cached).toBe(true); // warm path still feeds the cache
		disposeRunner(runner);
	}, 20000);

	it("dispose() tears the warm child down", async () => {
		const { "good.ts": good } = makeProject({ "good.ts": "export const a: number = 1;\n" });
		const runner = createTsgoRunner();
		await runner.checkFile(nonNull(good));
		await waitFor(() => runner.stats().watch_process === "running", 12000);
		runner.dispose?.();
		// After dispose the watcher map is cleared → back to "not-started".
		expect(runner.stats().watch_process).toBe("not-started");
	}, 20000);

	it("dispose() removes process cleanup listeners", () => {
		const beforeExit = process.listenerCount("exit");
		const beforeTerm = process.listenerCount("SIGTERM");
		const beforeInt = process.listenerCount("SIGINT");
		const runner = createTsgoRunner({ executable: "/bin/true", timeoutMs: 200 });

		expect(process.listenerCount("exit")).toBe(beforeExit + 1);
		expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
		expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);

		runner.dispose?.();

		expect(process.listenerCount("exit")).toBe(beforeExit);
		expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
		expect(process.listenerCount("SIGINT")).toBe(beforeInt);
	});
});

describe("createTsgoRunner — available()", () => {
	it("reports true when an executable is resolved", () => {
		const runner = createTsgoRunner({ executable: "/bin/true", timeoutMs: 200 });
		expect(runner.available()).toBe(true);
		disposeRunner(runner);
	});
});

describe("createTsgoRunner — cache FIFO eviction", () => {
	it("evicts the oldest entry once the cache exceeds maxCacheEntries", async () => {
		const runner = createTsgoRunner({ executable: "/bin/true", timeoutMs: 200, maxCacheEntries: 1 });
		const pathA = join(tmp, "a.ts");
		const pathB = join(tmp, "b.ts");
		writeFileSync(pathA, "export const a = 1;\n");
		writeFileSync(pathB, "export const b = 2;\n");

		await runner.checkFile(pathA);
		expect(runner.stats().cache_size).toBe(1);
		await runner.checkFile(pathB);
		// The single-entry cap means adding b's entry evicted a's.
		expect(runner.stats().cache_size).toBe(1);
		// a is no longer cached — a fresh check reports cached:false again.
		const again = await runner.checkFile(pathA);
		expect(again.cached).toBe(false);
		disposeRunner(runner);
	});
});

describe("createTsgoRunner — simulateEdit edge paths", () => {
	it("returns empty diagnostics when the target path is a directory (unreadable as a file)", async () => {
		const dirPath = join(tmp, "a-directory");
		mkdirSync(dirPath, { recursive: true });
		const runner = createTsgoRunner({ executable: "/bin/true", timeoutMs: 200 });
		const out = await runner.simulateEdit(dirPath, "x", "y");
		expect(out.new_diagnostics).toEqual([]);
		disposeRunner(runner);
	});

	it("appends newString when oldString is empty (falsy) instead of doing a literal replace", async () => {
		const path = join(tmp, "append.ts");
		writeFileSync(path, "export const z = 1;\n");
		const runner = createNoOutputRunner();
		const out = await runner.simulateEdit(path, "", "export const appended = 2;\n");
		// The no-output child is not a real tsgo, so the one-shot spawn yields no
		// diagnostics either way — the assertion pins that the falsy-oldString
		// (append) branch completes without throwing and without diagnostics.
		expect(out.new_diagnostics).toEqual([]);
		disposeRunner(runner);
	});

	it("runs the full patch pipeline for a file with no extension (suffix fallback to .ts)", async () => {
		const path = join(tmp, "noext");
		writeFileSync(path, "hello world");
		const runner = createNoOutputRunner();
		const out = await runner.simulateEdit(path, "hello", "goodbye");
		expect(out.new_diagnostics).toEqual([]);
		expect(out.elapsed_ms).toBeGreaterThanOrEqual(0);
		disposeRunner(runner);
	});

	it("touches the warm watcher's idle timer when the edited file belongs to a tsgo project", async () => {
		// tsconfig.json present ⇒ findTsconfigDir resolves a root ⇒ watcherFor()
		// constructs a (non-null) WatchProcess even though the no-output child is not a
		// real tsgo — exercising the truthy `if (w) w.touchIdle()` branch.
		writeFileSync(join(tmp, "tsconfig.json"), "{}");
		const path = join(tmp, "proj.ts");
		writeFileSync(path, "export const p = 1;\n");
		const runner = createNoOutputRunner();
		const out = await runner.simulateEdit(path, "p = 1", "p = 2");
		expect(out.new_diagnostics).toEqual([]);
		disposeRunner(runner);
	});

	it("skips touchIdle when the .ts file has no tsconfig project (watcherFor returns null)", async () => {
		const path = join(tmp, "standalone.ts");
		writeFileSync(path, "export const s = 1;\n");
		const runner = createNoOutputRunner();
		const out = await runner.simulateEdit(path, "s = 1", "s = 2");
		expect(out.new_diagnostics).toEqual([]);
		disposeRunner(runner);
	});
});

describe("createTsgoRunner — onExit cleanup handler", () => {
	it("swallows a throwing watcher.kill() during process-exit cleanup without throwing", async () => {
		const { "good.ts": good } = makeProject({ "good.ts": "export const a: number = 1;\n" });
		const beforeExitCount = process.listenerCount("exit");
		const runner = createTsgoRunner();
		await runner.checkFile(nonNull(good));
		await waitFor(() => runner.stats().watch_process === "running", 12000);

		const killSpy = vi.spyOn(WatchProcess.prototype, "kill").mockImplementation(() => {
			throw new Error("boom: kill failed");
		});

		const added = process.listeners("exit").slice(beforeExitCount);
		expect(added.length).toBe(1);
		const onExit = added[0] as () => void;

		// The handler's try/catch must swallow the throw — process exit cleanup
		// must never itself crash the process.
		expect(() => onExit()).not.toThrow();

		killSpy.mockRestore();
		disposeRunner(runner);
	}, 20000);
});
