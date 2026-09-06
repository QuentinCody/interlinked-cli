// ===========================================
// Simplification Agent CI request — entry-module version and flag guards
// ===========================================
// Companion to simplification-agent-ci-request.ts. Every rejection case starts
// from a request the module itself built — canonical ordering, correct nested
// members, self-derived idempotency key — and breaks exactly ONE field. The
// pinned reason is what proves the parse stopped at the guard under test: any
// of these inputs would also fail the later idempotency-key comparison, with a
// different message, so an assertion on the exact reason distinguishes them.

import { describe, expect, it } from "vitest";
import { buildSimplificationAgentCiRequest, parseSimplificationAgentCiRequest } from "./simplification-agent-ci-request.js";
import type { SimplificationAgentCiRequestDraft } from "./simplification-agent-ci-request-schema.js";

const hex = (fill: string): string => fill.repeat(64);

/** A whole-repository, validation-free draft: the smallest request the parser
 *  accepts, so nothing but the field under test can fail. */
function draft(): SimplificationAgentCiRequestDraft {
	return {
		repository: {
			workspace_id: "workspace-guard",
			repository_id: "repository-guard",
			commit_sha: hex("1"),
			tree_sha: hex("2"),
			inventory_sha256: hex("3"),
		},
		scope: {
			kind: "repository",
			base_sha: null,
			head_sha: hex("1"),
			paths: [],
			includes: ["src/**"],
			excludes: ["dist/**"],
		},
		requested_remedies: ["delete"],
		evidence: {
			deterministic_digest_sha256: hex("4"),
			tools: [{ name: "typescript", version: "5.9.3", output_sha256: hex("5") }],
			policy_hashes: [hex("6")],
			adversarial_fixture_sha256: hex("7"),
			benchmark_fixture_sha256: hex("8"),
			runtime_capability_sha256: hex("9"),
			workspace_policy_sha256: hex("a"),
			prior_findings_sha256: hex("b"),
		},
		orchestration: {
			risk_tier: "lite",
			model: { provider: "provider", family: "family", model: "model", version: "2026-09-01" },
			coordinator_prompt_sha256: hex("c"),
			partition_plan_version: "partition-plan/v1",
		},
		validation: { mode: "none", check_plan_sha256: null, max_candidates: 0 },
		record: false,
		no_cache: false,
		submission_reason: "No Agent CI transport is implemented in this package.",
	};
}

/** The built request with one top-level field replaced. */
function withField(patch: Record<string, unknown>): unknown {
	return { ...buildSimplificationAgentCiRequest(draft()), ...patch };
}

describe("parseSimplificationAgentCiRequest — version guards", () => {
	it("accepts the request the builder produced (the fixture every rejection case starts from)", () => {
		const result = parseSimplificationAgentCiRequest(withField({}));
		expect(result.ok).toBe(true);
	});

	it("rejects a request carrying a different schema_version", () => {
		const result = parseSimplificationAgentCiRequest(
			withField({ schema_version: "simplification-request/v2" }),
		);
		expect(result).toEqual({
			ok: false,
			reason: "request.schema_version must be simplification-request/v1",
		});
	});

	it("rejects a request whose kind is not the simplification review", () => {
		const result = parseSimplificationAgentCiRequest(
			withField({ kind: "agent_ci.security_review" }),
		);
		expect(result).toEqual({
			ok: false,
			reason: "request kind or simplification lens version is unsupported",
		});
	});

	it("rejects a request pinned to a different simplification lens version", () => {
		const result = parseSimplificationAgentCiRequest(
			withField({ lens_version: "simplification-lens/v2" }),
		);
		expect(result).toEqual({
			ok: false,
			reason: "request kind or simplification lens version is unsupported",
		});
	});
});

describe("parseSimplificationAgentCiRequest — record and no_cache flags", () => {
	it("rejects a stringly-typed record flag", () => {
		const result = parseSimplificationAgentCiRequest(withField({ record: "true" }));
		expect(result).toEqual({
			ok: false,
			reason: "request.record and request.no_cache must be booleans",
		});
	});

	it("rejects a missing no_cache flag left as null", () => {
		const result = parseSimplificationAgentCiRequest(withField({ no_cache: null }));
		expect(result).toEqual({
			ok: false,
			reason: "request.record and request.no_cache must be booleans",
		});
	});
});
