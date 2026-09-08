import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process BEFORE importing the SUT so the SUT captures the mock.
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { _resetOsvScannerCache, resolveDependencyAuditCommand } from "./dependency-audit.js";

const spawnMock = vi.mocked(spawnSync);

function spawnResult(status: number): ReturnType<typeof spawnSync> {
	return { status, signal: null, pid: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: [] };
}

beforeEach(() => {
	_resetOsvScannerCache();
	spawnMock.mockReset();
});

afterEach(() => {
	_resetOsvScannerCache();
});

describe("resolveDependencyAuditCommand — osv-scanner preference", () => {
	it("prefers osv-scanner for go.mod when installed", () => {
		spawnMock.mockReturnValueOnce(spawnResult(0));
		const r = resolveDependencyAuditCommand("go.mod");
		expect(r?.parser).toBe("osv-scanner");
		expect(r?.cmd).toEqual([
			"osv-scanner",
			"scan",
			"source",
			"--format=json",
			"--lockfile=go.mod",
		]);
	});

	it("prefers osv-scanner for package.json when installed", () => {
		spawnMock.mockReturnValueOnce(spawnResult(0));
		const r = resolveDependencyAuditCommand("package.json");
		expect(r?.parser).toBe("osv-scanner");
		expect(r?.cmd.at(-1)).toBe("--lockfile=package.json");
	});

	it("appends --offline when offline:true", () => {
		spawnMock.mockReturnValueOnce(spawnResult(0));
		const r = resolveDependencyAuditCommand("go.mod", { offline: true });
		expect(r?.cmd).toContain("--offline");
	});

	it("falls back to per-ecosystem when osv-scanner missing", () => {
		spawnMock.mockReturnValueOnce(spawnResult(1)); // --version fails
		const r = resolveDependencyAuditCommand("go.mod");
		expect(r?.parser).toBe("govulncheck");
		expect(r?.cmd[0]).toBe("govulncheck");
	});

	it("honors useOsvScanner:false even when osv-scanner is installed", () => {
		// No spawn call should happen because the flag short-circuits before
		// hasOsvScanner() is consulted.
		const r = resolveDependencyAuditCommand("Cargo.toml", { useOsvScanner: false });
		expect(r?.parser).toBe("cargo-audit");
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("returns null for unrecognised filenames", () => {
		const r = resolveDependencyAuditCommand("unknown.txt", { useOsvScanner: false });
		expect(r).toBeNull();
	});

	it("memoizes the osv-scanner availability check", () => {
		spawnMock.mockReturnValueOnce(spawnResult(0));
		resolveDependencyAuditCommand("go.mod");
		resolveDependencyAuditCommand("package.json");
		resolveDependencyAuditCommand("Cargo.toml");
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});
});
