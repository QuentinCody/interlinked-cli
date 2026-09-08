import { nonNull } from "../lib/non-null.js";
import type { ChildProcess } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryAcquireProjectCompilerLease } from "./project-compiler-gate.js";
import {
	DEFAULT_WATCH_IDLE_MS,
	WATCH_CRASHED,
	WATCH_IDLE_EVICTED,
	WATCH_RUNNING,
	WatchProcess,
} from "./tsgo-runner-watch.js";

const { childProcesses } = vi.hoisted(() => {
	const childProcesses: ChildProcess[] = [];
	return { childProcesses };
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (...args: Parameters<typeof actual.spawn>) => {
			const child = actual.spawn(...args);
			childProcesses.push(child);
			return child;
		},
	};
});

// These tests drive the REAL `WatchProcess` class against small, fast fake
// "tsgo --watch" shell scripts (not the real tsgo binary — tsgo-runner.test.ts
// already covers the real-binary integration path). Each script emits
// canned pass-marker / diagnostic lines on stdout so the pass-parsing state
// machine and the fresh-wait/idle-eviction/crash timers run for real, on a
// real child process, without needing a TypeScript project or the tsgo
// binary to be installed.

let tmp = "";
const spawned: WatchProcess[] = [];

beforeEach(() => {
	childProcesses.length = 0;
	tmp = mkdtempSync(join(tmpdir(), "interlinked-watch-"));
});

afterEach(async () => {
	await Promise.all(spawned.splice(0).map((wp) => wp.kill()));
	rmSync(tmp, { recursive: true, force: true });
});

function makeWatch(idleMs: number): WatchProcess {
	const wp = new WatchProcess("/bin/sh", tmp, idleMs);
	spawned.push(wp);
	return wp;
}

/** Write an executable `/bin/sh` script and return its absolute path. */
function fakeTsgo(name: string, body: string): string {
	const path = join(tmp, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

/** WatchProcess spawns a fixed executable+args; point `/bin/sh` at a script
 * by using it AS the executable (shebang-based scripts are directly
 * executable on darwin/linux, so the script path itself works as
 * `this.executable`). */
function makeWatchWithScript(idleMs: number, scriptPath: string): WatchProcess {
	const wp = new WatchProcess(scriptPath, tmp, idleMs);
	spawned.push(wp);
	return wp;
}

const ONE_PASS_THEN_SLEEP = [
	'printf \'build starting at 12:00:00 AM\\n\'',
	'printf \'a.ts(3,7): error TS1234: boom.\\n\'',
	'printf \'build finished in 0.01s\\n\'',
	"sleep 30",
].join("\n");

const CLASSIC_FORMAT_THEN_SLEEP = [
	// leading ANSI clear-screen glued to the marker text, as real tsgo emits.
	'printf \'\\033[2J\\033[3J\\033[HStarting compilation in watch mode...\\n\'',
	'printf \'a.ts(1,1): error TS9999: classic err.\\n\'',
	'printf \'12:00:02 AM - Found 1 error. Watching for file changes.\\n\'',
	"sleep 30",
].join("\n");

const NEVER_PASS = "sleep 30";

const STDERR_DIAG_THEN_SLEEP = [
	// tsgo --watch keeps stderr empty today, but the watcher also wires stderr
	// through `ingest()` for a future split-stream tsgo — exercise that path.
	'printf \'build starting at 12:00:00 AM\\n\' 1>&2',
	'printf \'a.ts(3,7): error TS1234: boom.\\n\' 1>&2',
	'printf \'build finished in 0.01s\\n\' 1>&2',
	"sleep 30",
].join("\n");

const NOISE_LINE_THEN_PASS = [
	// A line that is neither a pass marker nor a parseable diagnostic.
	'printf \'compiling project...\\n\'',
	'printf \'build starting at 12:00:00 AM\\n\'',
	'printf \'build finished in 0.01s\\n\'',
	"sleep 30",
].join("\n");

const PASS_THEN_CRASH = [
	'printf \'build starting at 12:00:00 AM\\n\'',
	'printf \'build finished in 0.01s\\n\'',
	"sleep 0.3",
	"exit 3",
].join("\n");

const REPEATING_PASSES = [
	"i=0",
	"while [ $i -lt 40 ]; do",
	'  printf \'build starting at 12:00:00 AM\\n\'',
	'  printf \'build finished in 0.01s\\n\'',
	"  i=$((i+1))",
	"  sleep 0.1",
	"done",
	"sleep 30",
].join("\n");

const EXIT_WITH_CODE_7 = "exit 7";

/** Poll a predicate on real macrotask ticks (matches tsgo-runner.test.ts). */
function waitFor(pred: () => boolean, budgetMs: number): Promise<void> {
	const tickMs = 20;
	return new Promise<void>((resolve, reject) => {
		let elapsed = 0;
		const tick = (): void => {
			if (pred()) {
				resolve();
				return;
			}
			elapsed += tickMs;
			if (elapsed >= budgetMs) {
				reject(new Error(`waitFor: predicate not satisfied within ${budgetMs}ms`));
				return;
			}
			setTimeout(tick, tickMs);
		};
		tick();
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("WatchProcess — start() lifecycle", () => {
	it("spawns and reaches the running state", async () => {
		const script = fakeTsgo("one.sh", ONE_PASS_THEN_SLEEP);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		expect(wp.state()).toBe("not-started");
		wp.start();
		expect(wp.state()).toBe(WATCH_RUNNING);
		expect(wp.isUsable()).toBe(true);
	});

	it("is idempotent — a second start() call does not touch an already-running child", () => {
		const script = fakeTsgo("idem.sh", ONE_PASS_THEN_SLEEP);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		wp.start();
		expect(childProcesses).toHaveLength(1);
		const childBefore = childProcesses[0];
		wp.start();
		expect(childProcesses).toEqual([childBefore]);
	});

	it("catches a synchronous spawn throw (embedded NUL byte in the executable) and marks crashed", () => {
		const badExecutable = `bad${String.fromCharCode(0)}cmd`;
		const wp = new WatchProcess(badExecutable, tmp, DEFAULT_WATCH_IDLE_MS);
		spawned.push(wp);
		wp.start();
		expect(wp.state()).toBe(WATCH_CRASHED);
		expect(wp.isUsable()).toBe(false);
	});

	it("marks crashed when the child exits unexpectedly", async () => {
		const script = fakeTsgo("crash.sh", EXIT_WITH_CODE_7);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		wp.start();
		await waitFor(() => wp.state() === WATCH_CRASHED, 5000);
		expect(wp.state()).toBe(WATCH_CRASHED);
	});
});

describe("WatchProcess — pass-marker parsing", () => {
	it("parses the 'build' format pass and returns its diagnostic", async () => {
		const script = fakeTsgo("build.sh", ONE_PASS_THEN_SLEEP);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		wp.start();
		const tsPath = join(tmp, "a.ts");
		writeFileSync(tsPath, "export const a = 1;\n");
		const diags = await wp.diagnosticsForFile(tsPath);
		expect(diags).not.toBeNull();
		expect(diags?.length).toBe(1);
		expect(diags?.[0]?.code).toBe(1234);
	});

	it("parses the 'classic' format pass (ANSI-glued marker) and returns its diagnostic", async () => {
		const script = fakeTsgo("classic.sh", CLASSIC_FORMAT_THEN_SLEEP);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		wp.start();
		const tsPath = join(tmp, "a.ts");
		writeFileSync(tsPath, "export const a = 1;\n");
		const diags = await wp.diagnosticsForFile(tsPath);
		expect(diags).not.toBeNull();
		expect(diags?.length).toBe(1);
		expect(diags?.[0]?.code).toBe(9999);
	});

	it("records an out-of-pass diagnostic against the latest completed pass", async () => {
		const script = fakeTsgo("orphan.sh", ONE_PASS_THEN_SLEEP);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		wp.start();
		const orphanPath = join(tmp, "src/orphan.ts");
		expect(await wp.diagnosticsForFile(orphanPath)).toEqual([]);
		const child = nonNull(childProcesses[0]);
		nonNull(child.stdout).emit("data", Buffer.from("src/orphan.ts(2,2): warning TS0001: orphan diag.\n"));
		expect((await wp.diagnosticsForFile(orphanPath))?.map((diagnostic) => diagnostic.code)).toEqual([1]);
	});

	it("also reads pass output written to stderr (future split-stream tsgo)", async () => {
		const script = fakeTsgo("stderr.sh", STDERR_DIAG_THEN_SLEEP);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		wp.start();
		const tsPath = join(tmp, "a.ts");
		writeFileSync(tsPath, "export const a = 1;\n");
		const diags = await wp.diagnosticsForFile(tsPath);
		expect(diags).not.toBeNull();
		expect(diags?.length).toBe(1);
		expect(diags?.[0]?.code).toBe(1234);
	});

	it("ignores a line that is neither a pass marker nor a parseable diagnostic", async () => {
		const script = fakeTsgo("noise.sh", NOISE_LINE_THEN_PASS);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		wp.start();
		const tsPath = join(tmp, "a.ts");
		writeFileSync(tsPath, "export const a = 1;\n");
		const diags = await wp.diagnosticsForFile(tsPath);
		expect(diags).toEqual([]);
	});
});

describe("WatchProcess — diagnosticsForFile: not usable / initial pass", () => {
	it("returns null immediately when the child has never been started", async () => {
		const wp = makeWatch(DEFAULT_WATCH_IDLE_MS);
		const out = await wp.diagnosticsForFile(join(tmp, "x.ts"));
		expect(out).toBeNull();
	});

	it("returns null when the FIRST pass never lands within the initial-pass budget", async () => {
		const script = fakeTsgo("neverpass.sh", NEVER_PASS);
		// The wait's own poll keeps touching the idle timer (activity), so a
		// short idle window does NOT evict mid-wait — this exercises the
		// WATCH_INITIAL_PASS_MS timeout path specifically, not eviction.
		const wp = makeWatchWithScript(120, script);
		wp.start();
		const out = await wp.diagnosticsForFile(join(tmp, "x.ts"));
		expect(out).toBeNull();
		expect(wp.state()).toBe(WATCH_RUNNING);
	}, 12000);
});

describe("WatchProcess — diagnosticsForFile: fresh-file wait", () => {
	it("waits for a fresh pass when the file is newer than the last completed pass, then returns it", async () => {
		const script = fakeTsgo("repeat.sh", REPEATING_PASSES);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		wp.start();
		const tsPath = join(tmp, "fresh.ts");
		writeFileSync(tsPath, "export const a = 1;\n");
		// First call establishes lastPassCompletedAt from an early pass.
		const first = await wp.diagnosticsForFile(tsPath);
		expect(first).not.toBeNull();
		// Bump the file's mtime far into the future so every subsequent pass
		// still reads as "older than the file" — forces BOTH the primary wait
		// (line ~160) and the nested double-edit wait (line ~165) to trigger.
		const future = new Date(Date.now() + 60_000);
		utimesSync(tsPath, future, future);
		const second = await wp.diagnosticsForFile(tsPath);
		// The repeating-pass script keeps completing passes, so the wait(s)
		// resolve with a (possibly empty) diagnostics array rather than null.
		expect(second).not.toBeNull();
	}, 15000);

	it("times out and returns null when the file is newer but no further pass ever lands", async () => {
		const script = fakeTsgo("onepass.sh", ONE_PASS_THEN_SLEEP);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		wp.start();
		const tsPath = join(tmp, "stale.ts");
		writeFileSync(tsPath, "export const a = 1;\n");
		const first = await wp.diagnosticsForFile(tsPath);
		expect(first).not.toBeNull();
		// Only one pass is ever emitted by this script — mark the file newer
		// so the fresh-wait triggers, and it must time out (no 2nd pass comes).
		const future = new Date(Date.now() + 60_000);
		utimesSync(tsPath, future, future);
		const second = await wp.diagnosticsForFile(tsPath);
		expect(second).toBeNull();
	}, 10000);

	it("does not re-wait a second time once a landed pass is already fresh (single-wait satisfied)", async () => {
		// mtime set 1ms beyond the current clock after a completed pass — the next
		// pass (arriving ~100ms later, per REPEATING_PASSES' cadence) is
		// guaranteed to land well after it, so the nested "still newer after
		// the first wait" re-check (the inner fileNewerThanLastPass call)
		// comes back false without needing a second wait.
		const script = fakeTsgo("repeat2.sh", REPEATING_PASSES);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		wp.start();
		const tsPath = join(tmp, "near.ts");
		writeFileSync(tsPath, "export const a = 1;\n");
		await wp.diagnosticsForFile(tsPath); // establish an initial pass
		const near = new Date(Date.now() + 1);
		utimesSync(tsPath, near, near);
		const out = await wp.diagnosticsForFile(tsPath);
		expect(out).toEqual([]);
	}, 10000);

	it("does not wait when statSync on the target path throws (nonexistent file)", async () => {
		const script = fakeTsgo("statthrow.sh", ONE_PASS_THEN_SLEEP);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		wp.start();
		const tsPath = join(tmp, "real.ts");
		writeFileSync(tsPath, "export const a = 1;\n");
		await wp.diagnosticsForFile(tsPath); // establish an initial pass
		const missing = join(tmp, "does-not-exist.ts");
		const out = await wp.diagnosticsForFile(missing);
		// fileNewerThanLastPass's statSync throws → treated as "not newer" →
		// no wait is triggered; filtering by the (nonexistent) path yields [].
		expect(out).toEqual([]);
	}, 10000);

	it("resolves a pending fresh-wait as failed when the child crashes mid-wait", async () => {
		const script = fakeTsgo("crashmidwait.sh", PASS_THEN_CRASH);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		wp.start();
		const tsPath = join(tmp, "crash.ts");
		writeFileSync(tsPath, "export const a = 1;\n");
		await wp.diagnosticsForFile(tsPath); // establish the one pass
		const future = new Date(Date.now() + 60_000);
		utimesSync(tsPath, future, future);
		// The child exits ~0.3s in; no second pass ever lands, so the fresh
		// wait must resolve to null via the crash (flushWaiters), not the
		// full 2s timeout.
		const start = Date.now();
		const out = await wp.diagnosticsForFile(tsPath);
		expect(out).toBeNull();
		expect(Date.now() - start).toBeLessThan(1900);
	}, 10000);
});

describe("WatchProcess — touchIdle()", () => {
	it("is a no-op when the process is not running", () => {
		const wp = makeWatch(DEFAULT_WATCH_IDLE_MS);
		expect(() => wp.touchIdle()).not.toThrow();
		expect(wp.state()).toBe("not-started");
	});
});

describe("WatchProcess — idle eviction", () => {
	it("evicts the child after the idle window and flushes waiters", async () => {
		const script = fakeTsgo("idle.sh", ONE_PASS_THEN_SLEEP);
		const wp = makeWatchWithScript(150, script);
		wp.start();
		await waitFor(() => wp.state() === WATCH_IDLE_EVICTED, 5000);
		expect(wp.isUsable()).toBe(false);
	});

	it("never evicts when idleMs <= 0", async () => {
		const script = fakeTsgo("noidle.sh", ONE_PASS_THEN_SLEEP);
		const wp = makeWatchWithScript(0, script);
		wp.start();
		await sleep(300);
		expect(wp.state()).toBe(WATCH_RUNNING);
	});

	it("does not downgrade an idle-evicted state back to crashed on a late error event", async () => {
		const script = fakeTsgo("evictlate.sh", ONE_PASS_THEN_SLEEP);
		const wp = makeWatchWithScript(120, script);
		wp.start();
		const originalChildRef = nonNull(childProcesses[0]);
		await waitFor(() => wp.state() === WATCH_IDLE_EVICTED, 5000);
		// Manually fire a late 'error' event on the ORIGINAL child object (the
		// listener closure still calls markCrashed() unconditionally even
		// though the instance's own `child` field was already nulled by
		// eviction) — this must NOT downgrade the state away from evicted.
		originalChildRef.emit("error", new Error("late spurious error"));
		expect(wp.state()).toBe(WATCH_IDLE_EVICTED);
	}, 5000);

	it("swallows a throw from child.kill() during idle eviction", async () => {
		const script = fakeTsgo("idlekillthrow.sh", ONE_PASS_THEN_SLEEP);
		const wp = makeWatchWithScript(120, script);
		wp.start();
		const child = nonNull(childProcesses[0]);
		const pid = nonNull(child.pid);
		const killChild = vi.spyOn(child, "kill").mockImplementation(() => {
			throw new Error("kill failed");
		});
		const killProcess = process.kill.bind(process);
		const signalGroup = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
			if (target === -pid && signal === "SIGTERM") throw new Error("group signal failed");
			return killProcess(target, signal);
		});
		try {
			await waitFor(() => wp.state() === WATCH_IDLE_EVICTED, 5000);
			await wp.kill();
			expect(killChild).toHaveBeenCalledWith("SIGTERM");
			expect(wp.state()).toBe(WATCH_IDLE_EVICTED);
			expect(() => killProcess(pid, 0)).toThrow();
		} finally {
			signalGroup.mockRestore();
			killChild.mockRestore();
		}
	});
});

describe("WatchProcess — kill()", () => {
	it("is a no-op the second time (child already null, idle timer already cleared)", () => {
		const script = fakeTsgo("killtwice.sh", ONE_PASS_THEN_SLEEP);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		wp.start();
		wp.kill();
		expect(wp.isUsable()).toBe(false);
		// Second call must not throw and must remain a no-op.
		expect(() => wp.kill()).not.toThrow();
	});

	it("swallows a throw from child.kill()", async () => {
		const script = fakeTsgo("killthrow.sh", ONE_PASS_THEN_SLEEP);
		const wp = makeWatchWithScript(0, script);
		wp.start();
		const child = nonNull(childProcesses[0]);
		const pid = nonNull(child.pid);
		const killChild = vi.spyOn(child, "kill").mockImplementation(() => {
			throw new Error("kill failed");
		});
		const killProcess = process.kill.bind(process);
		const signalGroup = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
			if (target === -pid && signal === "SIGTERM") throw new Error("group signal failed");
			return killProcess(target, signal);
		});
		try {
			await expect(wp.kill()).resolves.toBeUndefined();
			expect(killChild).toHaveBeenCalledWith("SIGTERM");
			expect(wp.state()).toBe(WATCH_IDLE_EVICTED);
			expect(() => killProcess(pid, 0)).toThrow();
		} finally {
			signalGroup.mockRestore();
			killChild.mockRestore();
		}
	});

	it("holds its compiler registration until a SIGTERM-resistant child is reaped", async () => {
		const script = fakeTsgo(
			"ignore-term.js",
			[
				"process.on('SIGTERM', () => {});",
				"console.log('build starting at 12:00:00 AM');",
				"console.log('build finished in 0.01s');",
				"setInterval(() => {}, 1000);",
			].join("\n"),
		);
		writeFileSync(script, `#!/usr/bin/env node\n${readFileSync(script, "utf-8").split("\n").slice(1).join("\n")}`);
		chmodSync(script, 0o755);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		wp.start();
		await wp.diagnosticsForFile(join(tmp, "a.ts"));
		const pid = nonNull(nonNull(childProcesses[0]).pid);

		let settled = false;
		const stopped = wp.kill().then(() => {
			settled = true;
		});
		expect(settled).toBe(false);
		expect(tryAcquireProjectCompilerLease(tmp)).toBeNull();
		expect(() => process.kill(pid, 0)).not.toThrow();
		await stopped;
		expect(settled).toBe(true);
		expect(() => process.kill(pid, 0)).toThrow();
		const release = tryAcquireProjectCompilerLease(tmp);
		expect(release).not.toBeNull();
		release?.();
	}, 5_000);

	it("holds its compiler registration until a wrapper's TERM-resistant descendant is reaped", async () => {
		const descendantPidPath = join(tmp, "descendant.pid");
		const descendantProgram = [
			'const fs = require("node:fs");',
			"const pidPath = process.argv[1];",
			"process.on('SIGTERM', () => {});",
			"fs.writeFileSync(pidPath, String(process.pid));",
			"setInterval(() => {}, 1000);",
		].join(" ");
		const wrapperProgram = [
			'const { spawn } = require("node:child_process");',
			`const pidPath = ${JSON.stringify(descendantPidPath)};`,
			`const childProgram = ${JSON.stringify(descendantProgram)};`,
			"process.on('SIGTERM', () => process.exit(0));",
			"spawn(process.execPath, ['-e', childProgram, pidPath], { stdio: 'ignore' });",
			"console.log('build starting at 12:00:00 AM');",
			"console.log('build finished in 0.01s');",
			"setInterval(() => {}, 1000);",
		].join("\n");
		const script = join(tmp, "wrapper-with-descendant.js");
		writeFileSync(script, `#!/usr/bin/env node\n${wrapperProgram}`);
		chmodSync(script, 0o755);
		const wp = makeWatchWithScript(DEFAULT_WATCH_IDLE_MS, script);
		let descendantPid = 0;
		try {
			wp.start();
			await wp.diagnosticsForFile(join(tmp, "a.ts"));
			await waitFor(() => existsSync(descendantPidPath), 2_000);
			descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf-8"), 10);
			expect(Number.isSafeInteger(descendantPid)).toBe(true);

			let settled = false;
			const stopped = wp.kill().then(() => {
				settled = true;
			});
			await sleep(50);
			expect(settled).toBe(false);
			expect(tryAcquireProjectCompilerLease(tmp)).toBeNull();
			expect(() => process.kill(descendantPid, 0)).not.toThrow();
			await stopped;
			expect(() => process.kill(descendantPid, 0)).toThrow();
			const release = tryAcquireProjectCompilerLease(tmp);
			expect(release).not.toBeNull();
			release?.();
		} finally {
			if (descendantPid > 0) {
				try {
					process.kill(descendantPid, "SIGKILL");
				} catch {
					// Expected after the process-group reap under test.
					void 0;
				}
			}
		}
	}, 5_000);
});
