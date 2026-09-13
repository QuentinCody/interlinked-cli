// Regression pin for the suite-wide HOME sandbox (real-user-data leak class,
// found 2026-08-10: Stryker mutants of `INTERLINKED_HOME ?? homedir()` routed
// corpus writes into the REAL ~/.interlinked — 1443 fixture rows). The sandbox
// must (a) be active in every worker, (b) capture os.homedir() itself so
// mutated production fallbacks still land in the sandbox, and (c) stay wired
// in BOTH vitest configs, or mutation runs silently lose the protection.
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_SANDBOX_HOME } from "./home-sandbox.js";

describe("home-sandbox — positive (must hold in every worker)", () => {
	it("keeps lease and subprocess temporary files inside the test sandbox", () => {
		expect(tmpdir()).toBe(process.env.TMPDIR);
		expect(tmpdir()).toMatch(/^\/tmp\/il-/);
	});
	it("P1: HOME points at the per-worker sandbox, not a real home", () => {
		expect(process.env.HOME).toBe(TEST_SANDBOX_HOME);
		expect(TEST_SANDBOX_HOME.startsWith(tmpdir())).toBe(true);
	});

	it("P2: os.homedir() resolves into the sandbox (mutation-proof fallback)", () => {
		// This is the load-bearing property: even if a mutant deletes an
		// INTERLINKED_HOME override branch, homedir()-derived paths stay
		// inside the sandbox.
		expect(homedir()).toBe(TEST_SANDBOX_HOME);
	});

	it("P3: INTERLINKED_HOME is NOT set by the sandbox (it relocates the data dir, not the home)", () => {
		// Suite-wide INTERLINKED_HOME collapses per-test-cwd .interlinked data
		// dirs into one shared dir (218 failures, 2026-08-10). The sandbox owns
		// HOME only; tests exercising the override set it themselves.
		expect(process.env.INTERLINKED_HOME).toBeUndefined();
	});
});

describe("home-sandbox — wiring pin (must not drift)", () => {
	const root = join(import.meta.dirname, "..", "..");

	it("P4: vitest.config.ts loads the sandbox before any test", () => {
		const config = readFileSync(join(root, "vitest.config.ts"), "utf8");
		expect(config).toContain("src/test-setup/home-sandbox.ts");
	});

	it("P5: vitest.stryker.config.ts loads it too — mutation runs are the class that bit", () => {
		const config = readFileSync(join(root, "vitest.stryker.config.ts"), "utf8");
		expect(config).toContain("src/test-setup/home-sandbox.ts");
	});
});
