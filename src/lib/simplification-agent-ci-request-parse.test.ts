import { describe, expect, it } from "vitest";
import {
	checkedSha256,
	parseEvidence,
	parseOrchestration,
	parseRemedies,
	parseRepository,
	parseScope,
	parseSubmission,
	parseValidation,
	reasonFrom,
	unknownKeys,
} from "./simplification-agent-ci-request-parse.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const COMMIT = "c".repeat(40);

function repository(): Record<string, unknown> {
	return {
		workspace_id: "ws",
		repository_id: "repo",
		commit_sha: COMMIT,
		tree_sha: COMMIT,
		inventory_sha256: SHA_A,
	};
}

function evidence(): Record<string, unknown> {
	return {
		deterministic_digest_sha256: SHA_A,
		tools: [{ name: "biome", version: "1.0.0", output_sha256: SHA_A }],
		policy_hashes: [SHA_A],
		adversarial_fixture_sha256: SHA_A,
		benchmark_fixture_sha256: SHA_A,
		runtime_capability_sha256: SHA_A,
		workspace_policy_sha256: SHA_A,
		prior_findings_sha256: SHA_A,
	};
}

function orchestration(): Record<string, unknown> {
	return {
		risk_tier: "lite",
		model: { provider: "p", family: "f", model: "m", version: "1.2.3" },
		coordinator_prompt_sha256: SHA_A,
		partition_plan_version: "v1",
	};
}

describe("field primitives", () => {
	it("names every unknown key in sorted order", () => {
		expect(unknownKeys({ b: 1, a: 2 }, ["a"], "request")).toBe("request has unknown field(s): b");
	});

	it("returns null when every key is allowed", () => {
		expect(unknownKeys({ a: 1 }, ["a", "b"], "request")).toBeNull();
	});

	it("accepts a lowercase digest and rejects anything else", () => {
		expect(checkedSha256(SHA_A, "x")).toBe(SHA_A);
		expect(checkedSha256("nope", "x")).toEqual({ reason: "x must be a lowercase sha256 hex digest" });
	});

	it("reads a reason only out of a failure shape", () => {
		expect(reasonFrom({ reason: "bad" })).toBe("bad");
		expect(reasonFrom("plain")).toBeNull();
	});
});

describe("parseRepository", () => {
	it("returns the pinned repository reference", () => {
		expect(parseRepository(repository())).toEqual({
			workspace_id: "ws",
			repository_id: "repo",
			commit_sha: COMMIT,
			tree_sha: COMMIT,
			inventory_sha256: SHA_A,
		});
	});

	it("rejects a non-object", () => {
		expect(parseRepository("x")).toEqual({ reason: "request.repository must be an object" });
	});

	it("rejects a truncated commit id", () => {
		expect(parseRepository({ ...repository(), commit_sha: "abc" })).toEqual({
			reason: "request.repository.commit_sha must be a full lowercase Git object id",
		});
	});

	it("rejects an unknown field", () => {
		expect(parseRepository({ ...repository(), extra: 1 })).toEqual({
			reason: "request.repository has unknown field(s): extra",
		});
	});
});

describe("parseScope", () => {
	it("returns a repository-wide scope", () => {
		expect(
			parseScope({ kind: "repository", base_sha: null, head_sha: COMMIT, paths: [], includes: [], excludes: [] }),
		).toEqual({ kind: "repository", base_sha: null, head_sha: COMMIT, paths: [], includes: [], excludes: [] });
	});

	it("rejects an unsupported scope kind", () => {
		expect(parseScope({ kind: "file", base_sha: null, head_sha: COMMIT, paths: [], includes: [], excludes: [] })).toEqual({
			reason: "request.scope.kind must be one of repository|diff|paths",
		});
	});

	it("rejects an absolute path", () => {
		expect(
			parseScope({ kind: "paths", base_sha: null, head_sha: COMMIT, paths: ["/etc/passwd"], includes: [], excludes: [] }),
		).toEqual({ reason: "request.scope.paths[0] must be a normalized repository-relative path" });
	});

	it("rejects non-canonical path ordering", () => {
		expect(
			parseScope({ kind: "paths", base_sha: null, head_sha: COMMIT, paths: ["b.ts", "a.ts"], includes: [], excludes: [] }),
		).toEqual({ reason: "request.scope.paths must use canonical ordering" });
	});
});

describe("parseEvidence", () => {
	it("returns the evidence binding", () => {
		expect(parseEvidence(evidence())).toEqual(evidence());
	});

	it("rejects duplicate tool names", () => {
		const duplicated = {
			...evidence(),
			tools: [
				{ name: "biome", version: "1", output_sha256: SHA_A },
				{ name: "biome", version: "2", output_sha256: SHA_B },
			],
		};
		expect(parseEvidence(duplicated)).toEqual({ reason: "request.evidence.tools names must be unique" });
	});

	it("rejects unsorted tools", () => {
		const unsorted = {
			...evidence(),
			tools: [
				{ name: "tsc", version: "1", output_sha256: SHA_A },
				{ name: "biome", version: "2", output_sha256: SHA_B },
			],
		};
		expect(parseEvidence(unsorted)).toEqual({ reason: "request.evidence.tools must be sorted by name" });
	});
});

describe("parseOrchestration", () => {
	it("returns the orchestration binding", () => {
		expect(parseOrchestration(orchestration())).toEqual(orchestration());
	});

	it("rejects an unpinned model version", () => {
		const loose = { ...orchestration(), model: { provider: "p", family: "f", model: "m", version: "latest" } };
		expect(parseOrchestration(loose)).toEqual({
			reason: "request.orchestration.model.version must be an exact pinned revision",
		});
	});

	it("rejects an unknown risk tier", () => {
		expect(parseOrchestration({ ...orchestration(), risk_tier: "medium" })).toEqual({
			reason: "request.orchestration.risk_tier must be one of lite|full",
		});
	});
});

describe("parseValidation", () => {
	it("returns a validation request that runs no checks", () => {
		expect(parseValidation({ mode: "none", check_plan_sha256: null, max_candidates: 0 })).toEqual({
			mode: "none",
			check_plan_sha256: null,
			max_candidates: 0,
		});
	});

	it("rejects an unknown mode", () => {
		expect(parseValidation({ mode: "all", check_plan_sha256: null, max_candidates: 0 })).toEqual({
			reason: "request.validation.mode must be one of none|candidate",
		});
	});
});

describe("parseRemedies", () => {
	it("rejects an empty remedy list", () => {
		expect(parseRemedies([])).toEqual({
			reason: "request.requested_remedies must contain at least one remedy",
		});
	});

	it("rejects an unknown remedy", () => {
		expect(parseRemedies(["teleport"])).toEqual({
			reason: "request.requested_remedies contains unknown remedy teleport",
		});
	});
});

describe("parseSubmission", () => {
	it("returns the not-submitted marker", () => {
		expect(parseSubmission({ state: "not_submitted", transport: "unimplemented", reason: "no transport" })).toEqual({
			state: "not_submitted",
			transport: "unimplemented",
			reason: "no transport",
		});
	});

	it("refuses any claim that the request was submitted", () => {
		expect(parseSubmission({ state: "submitted", transport: "https", reason: "sent" })).toEqual({
			reason: "request.submission may only describe an unimplemented, not-submitted transport",
		});
	});
});
