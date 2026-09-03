import { describe, expect, it } from "vitest";
import {
	buildSimplificationAgentCiP5Plan,
	parseSimplificationAgentCiP5Plan,
	type SimplificationValidationCandidate,
} from "./simplification-agent-ci-plan-validation.js";
import { buildSimplificationAgentCiRequest } from "./simplification-agent-ci-request.js";
import type { SimplificationAgentCiRequestDraft } from "./simplification-agent-ci-request-schema.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);

function draft(
	validation: SimplificationAgentCiRequestDraft["validation"] = {
		mode: "candidate",
		check_plan_sha256: SHA_F,
		max_candidates: 2,
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
		scope: {
			kind: "diff",
			base_sha: "1".repeat(40),
			head_sha: SHA_A,
			paths: ["src/z.ts", "src/a.ts"],
			includes: ["src/**", "package.json"],
			excludes: ["vendor/**", "dist/**"],
		},
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
		validation,
		record: true,
		no_cache: false,
		submission_reason: "Portable planning artifact; no Agent CI transport is implemented.",
	};
}

function candidates(): SimplificationValidationCandidate[] {
	return [
		{
			fingerprint: "protected",
			overlap_group: null,
			protected_boundaries: ["authorization"],
			human_contract_narrowing_sha256: null,
			independent_validator_sha256: null,
		},
		{
			fingerprint: "narrowed",
			overlap_group: "group-1",
			protected_boundaries: ["compatibility"],
			human_contract_narrowing_sha256: SHA_A,
			independent_validator_sha256: SHA_B,
		},
	];
}

describe("simplification P5 validation plan", () => {
	it("builds a declarative plan with sorted candidates and eligibility reasons", () => {
		const request = buildSimplificationAgentCiRequest(draft());
		const plan = buildSimplificationAgentCiP5Plan(request, candidates());
		expect(plan.phase).toBe("P5");
		expect(plan.execution).toBe("declarative_only");
		expect(plan.candidates.map((candidate) => candidate.fingerprint)).toEqual([
			"narrowed",
			"protected",
		]);
		const [narrowed, unnarrowed] = plan.candidates;
		expect(narrowed?.eligibility).toBe("eligible");
		expect(unnarrowed?.eligibility).toBe("human_narrowing_required");
		expect(unnarrowed?.reason_codes).toEqual([
			"protected_contract_not_narrowed_by_human",
			"independent_validator_missing",
		]);
		expect(plan.adoption.human_approval_required).toBe(true);
		expect(plan.steps[0]?.step_id).toBe("bind-source");
	});

	it("refuses to build outside candidate mode", () => {
		const noMode = buildSimplificationAgentCiRequest(
			draft({ mode: "none", check_plan_sha256: null, max_candidates: 0 }),
		);
		expect(() => buildSimplificationAgentCiP5Plan(noMode, candidates())).toThrow(
			/mode=candidate/,
		);
	});

	it("refuses more candidates than the request budget", () => {
		const budgeted = buildSimplificationAgentCiRequest(
			draft({ mode: "candidate", check_plan_sha256: SHA_F, max_candidates: 1 }),
		);
		expect(() => buildSimplificationAgentCiP5Plan(budgeted, candidates())).toThrow(RangeError);
	});

	it("round-trips a canonical plan", () => {
		const request = buildSimplificationAgentCiRequest(draft());
		const plan = buildSimplificationAgentCiP5Plan(request, candidates());
		const parsed = parseSimplificationAgentCiP5Plan(
			JSON.parse(JSON.stringify(plan)),
			request,
		);
		expect(parsed.ok).toBe(true);
	});

	it("rejects a plan whose eligibility verdict was tampered with", () => {
		const request = buildSimplificationAgentCiRequest(draft());
		const plan = buildSimplificationAgentCiP5Plan(request, candidates());
		const tampered = JSON.parse(JSON.stringify(plan)) as typeof plan;
		const unnarrowed = tampered.candidates.find(
			(candidate) => candidate.fingerprint === "protected",
		);
		expect(unnarrowed?.eligibility).toBe("human_narrowing_required");
		unnarrowed!.eligibility = "eligible";
		unnarrowed!.reason_codes = [];
		expect(parseSimplificationAgentCiP5Plan(tampered, request).ok).toBe(false);
	});

	it("rejects structurally invalid plan input", () => {
		const request = buildSimplificationAgentCiRequest(draft());
		expect(parseSimplificationAgentCiP5Plan({ request_cache_key: "nope" }, request).ok).toBe(
			false,
		);
		expect(
			parseSimplificationAgentCiP5Plan(
				{ request_cache_key: SHA_A, candidates: "no" },
				request,
			).ok,
		).toBe(false);
		expect(
			parseSimplificationAgentCiP5Plan(
				{ request_cache_key: SHA_A, candidates: [{ fingerprint: "x" }] },
				request,
			).ok,
		).toBe(false);
	});
});
