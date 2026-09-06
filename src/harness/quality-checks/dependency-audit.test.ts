// Unit tests for src/harness/quality-checks/dependency-audit.ts.
//
// node:child_process is mocked so `hasOsvScanner()`'s spawnSync can be made
// to throw (exercising its catch fallback) without depending on whether
// osv-scanner is actually installed on the machine running the suite.
// ../check-engine/spawn-async.js is mocked the same way so the async
// resolver's osv-scanner probe is deterministic and never spawns a real
// process. Neither mock touches dependency-audit.ts itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));
vi.mock("../check-engine/spawn-async.js", () => ({
	runProcessAsync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { runProcessAsync } from "../check-engine/spawn-async.js";
import {
	_resetOsvScannerCache,
	hasOsvScanner,
	resolveDependencyAuditCommandAsync,
	resolveKnownAuditCommand,
} from "./dependency-audit.js";

const spawnMock = vi.mocked(spawnSync);
const runProcessAsyncMock = vi.mocked(runProcessAsync);

beforeEach(() => {
	_resetOsvScannerCache();
	spawnMock.mockReset();
	runProcessAsyncMock.mockReset();
});

afterEach(() => {
	_resetOsvScannerCache();
});

describe("hasOsvScanner — spawnSync throws", () => {
	it("returns false when spawnSync throws (osv-scanner unavailable, e.g. ENOENT)", () => {
		spawnMock.mockImplementationOnce(() => {
			throw new Error("spawnSync ENOENT");
		});
		expect(hasOsvScanner()).toBe(false);
	});

	it("memoizes the false result so a later call to hasOsvScanner does not spawn again", () => {
		spawnMock.mockImplementationOnce(() => {
			throw new Error("spawnSync ENOENT");
		});
		hasOsvScanner();
		const second = hasOsvScanner();
		expect(second).toBe(false);
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});
});

describe("resolveDependencyAuditCommandAsync — osv-scanner probe via runProcessAsync", () => {
	it("prefers osv-scanner when the async probe exits 0", async () => {
		runProcessAsyncMock.mockResolvedValueOnce({
			stdout: "",
			stderr: "",
			code: 0,
			timedOut: false,
			killed: false,
		});
		const r = await resolveDependencyAuditCommandAsync("go.mod");
		expect(r?.parser).toBe("osv-scanner");
		expect(r?.cmd).toEqual(["osv-scanner", "scan", "source", "--format=json", "--lockfile=go.mod"]);
	});

	it("falls back to the ecosystem tool when the async probe times out", async () => {
		runProcessAsyncMock.mockResolvedValueOnce({
			stdout: "",
			stderr: "",
			code: null,
			timedOut: true,
			killed: false,
		});
		const r = await resolveDependencyAuditCommandAsync("Cargo.toml");
		expect(r?.parser).toBe("cargo-audit");
		expect(r?.cmd).toEqual(["cargo", "audit", "--json"]);
	});

	it("falls back to the ecosystem tool when the async probe exits non-zero", async () => {
		runProcessAsyncMock.mockResolvedValueOnce({
			stdout: "",
			stderr: "",
			code: 1,
			timedOut: false,
			killed: false,
		});
		const r = await resolveDependencyAuditCommandAsync("requirements.txt");
		expect(r?.parser).toBe("pip-audit");
	});

	it("returns null without probing osv-scanner for a filename outside the lockfile set", async () => {
		const r = await resolveDependencyAuditCommandAsync("Dockerfile");
		expect(r).toBeNull();
		expect(runProcessAsyncMock).not.toHaveBeenCalled();
	});

	it("skips the probe entirely when useOsvScanner:false", async () => {
		const r = await resolveDependencyAuditCommandAsync("go.sum", { useOsvScanner: false });
		expect(r?.parser).toBe("govulncheck");
		expect(runProcessAsyncMock).not.toHaveBeenCalled();
	});

	it("memoizes the availability result across repeated async resolutions", async () => {
		runProcessAsyncMock.mockResolvedValueOnce({
			stdout: "",
			stderr: "",
			code: 0,
			timedOut: false,
			killed: false,
		});
		const first = await resolveDependencyAuditCommandAsync("go.mod");
		const second = await resolveDependencyAuditCommandAsync("package.json");
		expect(first?.parser).toBe("osv-scanner");
		expect(second?.parser).toBe("osv-scanner");
		expect(runProcessAsyncMock).toHaveBeenCalledTimes(1);
	});

	it("shares the memoized availability flag set by the sync hasOsvScanner probe", async () => {
		// hasOsvScanner() (sync) populates the cache; the async resolver must
		// read it back rather than issuing its own runProcessAsync probe.
		spawnMock.mockReturnValueOnce({ status: 0 } as never);
		hasOsvScanner();
		const r = await resolveDependencyAuditCommandAsync("Pipfile.lock");
		expect(r?.parser).toBe("osv-scanner");
		expect(runProcessAsyncMock).not.toHaveBeenCalled();
	});
});

describe("resolveKnownAuditCommand — exhausted ecosystem fallthrough", () => {
	it("returns null for a lockfile-shaped name matched by none of the ecosystem branches", () => {
		// Reachable only when the caller has already validated the filename
		// against a set resolveKnownAuditCommand itself does not check;
		// exercises the trailing fallthrough after every named branch misses.
		const r = resolveKnownAuditCommand("composer.lock", {}, false);
		expect(r).toBeNull();
	});
});
