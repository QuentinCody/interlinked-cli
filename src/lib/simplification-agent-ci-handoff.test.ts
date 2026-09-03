import { describe, expect, it } from "vitest";
import { bindSimplificationAgentCiHandoff } from "./simplification-agent-ci-request-canonical.js";
import type { SimplificationDeepHandoffRequest } from "./simplification-types.js";

const handoff: SimplificationDeepHandoffRequest = {
	schema_version: 1,
	kind: "agent_ci.simplification_review",
	lens: "simplification",
	scope: {
		kind: "repository",
		range: null,
		base_sha: null,
		head_sha: "a".repeat(40),
		selected_paths: null,
	},
	repository: {
		repository_id: `repo-${"a".repeat(24)}`,
		root: "/repo",
		head_sha: "a".repeat(40),
		tree_sha: "b".repeat(40),
		working_tree_sha256: "c".repeat(64),
	},
	deterministic_finding_fingerprints: ["finding-1"],
	requested_remedies: ["delete", "stdlib", "native", "yagni", "shrink"],
	requirements: ["Return schema-valid advisory findings"],
	submission: {
		status: "not_submitted",
		reason: "Explicit local handoff only",
	},
};

describe("simplification Agent CI local handoff adapter", () => {
	it("reuses the shared handoff schema and content-addresses valid artifacts", () => {
		const parsed = bindSimplificationAgentCiHandoff(structuredClone(handoff));
		expect(parsed).toMatchObject({
			ok: true,
			handoff,
			handoff_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(handoff.repository.head_sha).toBe(handoff.scope.head_sha);
		expect(handoff.repository.head_sha).not.toBe(handoff.repository.tree_sha);
	});

	it("rejects any artifact that claims remote submission", () => {
		const submitted = structuredClone(handoff);
		Object.assign(submitted.submission, { status: "submitted", job_id: "job-1" });
		expect(bindSimplificationAgentCiHandoff(submitted)).toEqual({
			ok: false,
			reason: "invalid local simplification deep handoff",
		});
	});
});
