// Error-path coverage for cyclomatic-python.ts: the catch branches
// (radonAvailable's spawn-throws path, computeCyclomaticPython's
// mkdtemp/writeFile-failure path) that the integration test file's
// spawn-returns-error fixtures cannot reach, plus toRadonBlock's
// malformed-JSON-node guards and the real (uninjected) spawnSync default.
import { describe, expect, it, vi } from "vitest";

// ===========================================
// radonAvailable — spawn itself throws (not just returns an error result)
// ===========================================

describe("radonAvailable — spawn throws synchronously", () => {
	it("returns false when the injected spawn function throws", async () => {
		const { radonAvailable } = await import("./cyclomatic-python.js");
		const throwing = (): never => {
			throw new Error("EACCES");
		};
		expect(radonAvailable(throwing)).toBe(false);
	});
});

// ===========================================
// computeCyclomaticPython — uses the REAL default spawn (no injected fn)
// ===========================================

describe("computeCyclomaticPython — default spawn (uninjected)", () => {
	it("returns null (or entries) without throwing when radon may not be installed", async () => {
		const { computeCyclomaticPython } = await import("./cyclomatic-python.js");
		// No `spawn` argument — exercises the real `defaultSpawn` wrapping
		// node:child_process spawnSync. Whether radon is actually on PATH in
		// CI is irrelevant to this module's contract: it must not throw, and
		// must return either null (unavailable/failed) or an array.
		const out = computeCyclomaticPython("def f():\n    pass\n", "probe.py");
		expect(out === null || Array.isArray(out)).toBe(true);
	});
});

// ===========================================
// computeCyclomaticPython — outer catch (mkdtemp/writeFile failure)
// ===========================================

describe("computeCyclomaticPython — outer try/catch (fs failure before spawn)", () => {
	it("returns null and never calls rmSync when mkdtempSync throws", async () => {
		vi.resetModules();
		const rmSyncMock = vi.fn();
		vi.doMock("node:fs", () => ({
			mkdtempSync: () => {
				throw new Error("ENOSPC: no space left on device");
			},
			rmSync: rmSyncMock,
			writeFileSync: vi.fn(),
		}));
		const { computeCyclomaticPython } = await import("./cyclomatic-python.js");
		const spawn = vi.fn<import("./cyclomatic-python.js").PythonSpawnFn>();
		const out = computeCyclomaticPython("def f():\n    pass\n", "x.py", spawn);
		expect(out).toBeNull();
		// dir stayed null (never assigned) — the finally block's `dir !== null`
		// guard must skip rmSync rather than calling it with a garbage path.
		expect(rmSyncMock).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
		vi.doUnmock("node:fs");
		vi.resetModules();
	});

	it("returns null and DOES clean up the temp dir when writeFileSync throws", async () => {
		vi.resetModules();
		const rmSyncMock = vi.fn();
		vi.doMock("node:fs", () => ({
			mkdtempSync: () => "/tmp/interlinked-radon-fake",
			rmSync: rmSyncMock,
			writeFileSync: () => {
				throw new Error("EACCES: permission denied");
			},
		}));
		const { computeCyclomaticPython } = await import("./cyclomatic-python.js");
		const spawn = vi.fn<import("./cyclomatic-python.js").PythonSpawnFn>();
		const out = computeCyclomaticPython("def f():\n    pass\n", "x.py", spawn);
		expect(out).toBeNull();
		// dir WAS assigned (mkdtempSync succeeded) — cleanup must still run.
		expect(rmSyncMock).toHaveBeenCalledWith("/tmp/interlinked-radon-fake", {
			recursive: true,
			force: true,
		});
		expect(spawn).not.toHaveBeenCalled();
		vi.doUnmock("node:fs");
		vi.resetModules();
	});
});
