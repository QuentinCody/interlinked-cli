import { describe, expect, it } from "vitest";
import { _resetGlobCache } from "../lib/path-glob.js";
import { DEFAULT_CONFIG } from "./rules/default-config.js";
import { buildSkipReport, shouldSkipPath } from "./skip-paths.js";
import type { GuardRulesConfig } from "./types.js";

function withSkipPaths(skipPaths: string[] | undefined): GuardRulesConfig {
	// Clone the shipped default and override only the skip_paths slot. Avoids
	// rebuilding every inner config shape (taint, structural, output_scanning,
	// ...) and keeps the test honest against the real config surface.
	const cfg = structuredClone(DEFAULT_CONFIG);
	if (skipPaths === undefined) {
		delete cfg.skip_paths;
	} else {
		cfg.skip_paths = skipPaths;
	}
	return cfg;
}

describe("shouldSkipPath", () => {
	it("returns false when skip_paths is undefined", () => {
		_resetGlobCache();
		const cfg = withSkipPaths(undefined);
		expect(shouldSkipPath("dist/index.js", cfg)).toBe(false);
	});

	it("returns false when skip_paths is empty", () => {
		_resetGlobCache();
		const cfg = withSkipPaths([]);
		expect(shouldSkipPath("dist/index.js", cfg)).toBe(false);
	});

	it("returns true when path matches a glob in skip_paths", () => {
		_resetGlobCache();
		const cfg = withSkipPaths(["dist/**"]);
		expect(shouldSkipPath("dist/index.js", cfg)).toBe(true);
	});

	it("returns false when no glob matches the path", () => {
		_resetGlobCache();
		const cfg = withSkipPaths(["dist/**", "build/**"]);
		expect(shouldSkipPath("src/lib/foo.ts", cfg)).toBe(false);
	});

	it("returns true on the first matching glob in a multi-entry list", () => {
		_resetGlobCache();
		const cfg = withSkipPaths(["unrelated/**", "node_modules/**"]);
		expect(shouldSkipPath("node_modules/foo/bar.js", cfg)).toBe(true);
	});

	it("returns false for an empty file path even with globs configured", () => {
		_resetGlobCache();
		const cfg = withSkipPaths(["dist/**"]);
		expect(shouldSkipPath("", cfg)).toBe(false);
	});

	it("matches all the shipped default globs against representative paths", () => {
		_resetGlobCache();
		const cfg = withSkipPaths(undefined);
		// undefined skip_paths must NOT skip — caller is responsible for using
		// the shipped defaults via the resolved config layer.
		expect(shouldSkipPath("dist/index.js", cfg)).toBe(false);
	});

	it("matches a path against the shipped DEFAULT_CONFIG.skip_paths", () => {
		_resetGlobCache();
		// Use the actual shipped defaults (no override) and verify dist/** hits.
		const cfg = structuredClone(DEFAULT_CONFIG);
		expect(shouldSkipPath("dist/index.js", cfg)).toBe(true);
		expect(shouldSkipPath("src/lib/foo.ts", cfg)).toBe(false);
	});
});

describe("buildSkipReport", () => {
	it("returns an empty results array", () => {
		const report = buildSkipReport();
		expect(report.results).toEqual([]);
	});

	it("returns empty toolsRun and toolsSkipped arrays", () => {
		const report = buildSkipReport();
		expect(report.toolsRun).toEqual([]);
		expect(report.toolsSkipped).toEqual([]);
	});

	it("returns empty metrics and zero dedupCount", () => {
		const report = buildSkipReport();
		expect(report.metrics).toEqual([]);
		expect(report.deduplicatedCount).toBe(0);
	});

	it("includes a single skip entry with the canonical shape", () => {
		const report = buildSkipReport();
		expect(report.skipped).toHaveLength(1);
		expect(report.skipped[0]).toEqual({
			check: "*",
			reason: "skip_paths matched",
			category: "config_disabled",
		});
	});

	it("records elapsed time as a non-negative number", () => {
		const report = buildSkipReport();
		expect(typeof report.elapsedMs).toBe("number");
		expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
	});
});
