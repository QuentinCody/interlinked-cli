// Integration tests for the biome diff-overlay gate.
// These actually invoke biome via `npx biome check`, so each case takes
// ~100-300ms. Acceptable for ~5 tests total.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getOrCreateEngine } from "../check-engine/index.js";
import { writeDiagnosticCache } from "../check-engine/diagnostic-cache.js";
import { _setTscOverlayModeOverrideForTest } from "../check-engine/tool-runners/tsc-overlay.js";
import {
	_isRelativeModuleNotFound,
	evaluateBiomeDiffOverlay,
	evaluateTscDiffOverlay,
} from "../diff-overlay.js";
import { tryAcquireProjectCompilerLease } from "../project-compiler-gate.js";
import { sweepStaleFixtureDirs } from "./fixture-hygiene.js";

type Diag = Parameters<typeof _isRelativeModuleNotFound>[0];
const diag = (message: string): Diag => ({ message });

describe("_isRelativeModuleNotFound — TDD red-step detection", () => {
	it("matches a relative sibling module-not-found", () => {
		expect(
			_isRelativeModuleNotFound(diag("Cannot find module './corpus.js' or its type declarations.")),
		).toBe(true);
	});
	it("matches a parent-relative module-not-found", () => {
		expect(_isRelativeModuleNotFound(diag("Cannot find module '../types.js'."))).toBe(true);
	});
	it("does NOT match a bare package module-not-found", () => {
		expect(_isRelativeModuleNotFound(diag("Cannot find module 'react'."))).toBe(false);
	});
	it("does NOT match an unrelated implicit-any diagnostic", () => {
		expect(_isRelativeModuleNotFound(diag("Parameter 'x' implicitly has an 'any' type."))).toBe(
			false,
		);
	});
	it("handles an empty diagnostic message", () => {
		expect(_isRelativeModuleNotFound(diag(""))).toBe(false);
	});
});

// NB: for this file CLI_ROOT resolves to `src/harness` (two levels up from
// `src/harness/__tests__`), and that is exactly the `projectRoot` the overlay is
// called with — biome/tsc config is found by walking UP from there to the repo
// root. (It is NOT the repo root; don't "fix" it.)
const CLI_ROOT = resolve(import.meta.dirname, "../..");
// Fixtures live in a UNIQUE per-process `mkdtempSync` dir, so no two test files
// (or parallel runs) ever write the same path — the parallel-safety invariant
// (the prior fixed `<CLI_ROOT>/lib` path raced sibling overlay tests under
// `--file-parallelism`, flipping findings to empty). The dir is rooted under
// CLI_ROOT (not os.tmpdir()) for a hard toolchain reason: the check-engine
// rewrites biome overlay findings to a path RELATIVE to projectRoot and then
// filters to that file (index.ts getBiomeDiagnosticsForOverlay). A fixture
// OUTSIDE projectRoot yields a `../…`-laden relative path the filter drops →
// silent zero findings. Rooting under CLI_ROOT (== projectRoot) makes the
// rewrite+filter agree, and biome.json / tsconfig still resolve up-tree. The
// `_…fixtures-` name is skipped by the strip-brace corpus walk.
sweepStaleFixtureDirs(CLI_ROOT);
const FIXTURE_DIR = mkdtempSync(resolve(CLI_ROOT, "_diff_overlay_fixtures-"));
const FIXTURE_FILE = resolve(FIXTURE_DIR, "_overlay_fixture.ts");

const CLEAN_CONTENT = `// overlay test fixture
export function identity<T>(x: T): T {
	return x;
}
`;

describe("evaluateBiomeDiffOverlay", () => {
	beforeAll(() => {
		// FIXTURE_DIR already exists (mkdtempSync created it at module load).
		writeFileSync(FIXTURE_FILE, CLEAN_CONTENT);
		// Warm biome — under parallel test load, npx biome's cold-start can
		// exceed the 500ms overlay budget on the first call, which surfaces
		// as a spurious empty-findings result. One warm invocation primes
		// the npm cache so the assertion runs have stable timing.
		evaluateBiomeDiffOverlay(FIXTURE_FILE, CLEAN_CONTENT, CLI_ROOT);
	}, 30_000);

	afterAll(() => {
		try {
			rmSync(FIXTURE_DIR, { recursive: true, force: true });
		} catch {
			// intentional: best-effort cleanup
		}
	});

	it("returns no findings when proposed content matches disk", () => {
		const onDisk = readFileSync(FIXTURE_FILE, "utf-8");
		const result = evaluateBiomeDiffOverlay(FIXTURE_FILE, onDisk, CLI_ROOT);
		expect(result.newFindings).toEqual([]);
		expect(result.elapsedMs).toBe(0);
	});

	it("returns no findings on an unrelated whitespace change", () => {
		const onDisk = readFileSync(FIXTURE_FILE, "utf-8");
		// Collapse a blank line — doesn't change any biome-flaggable content.
		const proposed = onDisk.replace(/\n\n/g, "\n");
		const result = evaluateBiomeDiffOverlay(FIXTURE_FILE, proposed, CLI_ROOT);
		expect(result.newFindings).toEqual([]);
	});

	// Retry on rare flake: under parallel full-suite load, npx biome's
	// cold-start can overshoot the per-file overlay budget. The warm-up
	// call in beforeAll handles most of this; retry covers the remainder.
	it("flags a newly introduced noSelfCompare / noDoubleEquals violation", { retry: 2 }, () => {
		const onDisk = readFileSync(FIXTURE_FILE, "utf-8");
		const proposed = `${onDisk}\nexport function _probe() {\n\treturn 1 == 1;\n}\n`;
		const result = evaluateBiomeDiffOverlay(FIXTURE_FILE, proposed, CLI_ROOT);
		expect(result.newFindings.length).toBeGreaterThan(0);
		const ruleIds = result.newFindings.map((f) => f.ruleId).join(",");
		expect(ruleIds).toMatch(/noSelfCompare|noDoubleEquals/);
	});

	it("returns empty findings when the target file doesn't exist on disk (new file)", () => {
		const nonExistent = resolve(FIXTURE_DIR, "_does_not_exist_overlay.ts");
		const result = evaluateBiomeDiffOverlay(nonExistent, "export const x = 1;\n", CLI_ROOT);
		// No "before" state → an empty baseline. Clean proposed content still
		// yields zero findings, but the overlay engine genuinely runs (no
		// early-return for missing files as of 2e7ec85), so elapsedMs is real.
		expect(result.newFindings).toEqual([]);
		expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
	});

	it("returns empty for files with non-JS/TS extensions", () => {
		const result = evaluateBiomeDiffOverlay(FIXTURE_FILE.replace(".ts", ".md"), "x", CLI_ROOT);
		expect(result.newFindings).toEqual([]);
	});

	it("excludes a pre-existing cached biome finding from newFindings (preEdit cache hit)", () => {
		// Every other case above hits the cache MISS default (empty array) — this
		// is the only one where a real cached pre-edit finding is present, so
		// `preEdit = existsOnDisk ? engine.getCachedDiagnostics(...).filter(...) : []`
		// actually iterates a non-empty array.
		const doubleEqualsFile = resolve(FIXTURE_DIR, "_overlay_double_equals.ts");
		const existingViolation = `${CLEAN_CONTENT}\nexport function existingDoubleEquals(a: number, b: number): boolean {\n\treturn a == b;\n}\n`;
		writeFileSync(doubleEqualsFile, existingViolation);

		// Prime the diagnostic cache the SAME way `CheckEngine.getDiagnostics`
		// itself does (writeDiagnosticCache, keyed by the file's current mtime),
		// using a REAL biome run against the on-disk content for the exact `file`
		// path shape the second (proposed-content) run below will also produce.
		const engine = getOrCreateEngine(CLI_ROOT);
		const preEditReal = engine.getBiomeDiagnosticsForOverlay(doubleEqualsFile, existingViolation, 2_000);
		expect(preEditReal.some((f) => f.ruleId?.includes("noDoubleEquals"))).toBe(true);
		writeDiagnosticCache(doubleEqualsFile, preEditReal);

		// Proposed content keeps the `a == b` violation (still present, matches
		// the cached preKey) and adds a DIFFERENT rule violation (`c === c`,
		// noSelfCompare — not noDoubleEquals, so it can't collapse into the same
		// key as the pre-existing finding).
		const proposed = `${existingViolation}\nexport function newSelfCompareStrict(c: number): boolean {\n\treturn c === c;\n}\n`;
		const result = evaluateBiomeDiffOverlay(doubleEqualsFile, proposed, CLI_ROOT);
		// Only the genuinely NEW violation surfaces; the cached pre-existing one
		// is excluded even though it is still present in the overlay's full answer.
		expect(result.newFindings.length).toBe(1);
		expect(result.newFindings[0]?.ruleId).toContain("noSelfCompare");
	});
});

// The tsc overlay's typed "unavailable" and "skipped" outcomes are otherwise
// only exercised via a fully-mocked engine (diff-overlay-engine-mock.test.ts,
// which always returns "ok") — these two real, unmocked paths need this file.
//
// Own project root (NOT CLI_ROOT / FIXTURE_DIR): the compiler-lease test below
// acquires a REAL cross-process lease keyed by this exact path, and CLI_ROOT is
// the real repo root other concurrent test/daemon activity may itself be
// leasing — colliding with that would make the "sanity: lease was free" check
// flaky for a reason unrelated to this test.
describe("evaluateTscDiffOverlay — unavailable / skipped overlay outcomes", () => {
	const LEASE_ROOT = mkdtempSync(resolve(CLI_ROOT, "_diff_overlay_tsc_fixtures-"));

	afterEach(() => {
		_setTscOverlayModeOverrideForTest(null);
	});

	afterAll(() => {
		try {
			rmSync(LEASE_ROOT, { recursive: true, force: true });
		} catch {
			// intentional: best-effort cleanup
		}
	});

	it("sets checkerUnavailable when another compiler already owns the project", () => {
		_setTscOverlayModeOverrideForTest("in-process");
		// Hold the project's compiler lease ourselves — a REAL "in flight"
		// compiler, the same admission-control seam runTscOverlayTyped's
		// in-process mode itself uses. Its own attempt to acquire the lease
		// below must fail exactly as it would against a second live sidecar.
		const release = tryAcquireProjectCompilerLease(LEASE_ROOT);
		expect(release).not.toBeNull(); // sanity: the lease really was free first
		try {
			const result = evaluateTscDiffOverlay(
				resolve(LEASE_ROOT, "_does_not_exist_tsc_unavailable.ts"),
				"export const z = 1;\n",
				LEASE_ROOT,
			);
			expect(result.checkerUnavailable).toBe(
				"in-process TypeScript overlay deferred because another compiler owns this project",
			);
			expect(result.proposedFindings).toBeNull();
			expect(result.newFindings).toEqual([]);
		} finally {
			release?.();
		}
	});

	it("returns a null proposedFindings (not checked-clean) when tsc_overlay.mode is off", () => {
		_setTscOverlayModeOverrideForTest("off");
		const result = evaluateTscDiffOverlay(
			resolve(LEASE_ROOT, "_does_not_exist_tsc_skipped.ts"),
			"export const z = 2;\n",
			LEASE_ROOT,
		);
		// "skipped" must stay distinct from "checked clean": newFindings is
		// vacuously empty, but proposedFindings is null (never []) so a caller
		// can't read this as "tsc looked and found nothing".
		expect(result.newFindings).toEqual([]);
		expect(result.proposedFindings).toBeNull();
		expect(result.checkerUnavailable).toBeUndefined();
	});
});
