// Tests for the per-edit registry-parity PostToolUse phase.
//
// The phase re-runs the config-driven registry-parity detector
// (src/harness/registry-parity.ts) scoped to just the pair(s) whose LEFT or
// RIGHT file was touched by THIS edit, and surfaces drift as a non-blocking
// warning. Each test uses a per-test tmpdir with a synthetic
// .interlinked/registry-parity.json + source files, independent of this
// repo's actual registries (same convention as registry-parity.test.ts).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { REGISTRY_PARITY_CONFIG_PATH } from "../registry-parity.js";
import type { HarnessDecision } from "../types.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import { runRegistryParityPhase } from "./registry-parity-phase.js";
import { makeServerRuntime, makePerFileCheckCtx } from "./__tests__/fixtures.js";
import type { ServerRuntime } from "./runtime-context.js";

function makeFixture(): {
	root: string;
	ctx: ServerRuntime;
	decision: HarnessDecision;
	acc: PerFileCheckCtx;
} {
	const root = mkdtempSync(join(tmpdir(), "registry-parity-phase-"));
	const ctx = makeServerRuntime({ cwd: root });
	const decision: HarnessDecision = { decision: "allow" };
	const acc = makePerFileCheckCtx();
	return { root, ctx, decision, acc };
}

function writeConfig(root: string, config: unknown): void {
	const full = join(root, REGISTRY_PARITY_CONFIG_PATH);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, JSON.stringify(config));
}

function pairConfig(extra: Record<string, unknown> = {}) {
	return {
		pairs: [
			{
				name: "test-pair",
				left: { file: "left.ts", key_re: 'check:\\s*"([a-z]+)"' },
				right: { file: "right.ts", key_re: 'check:\\s*"([a-z]+)"' },
				...extra,
			},
		],
	};
}

describe("runRegistryParityPhase", () => {
	const fixtures: string[] = [];
	afterAll(() => {
		for (const root of fixtures) rmSync(root, { recursive: true, force: true });
	});

	// --- positive (must fire) ---

	it("P1: editing the LEFT file of a drifted pair surfaces a warning naming both files + the id", () => {
		const { root, ctx, decision, acc } = makeFixture();
		fixtures.push(root);
		writeConfig(root, pairConfig());
		writeFileSync(join(root, "left.ts"), 'check: "alpha"\ncheck: "beta"');
		writeFileSync(join(root, "right.ts"), 'check: "alpha"');
		runRegistryParityPhase(ctx, join(root, "left.ts"), true, decision, acc);
		expect(decision.warnings?.length).toBe(1);
		const w = decision.warnings?.[0] ?? "";
		expect(w).toContain("[interlinked:registry-parity]");
		expect(w).toContain("left.ts");
		expect(w).toContain("right.ts");
		expect(w).toContain("beta");
		expect(acc.checksRan).toContain("registry_parity");
		expect(acc.allCheckResults[0]).toEqual(
			expect.objectContaining({
				source: "registry_parity",
				name: "registry_parity",
				severity: "warning",
			}),
		);
	});

	it("P2: editing the RIGHT file of the SAME drifted pair also fires (symmetric trigger)", () => {
		const { root, ctx, decision, acc } = makeFixture();
		fixtures.push(root);
		writeConfig(root, pairConfig());
		writeFileSync(join(root, "left.ts"), 'check: "alpha"\ncheck: "beta"');
		writeFileSync(join(root, "right.ts"), 'check: "alpha"');
		runRegistryParityPhase(ctx, join(root, "right.ts"), true, decision, acc);
		expect(decision.warnings?.length).toBe(1);
		expect(decision.warnings?.[0]).toContain("beta");
	});

	it("P3: multiple drifted ids produce one warning line each", () => {
		const { root, ctx, decision, acc } = makeFixture();
		fixtures.push(root);
		writeConfig(root, pairConfig());
		writeFileSync(join(root, "left.ts"), 'check: "alpha"\ncheck: "beta"\ncheck: "gamma"');
		writeFileSync(join(root, "right.ts"), "");
		runRegistryParityPhase(ctx, join(root, "left.ts"), true, decision, acc);
		expect(decision.warnings?.length).toBe(3);
		const joined = (decision.warnings ?? []).join("\n");
		expect(joined).toContain("alpha");
		expect(joined).toContain("beta");
		expect(joined).toContain("gamma");
	});

	it("P4: tags the finding [proven] (exact declared-regex extraction, no interpretation)", () => {
		const { root, ctx, decision, acc } = makeFixture();
		fixtures.push(root);
		writeConfig(root, pairConfig());
		writeFileSync(join(root, "left.ts"), 'check: "alpha"\ncheck: "beta"');
		writeFileSync(join(root, "right.ts"), 'check: "alpha"');
		runRegistryParityPhase(ctx, join(root, "left.ts"), true, decision, acc);
		expect(decision.warnings?.[0]).toContain("[proven]");
		expect(acc.allCheckResults[0]).toEqual(
			expect.objectContaining({ determinism: "fully_deterministic" }),
		);
	});

	it("P5: caps per-edit warnings at 5 and appends an overflow summary line", () => {
		const { root, ctx, decision, acc } = makeFixture();
		fixtures.push(root);
		writeConfig(root, pairConfig());
		const ids = ["a", "b", "c", "d", "e", "f", "g"];
		writeFileSync(
			join(root, "left.ts"),
			ids.map((id) => `check: "${id}"`).join("\n"),
		);
		writeFileSync(join(root, "right.ts"), "");
		runRegistryParityPhase(ctx, join(root, "left.ts"), true, decision, acc);
		expect(decision.warnings?.length).toBe(6);
		expect(decision.warnings?.[5]).toContain("…and 2 more");
	});

	it("P6: appends onto an existing decision.warnings array instead of replacing it", () => {
		const { root, ctx, acc } = makeFixture();
		fixtures.push(root);
		writeConfig(root, pairConfig());
		writeFileSync(join(root, "left.ts"), 'check: "alpha"\ncheck: "beta"');
		writeFileSync(join(root, "right.ts"), 'check: "alpha"');
		const decision: HarnessDecision = { decision: "allow", warnings: ["PRE-EXISTING"] };
		runRegistryParityPhase(ctx, join(root, "left.ts"), true, decision, acc);
		expect(decision.warnings?.[0]).toBe("PRE-EXISTING");
		expect(decision.warnings?.length).toBe(2);
	});

	it("P7: an id covered by left_only_allowed produces no finding", () => {
		const { root, ctx, decision, acc } = makeFixture();
		fixtures.push(root);
		writeConfig(root, pairConfig({ left_only_allowed: ["beta"] }));
		writeFileSync(join(root, "left.ts"), 'check: "alpha"\ncheck: "beta"');
		writeFileSync(join(root, "right.ts"), 'check: "alpha"');
		runRegistryParityPhase(ctx, join(root, "left.ts"), true, decision, acc);
		expect(decision.warnings).toBeUndefined();
		expect(acc.checksRan).toEqual([]);
	});

	// --- negative (must not fire) ---

	it("N1: editing a file that is not the LEFT or RIGHT of any pair is a no-op", () => {
		const { root, ctx, decision, acc } = makeFixture();
		fixtures.push(root);
		writeConfig(root, pairConfig());
		writeFileSync(join(root, "left.ts"), 'check: "alpha"\ncheck: "beta"');
		writeFileSync(join(root, "right.ts"), 'check: "alpha"');
		writeFileSync(join(root, "unrelated.ts"), "export const x = 1;");
		runRegistryParityPhase(ctx, join(root, "unrelated.ts"), true, decision, acc);
		expect(decision.warnings).toBeUndefined();
		expect(acc.checksRan).toEqual([]);
	});

	it("N2: no .interlinked/registry-parity.json present is a no-op", () => {
		const { root, ctx, decision, acc } = makeFixture();
		fixtures.push(root);
		writeFileSync(join(root, "left.ts"), 'check: "alpha"\ncheck: "beta"');
		runRegistryParityPhase(ctx, join(root, "left.ts"), true, decision, acc);
		expect(decision.warnings).toBeUndefined();
	});

	it("N3: editedFileInRepo === false is a no-op even when the path matches a pair", () => {
		const { root, ctx, decision, acc } = makeFixture();
		fixtures.push(root);
		writeConfig(root, pairConfig());
		writeFileSync(join(root, "left.ts"), 'check: "alpha"\ncheck: "beta"');
		writeFileSync(join(root, "right.ts"), 'check: "alpha"');
		runRegistryParityPhase(ctx, join(root, "left.ts"), false, decision, acc);
		expect(decision.warnings).toBeUndefined();
	});

	it("N4: an empty editedFilePath is a no-op", () => {
		const { root, ctx, decision, acc } = makeFixture();
		fixtures.push(root);
		writeConfig(root, pairConfig());
		runRegistryParityPhase(ctx, "", true, decision, acc);
		expect(decision.warnings).toBeUndefined();
	});

	it("N5: a pair already in sync produces no findings", () => {
		const { root, ctx, decision, acc } = makeFixture();
		fixtures.push(root);
		writeConfig(root, pairConfig());
		writeFileSync(join(root, "left.ts"), 'check: "alpha"\ncheck: "beta"');
		writeFileSync(join(root, "right.ts"), 'check: "alpha"\ncheck: "beta"');
		runRegistryParityPhase(ctx, join(root, "left.ts"), true, decision, acc);
		expect(decision.warnings).toBeUndefined();
		expect(acc.checksRan).toEqual([]);
	});

	it("N6: a malformed config logs and does not throw, instead of crashing the edit", () => {
		const { root, ctx, decision, acc } = makeFixture();
		fixtures.push(root);
		const full = join(root, REGISTRY_PARITY_CONFIG_PATH);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, "not valid json");
		writeFileSync(join(root, "left.ts"), 'check: "alpha"');
		const log = vi.fn();
		vi.spyOn(ctx, "log").mockImplementation(log);
		expect(() =>
			runRegistryParityPhase(ctx, join(root, "left.ts"), true, decision, acc),
		).not.toThrow();
		expect(decision.warnings).toBeUndefined();
		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls[0]?.[0]).toContain("Registry-parity phase");
	});
});
