// ===========================================
// Simplification Agent CI — P4 orchestration plan tests
// ===========================================
// Covers the branches the primary simplification-agent-ci.test.ts happy-path
// and tamper suites do not reach: the inventory-binding policy-mismatch
// messages (repository-scope vs diff/paths-scope), the boundary sort order,
// each per-partition validation throw (partition_id shape, invalid file
// path, duplicate remedies, duplicate protected boundaries), and the two
// early-return / catch-block paths in parseSimplificationAgentCiP4Plan.

import { describe, expect, it } from "vitest";
import {
	buildSimplificationAgentCiP4Plan,
	parseSimplificationAgentCiP4Plan,
} from "./simplification-agent-ci-plan.js";
import { buildSimplificationAgentCiRequest } from "./simplification-agent-ci-request.js";
import type { SimplificationAgentCiRequestDraft } from "./simplification-agent-ci-request-schema.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);

function draft(
	scope: SimplificationAgentCiRequestDraft["scope"] = {
		kind: "diff",
		base_sha: "1".repeat(40),
		head_sha: SHA_A,
		paths: ["src/z.ts", "src/a.ts"],
		includes: ["src/**", "package.json"],
		excludes: ["vendor/**", "dist/**"],
	},
): SimplificationAgentCiRequestDraft {
	return {
		repository: {
			workspace_id: "workspace-1",
			repository_id: "repository-1",
			commit_sha: SHA_A,
			tree_sha: SHA_B,
			inventory_sha256: SHA_C,
		},
		scope,
		requested_remedies: ["shrink", "delete", "native", "stdlib", "yagni"],
		evidence: {
			deterministic_digest_sha256: SHA_C,
			tools: [
				{ name: "typescript", version: "5.9.3", output_sha256: SHA_D },
				{ name: "deadcode", version: "1.0.0", output_sha256: SHA_E },
			],
			policy_hashes: [SHA_F, SHA_A],
			adversarial_fixture_sha256: SHA_D,
			benchmark_fixture_sha256: SHA_E,
			runtime_capability_sha256: SHA_B,
			workspace_policy_sha256: SHA_C,
			prior_findings_sha256: SHA_D,
		},
		orchestration: {
			risk_tier: "full",
			model: {
				provider: "provider",
				family: "family",
				model: "model",
				version: "2026-08-30",
			},
			coordinator_prompt_sha256: SHA_E,
			partition_plan_version: "partition-plan/v1",
		},
		validation: { mode: "none", check_plan_sha256: null, max_candidates: 0 },
		record: true,
		no_cache: false,
		submission_reason: "Portable planning artifact; no Agent CI transport is implemented.",
	};
}

/** The default diff-scope request's matching inventory binding (mirrors the
 *  fixture used by simplification-agent-ci.test.ts's p4Inventory helper). */
function diffInventory(request: ReturnType<typeof buildSimplificationAgentCiRequest>) {
	return {
		inventory_sha256: request.repository.inventory_sha256,
		inventory_files: ["README.md", "src/a.ts", "src/z.ts"],
		scoped_files: ["src/a.ts", "src/z.ts"],
	};
}

describe("simplification P4 plan — inventory binding policy mismatches", () => {
	it("reports the repository-scope message when scoped_files diverge from the policy-filtered inventory", () => {
		const request = buildSimplificationAgentCiRequest(draft({
			kind: "repository",
			base_sha: null,
			head_sha: SHA_A,
			paths: [],
			includes: ["src/**", "package.json"],
			excludes: ["vendor/**", "dist/**"],
		}));
		const binding = {
			inventory_sha256: request.repository.inventory_sha256,
			inventory_files: ["README.md", "src/a.ts", "src/z.ts"],
			// Only one of the two policy-selected files ("src/a.ts", "src/z.ts") is
			// declared scoped, so the repository-branch message must fire.
			scoped_files: ["src/a.ts"],
		};
		expect(() => buildSimplificationAgentCiP4Plan(request, [], binding)).toThrow(
			"P4 scoped_files must exactly match the inventory after request include/exclude policy",
		);
	});

	it("reports the excluded-file message when a diff-scope path passes the paths check but fails the include/exclude policy", () => {
		const request = buildSimplificationAgentCiRequest(draft({
			kind: "diff",
			base_sha: "1".repeat(40),
			head_sha: SHA_A,
			// "README.md" is declared in scope.paths (so it matches the diff-scope
			// requestedPaths check) but is not matched by any include glob.
			paths: ["README.md", "src/a.ts"],
			includes: ["src/**", "package.json"],
			excludes: ["vendor/**", "dist/**"],
		}));
		const binding = {
			inventory_sha256: request.repository.inventory_sha256,
			inventory_files: ["README.md", "src/a.ts", "src/z.ts"],
			scoped_files: ["README.md", "src/a.ts"],
		};
		expect(() => buildSimplificationAgentCiP4Plan(request, [], binding)).toThrow(
			"P4 scoped file is excluded by request include/exclude policy: README.md",
		);
	});
});

describe("simplification P4 plan — per-partition validation", () => {
	it("sorts a partition's protected boundaries by the canonical boundary order", () => {
		const request = buildSimplificationAgentCiRequest(draft());
		const binding = diffInventory(request);
		const plan = buildSimplificationAgentCiP4Plan(request, [
			{
				partition_id: "sorted",
				files: ["src/a.ts", "src/z.ts"],
				remedies: ["delete"],
				// Declared out of order: "compatibility" (index 6) before
				// "authorization" (index 0).
				protected_boundaries: ["compatibility", "authorization"],
			},
		], binding);
		expect(plan.partitions[0]?.protected_boundaries).toEqual(["authorization", "compatibility"]);
	});

	it("rejects a partition_id that fails the stable identifier pattern", () => {
		const request = buildSimplificationAgentCiRequest(draft());
		const binding = diffInventory(request);
		expect(() => buildSimplificationAgentCiP4Plan(request, [
			{
				partition_id: "has space",
				files: ["src/a.ts", "src/z.ts"],
				remedies: ["delete"],
				protected_boundaries: [],
			},
		], binding)).toThrow("P4 partition_id must be a non-empty stable identifier");
	});

	it("rejects a partition file path that escapes the repository root", () => {
		const request = buildSimplificationAgentCiRequest(draft());
		const binding = diffInventory(request);
		expect(() => buildSimplificationAgentCiP4Plan(request, [
			{
				partition_id: "escape",
				files: ["../outside.ts"],
				remedies: ["delete"],
				protected_boundaries: [],
			},
		], binding)).toThrow("P4 partition escape contains an invalid file path");
	});

	it("rejects duplicate remedies within one partition", () => {
		const request = buildSimplificationAgentCiRequest(draft());
		const binding = diffInventory(request);
		expect(() => buildSimplificationAgentCiP4Plan(request, [
			{
				partition_id: "dup-remedy",
				files: ["src/a.ts", "src/z.ts"],
				remedies: ["delete", "delete"],
				protected_boundaries: [],
			},
		], binding)).toThrow("P4 partition dup-remedy remedies must not contain duplicates");
	});

	it("rejects duplicate protected boundaries within one partition", () => {
		const request = buildSimplificationAgentCiRequest(draft());
		const binding = diffInventory(request);
		expect(() => buildSimplificationAgentCiP4Plan(request, [
			{
				partition_id: "dup-boundary",
				files: ["src/a.ts", "src/z.ts"],
				remedies: ["delete"],
				protected_boundaries: ["authorization", "authorization"],
			},
		], binding)).toThrow("P4 partition dup-boundary protected_boundaries must be unique known values");
	});
});

describe("simplification P4 plan — parse-input validation and rebuild failure", () => {
	it("rejects a plan payload whose request_cache_key is not a sha256 string", () => {
		const request = buildSimplificationAgentCiRequest(draft());
		const binding = diffInventory(request);
		const input = { request_cache_key: "not-a-sha256", risk_tier: "full", partitions: [] };
		expect(parseSimplificationAgentCiP4Plan(input, request, binding)).toEqual({
			ok: false,
			reason: "P4 plan must carry a sha256 request_cache_key",
		});
	});

	it("rejects a plan payload whose risk_tier is not lite or full", () => {
		const request = buildSimplificationAgentCiRequest(draft());
		const binding = diffInventory(request);
		const input = { request_cache_key: SHA_A, risk_tier: "medium", partitions: [] };
		expect(parseSimplificationAgentCiP4Plan(input, request, binding)).toEqual({
			ok: false,
			reason: "P4 plan risk_tier must be lite or full",
		});
	});

	it("surfaces the build error message when structurally valid partitions leave the assignment incomplete", () => {
		const request = buildSimplificationAgentCiRequest(draft());
		const binding = diffInventory(request);
		// Well-formed shape (parsePartition accepts it) but an empty partitions
		// array can never own the two scoped files, so buildSimplificationAgentCiP4Plan
		// throws inside the try block and the catch path must relay its message.
		const input = { request_cache_key: SHA_A, risk_tier: "full", partitions: [] };
		expect(parseSimplificationAgentCiP4Plan(input, request, binding)).toEqual({
			ok: false,
			reason: "P4 partition assignment is incomplete; missing: src/a.ts, src/z.ts",
		});
	});
});
