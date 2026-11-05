// Regression pin for the suite-wide HOME sandbox (real-user-data leak class,
// found 2026-08-10: Stryker mutants of `INTERLINKED_HOME ?? homedir()` routed
// corpus writes into the REAL ~/.interlinked — 1443 fixture rows). The sandbox
// must (a) be active in every worker, (b) capture os.homedir() itself so
// mutated production fallbacks still land in the sandbox, and (c) stay wired
// in BOTH vitest configs, or mutation runs silently lose the protection.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_SANDBOX_HOME } from "./home-sandbox.js";
import { OWNER_ENV, recordVerificationStage, STAGES_LEDGER_ENV, STAGE_ENV, stageFromEnvironment, TRACE_ENV } from "../harness/verification-stages.js";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("home-sandbox — verification telemetry isolation", () => {
	// test-contract: invariant — nested fixture checks must never enter the enclosing push ledger or inherit its trace; only the worker environment is cleared.
	it("isolates a worker's fixture writes while retaining the parent push environment and ledger", () => {
		const root = mkdtempSync(join(tmpdir(), "telemetry-sandbox-"));
		roots.push(root);
		const ledger = join(root, "parent-stages.jsonl"), before = "parent push ledger\n";
		writeFileSync(ledger, before);
		const inherited = { [STAGE_ENV]: "push", [STAGES_LEDGER_ENV]: ledger, [TRACE_ENV]: "parent-push-0001", [OWNER_ENV]: "git-hook" };
		for (const [key, value] of Object.entries(inherited)) vi.stubEnv(key, value);
		const script = `
			await import(${JSON.stringify(new URL("./home-sandbox.ts", import.meta.url).href)});
			const { recordVerificationStage, stageFromEnvironment } = await import(${JSON.stringify(new URL("../harness/verification-stages.ts", import.meta.url).href)});
			const recorded = recordVerificationStage(process.argv[1], { stage: stageFromEnvironment("cli"), check: "fixture-check", status: "passed", identity: null, reused: false });
			console.log(JSON.stringify({ recorded, cleared: ${JSON.stringify(Object.keys(inherited))}.every(key => process.env[key] === undefined) }));
		`;
		const result = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root], { encoding: "utf8", timeout: 10_000 });
		expect(JSON.parse(result)).toEqual({ recorded: true, cleared: true });
		expect(readFileSync(ledger, "utf8")).toBe(before);
		const row = JSON.parse(readFileSync(join(root, ".interlinked", "verification-stages.jsonl"), "utf8"));
		expect(row).toMatchObject({ stage: "cli", check: "fixture-check" });
		expect(row).not.toHaveProperty("trace");
		expect(row).not.toHaveProperty("owner");
		for (const [key, value] of Object.entries(inherited)) expect(process.env[key]).toBe(value);
	});

	// test-contract: public-api — clearing ambient telemetry at worker startup still permits explicit per-test environment overrides.
	it("honors a test's explicit stage, ledger, trace and owner overrides", () => {
		const root = mkdtempSync(join(tmpdir(), "telemetry-override-"));
		roots.push(root);
		const ledger = join(root, "explicit-stages.jsonl");
		vi.stubEnv(STAGE_ENV, "push");
		vi.stubEnv(STAGES_LEDGER_ENV, ledger);
		vi.stubEnv(TRACE_ENV, "explicit-test-0001");
		vi.stubEnv(OWNER_ENV, "scheduler");
		expect(recordVerificationStage(root, { stage: stageFromEnvironment("cli"), check: "explicit-check", status: "passed", identity: null, reused: false })).toBe(true);
		expect(JSON.parse(readFileSync(ledger, "utf8"))).toMatchObject({ stage: "push", check: "explicit-check", trace: "explicit-test-0001", owner: "scheduler" });
	});
});

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
