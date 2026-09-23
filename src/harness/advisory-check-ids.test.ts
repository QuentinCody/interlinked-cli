// ===========================================
// Advisory-tier check ids — parity + surface tests
// ===========================================
// The load-bearing assertion here is PARITY: the harness-side
// `ADVISORY_CHECK_IDS` must stay identical to the verify command's
// `DEFAULT_ADVISORY_SKIPS` until advisory.ts re-exports from this module.
// A drifted pair would let `persistent_warning_escalation` amplify a
// check that verify itself treats as advisory-tier noise.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_ADVISORY_SKIPS } from "../commands/verify/advisory.js";
import { CHECK_REGISTRY } from "./check-registry/index.js";

it("keeps repeated implementation advice nonblocking and outside default verification", () => {
    expect(CHECK_REGISTRY.find(row => row.id === "repeated_implementation"))
        .toMatchObject({ phase: "post", severity: "warning", determinism: "heuristic" });
    expect(DEFAULT_ADVISORY_SKIPS.has("repeated_implementation")).toBe(true);
});
import { ADVISORY_CHECK_IDS, isAdvisoryCheckId } from "./advisory-check-ids.js";
import { checkRegistryParity, loadRegistryParityConfig } from "./registry-parity.js";

// Repo root, resolved the same way as check-evidence/contract.test.ts's
// self-check tests — robust to how vitest is invoked, unlike process.cwd().
const REPO_ROOT = resolve(import.meta.dirname, "../..");

describe("ADVISORY_CHECK_IDS", () => {
	it("is set-equal to DEFAULT_ADVISORY_SKIPS (no drift while both definitions exist)", () => {
		// Sorted-array comparison so a failure names the exact drifted ids.
		expect([...ADVISORY_CHECK_IDS].sort()).toEqual([...DEFAULT_ADVISORY_SKIPS].sort());
	});

	it("contains the known advisory heuristics the escalation FP was built on", () => {
		expect(ADVISORY_CHECK_IDS.has("magic_literal_in_conditional")).toBe(true);
		expect(ADVISORY_CHECK_IDS.has("complexity")).toBe(true);
		expect(ADVISORY_CHECK_IDS.has("ubs_magic_number_no_const")).toBe(true);
	});

	it("does NOT contain default-gate check ids", () => {
		expect(ADVISORY_CHECK_IDS.has("typescript")).toBe(false);
		expect(ADVISORY_CHECK_IDS.has("nan_coercion_guard")).toBe(false);
		expect(ADVISORY_CHECK_IDS.has("floating_promises")).toBe(false);
	});
});

describe("isAdvisoryCheckId", () => {
	it("returns true for advisory ids and false for default-gate ids", () => {
		expect(isAdvisoryCheckId("write_without_mkdir")).toBe(true);
		expect(isAdvisoryCheckId("typescript")).toBe(false);
		expect(isAdvisoryCheckId("")).toBe(false);
	});
});

describe("registry-parity config declares the ADVISORY_CHECK_IDS <-> DEFAULT_ADVISORY_SKIPS pair", () => {
	// Belt-and-suspenders on top of the set-equality test above: that test
	// breaks only if BOTH modules are imported into the same test process.
	// The generic .interlinked/registry-parity.json mechanism instead
	// extracts each side straight from source text, so it also runs
	// per-edit (registry-parity-phase.ts) and at `interlinked verify` —
	// surfaces drift even when nothing imports the other side's module.
	it("registers a pair for the two files and reports no drift against the real repo", () => {
		const config = loadRegistryParityConfig(REPO_ROOT);
		expect(config).not.toBeNull();
		const pair = config?.pairs.find(
			(p) =>
				p.left.file === "src/harness/advisory-check-ids.ts" &&
				p.right.file === "src/commands/verify/advisory.ts",
		);
		expect(pair).toBeDefined();
		if (!pair) return;
		const findings = checkRegistryParity({ pairs: [pair] }, REPO_ROOT);
		// A non-empty result names the exact drifted ids + both files —
		// more useful in a failure message than a bare boolean.
		expect(findings).toEqual([]);
	});
});
