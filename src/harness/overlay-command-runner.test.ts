// Tests for the generic overlay command runner — the P4 spike seam
// (docs/design/overlay-exec-runtime-oracles.md §2). Drives the injectable
// spawn so no real process runs — EXCEPT the dedicated `defaultSpawn` block
// below, which exercises the real `node:child_process` spawn path (it is not
// exported, so the only way to reach it is to omit the injected `spawnFn`
// and drive it through `runArgvInOverlay` with real `node` subprocesses
// against a real tmpdir overlay root).

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type OverlaySpawnFn,
	resolveOverlayBin,
	runArgvInOverlay,
} from "./overlay-command-runner.js";

const OVERLAY = "/repo/.interlinked/.cov-overlay-x";

function stubSpawn(
	outcome: Partial<Awaited<ReturnType<OverlaySpawnFn>>>,
	capture?: (cmd: string, args: string[], cwd: string, env?: Record<string, string>) => void,
): OverlaySpawnFn {
	return async (cmd, args, opts) => {
		capture?.(cmd, args, opts.cwd, opts.env);
		return { stdout: "", stderr: "", status: 0, ...outcome };
	};
}

describe("runArgvInOverlay", () => {
	it("runs argv against the overlay root and returns a structured result", async () => {
		let seenCwd = "";
		const spawn = stubSpawn({ stdout: "ok", status: 0 }, (_c, _a, cwd) => {
			seenCwd = cwd;
		});
		const r = await runArgvInOverlay(["node", "-e", "0"], OVERLAY, 5000, spawn);
		expect(seenCwd).toBe(OVERLAY);
		expect(r.exitCode).toBe(0);
		expect(r.timedOut).toBe(false);
		expect(r.stdout).toBe("ok");
		expect(r.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("maps a nonzero exit through", async () => {
		const r = await runArgvInOverlay(["false"], OVERLAY, 5000, stubSpawn({ status: 1 }));
		expect(r.exitCode).toBe(1);
		expect(r.timedOut).toBe(false);
	});

	it("reports a timeout (ETIMEDOUT → timedOut, exitCode null)", async () => {
		const timedOut = stubSpawn({
			status: null,
			error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
		});
		const r = await runArgvInOverlay(["sleep", "99"], OVERLAY, 10, timedOut);
		expect(r.timedOut).toBe(true);
		expect(r.exitCode).toBeNull();
	});

	it("reports ENOENT as a launch failure, not a timeout", async () => {
		const enoent = stubSpawn({
			status: null,
			error: Object.assign(new Error("not found"), { code: "ENOENT" }),
		});
		const r = await runArgvInOverlay(["nope"], OVERLAY, 5000, enoent);
		expect(r.timedOut).toBe(false);
		expect(r.exitCode).toBeNull();
		expect(r.error).toContain("nope");
	});

	it("threads env over the child", async () => {
		let seenEnv: Record<string, string> | undefined;
		const spawn = stubSpawn({ status: 0 }, (_c, _a, _cwd, env) => {
			seenEnv = env;
		});
		await runArgvInOverlay(["node"], OVERLAY, 5000, spawn, { NODE_OPTIONS: "--expose-gc" });
		expect(seenEnv).toEqual({ NODE_OPTIONS: "--expose-gc" });
	});

	it("rejects an empty argv without spawning", async () => {
		let spawned = false;
		const r = await runArgvInOverlay([], OVERLAY, 5000, stubSpawn({}, () => {
			spawned = true;
		}));
		expect(spawned).toBe(false);
		expect(r.error).toContain("empty");
	});
});

describe("resolveOverlayBin", () => {
	it("leaves an absolute or slash-bearing bin untouched", () => {
		expect(resolveOverlayBin("/repo", "/usr/bin/node")).toBe("/usr/bin/node");
		expect(resolveOverlayBin("/repo", "./x")).toBe("./x");
	});

	it("returns a bare bin unchanged when no local .bin exists", () => {
		// /repo has no node_modules/.bin/definitely-not-a-real-bin → PATH fallback.
		expect(resolveOverlayBin("/repo", "definitely-not-a-real-bin")).toBe(
			"definitely-not-a-real-bin",
		);
	});
});

// ===========================================
// defaultSpawn — real node:child_process, no injected spawnFn
// ===========================================
// `defaultSpawn` is module-private; the only seam to reach it is calling
// `runArgvInOverlay` WITHOUT a `spawnFn` argument. A real tmpdir stands in
// for the overlay root (defaultSpawn passes it straight through as `cwd`),
// and every child here is a real, short-lived `node -e ...` subprocess.

describe("runArgvInOverlay — defaultSpawn (real subprocess)", () => {
	let overlayRoot = "";

	beforeAll(() => {
		overlayRoot = mkdtempSync(join(tmpdir(), "overlay-runner-"));
	});

	afterAll(() => {
		if (overlayRoot) rmSync(overlayRoot, { recursive: true, force: true });
	});

	it("captures real stdout and a zero exit code, cwd'd to the overlay root", async () => {
		const r = await runArgvInOverlay(
			["node", "-e", "process.stdout.write('hi-from-overlay'); process.exit(0);"],
			overlayRoot,
			10_000,
		);
		expect(r.exitCode).toBe(0);
		expect(r.timedOut).toBe(false);
		expect(r.stdout).toBe("hi-from-overlay");
		expect(r.error).toBeUndefined();
	});

	it("captures real stderr and a nonzero exit code", async () => {
		const r = await runArgvInOverlay(
			["node", "-e", "process.stderr.write('boom'); process.exit(3);"],
			overlayRoot,
			10_000,
		);
		expect(r.exitCode).toBe(3);
		expect(r.stderr).toBe("boom");
	});

	it("kills a child that outlives its budget and reports timedOut", async () => {
		const r = await runArgvInOverlay(
			["node", "-e", "setTimeout(() => {}, 60000);"],
			overlayRoot,
			200,
		);
		expect(r.timedOut).toBe(true);
		expect(r.exitCode).toBeNull();
		expect(r.error).toContain("timed out after 200 ms");
	}, 10_000);

	it("reports a real ENOENT launch failure for a bin that doesn't exist", async () => {
		const r = await runArgvInOverlay(
			["definitely-not-a-real-bin-xyz-123"],
			overlayRoot,
			5000,
		);
		expect(r.exitCode).toBeNull();
		expect(r.timedOut).toBe(false);
		expect(r.error).toContain("definitely-not-a-real-bin-xyz-123");
		expect(r.error).toContain("failed to launch");
	});

	it("catches a synchronous spawn() throw (null byte in the command)", async () => {
		// node:child_process validates the file argument before any process
		// exists — a null byte throws SYNCHRONOUSLY, inside defaultSpawn's own
		// try/catch rather than surfacing via the async 'error' event.
		const r = await runArgvInOverlay(["bad\0bin"], overlayRoot, 5000);
		expect(r.exitCode).toBeNull();
		expect(r.timedOut).toBe(false);
		expect(r.error).toContain("failed to launch");
		expect(r.error).toMatch(/null byte/i);
	});
});

// ===========================================
// process group (kill-proof review round 4, M6)
// ===========================================
describe("runArgvInOverlay — a timed-out child's whole process group is stopped (real subprocesses)", () => {
	it("N1: a grandchild spawned by the timed-out child is dead when the run returns; no marker appears afterwards", async () => {
		const dir = mkdtempSync(join(tmpdir(), "overlay-group-"));
		const marker = join(dir, "grandchild-ran");
		try {
			// parent: spawns a grandchild that writes a marker after 1.5 s, then idles; budget 300 ms → timeout
			const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'), 1500)`;
			const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }); setTimeout(() => {}, 60000);`;
			const started = Date.now();
			const r = await runArgvInOverlay(["node", "-e", parent], dir, 300);
			expect(r.timedOut).toBe(true);
			expect(r.exitCode).toBeNull();
			expect(Date.now() - started).toBeLessThan(5_000); // the group died on SIGTERM, well inside the SIGKILL grace
			await new Promise((done) => setTimeout(done, 2_000));
			expect(existsSync(marker)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15_000);

	it("P1: a child that finishes inside its budget is unaffected (exit code, stdout, no error)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "overlay-group-"));
		try {
			const r = await runArgvInOverlay(["node", "-e", "process.stdout.write('ok'); process.exit(0);"], dir, 10_000);
			expect(r).toMatchObject({ exitCode: 0, stdout: "ok", timedOut: false });
			expect(process.listenerCount("SIGINT")).toBe(process.listenerCount("SIGTERM")); // the parent-exit guard was removed again
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
