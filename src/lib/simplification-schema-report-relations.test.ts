import { describe, expect, it } from "vitest";
import type { SimplificationFinding, SimplificationSummary } from "./simplification-types.js";
import {
	type FindingObjects,
	type FindingScalars,
	constructValidation,
	findingValidationIsConsistent,
	parseEvidence,
	parseEvidenceList,
	reportRelationsMatch,
} from "./simplification-schema-report-relations.js";

describe("simplification-schema-report-relations — parseEvidence", () => {
	it("parses a well-formed evidence entry", () => {
		expect(parseEvidence({
			kind: "import-graph",
			state: "heuristic",
			detail: "No static importer found",
			path: "src/a.ts",
		})).toEqual({
			kind: "import-graph",
			state: "heuristic",
			detail: "No static importer found",
			path: "src/a.ts",
		});
	});
	it("rejects an unknown evidence state", () => {
		expect(parseEvidence({
			kind: "import-graph",
			state: "guessed",
			detail: "x",
			path: null,
		})).toBeNull();
	});
});

describe("simplification-schema-report-relations — parseEvidenceList", () => {
	it("parses every entry in the list", () => {
		const list = parseEvidenceList([
			{ kind: "k", state: "proven", detail: "d", path: null },
		]);
		expect(list).toHaveLength(1);
	});
	it("rejects a list containing one invalid entry", () => {
		expect(parseEvidenceList([
			{ kind: "k", state: "proven", detail: "d", path: null },
			{ kind: "k", state: "bogus", detail: "d", path: null },
		])).toBeNull();
	});
});

describe("simplification-schema-report-relations — constructValidation", () => {
	it("builds a not_run receipt from empty fields", () => {
		expect(constructValidation("not_run", {
			executor: null,
			commands: [],
			artifact_sha: null,
			notes: [],
		})).toEqual({ status: "not_run", executor: null, commands: [], artifact_sha: null, notes: [] });
	});
	it("rejects a not_run status carrying an executor", () => {
		expect(constructValidation("not_run", {
			executor: "local",
			commands: [],
			artifact_sha: null,
			notes: [],
		})).toBeNull();
	});
	it("builds a passed receipt when executor, a command, and an artifact are present", () => {
		expect(constructValidation("passed", {
			executor: "sandbox",
			commands: ["npm test"],
			artifact_sha: "sha",
			notes: [],
		})).toEqual({
			status: "passed",
			executor: "sandbox",
			commands: ["npm test"],
			artifact_sha: "sha",
			notes: [],
		});
	});
	it("rejects a passed status missing a command", () => {
		expect(constructValidation("passed", {
			executor: "sandbox",
			commands: [],
			artifact_sha: "sha",
			notes: [],
		})).toBeNull();
	});
});

describe("simplification-schema-report-relations — findingValidationIsConsistent", () => {
	const scalars: FindingScalars = {
		fingerprint: "f",
		source: "deadcode",
		remedy: "delete",
		evidence_state: "heuristic",
		confidence: 0.5,
		summary: "s",
		replacement: null,
		overlap_group: null,
	};
	const objects: FindingObjects = {
		location: { path: "src/a.ts", start_line: 1, end_line: 2, tree_sha: "t", working_tree_sha256: "w" },
		evidence: [],
		impact: { estimated: { loc: -1, dependencies_removed: [] }, validated: null },
		validation: { status: "not_run", executor: null, commands: [], artifact_sha: null, notes: [] },
	};
	it("accepts a not_run finding with no validated impact", () => {
		expect(findingValidationIsConsistent(scalars, objects)).toBe(true);
	});
	it("rejects a sandbox-validated evidence_state without a matching passed/sandbox receipt", () => {
		expect(findingValidationIsConsistent({ ...scalars, evidence_state: "sandbox-validated" }, objects))
			.toBe(false);
	});
});

describe("simplification-schema-report-relations — reportRelationsMatch", () => {
	const repository = {
		repository_id: `repo-${"a".repeat(24)}`,
		root: "/repo",
		head_sha: "head",
		tree_sha: "tree",
		working_tree_sha256: "worktree",
	};
	const scope = { kind: "repository" as const, range: null, base_sha: null, head_sha: "head", selected_paths: null };
	const finding: SimplificationFinding = {
		fingerprint: "finding-1",
		lens: "simplification",
		source: "deadcode",
		remedy: "delete",
		evidence_state: "heuristic",
		confidence: 0.8,
		location: { path: "src/a.ts", start_line: 2, end_line: 4, tree_sha: "tree", working_tree_sha256: "worktree" },
		summary: "Remove an unreachable export",
		replacement: null,
		evidence: [],
		impact: { estimated: { loc: -3, dependencies_removed: [] }, validated: null },
		overlap_group: null,
		validation: { status: "not_run", executor: null, commands: [], artifact_sha: null, notes: [] },
		advisory: true,
		auto_fix: false,
	};
	const summary: SimplificationSummary = {
		findings: 1,
		by_remedy: { delete: 1, stdlib: 0, native: 0, yagni: 0, shrink: 0 },
		by_evidence_state: { candidate: 0, heuristic: 1, proven: 0, "sandbox-validated": 0 },
	};

	it("accepts a report whose summary, findings, and handoff are mutually consistent", () => {
		expect(reportRelationsMatch({
			command: "audit",
			repository,
			scope,
			findings: [finding],
			summary,
			handoff: null,
		})).toBe(true);
	});
	it("rejects a summary count that disagrees with the findings list", () => {
		expect(reportRelationsMatch({
			command: "audit",
			repository,
			scope,
			findings: [],
			summary,
			handoff: null,
		})).toBe(false);
	});
	it("rejects a scan command carrying a non-null handoff", () => {
		const handoff = {
			schema_version: 1 as const,
			kind: "agent_ci.simplification_review" as const,
			lens: "simplification" as const,
			scope,
			repository: { ...repository, head_sha: "head", tree_sha: "tree" },
			deterministic_finding_fingerprints: ["finding-1"],
			requested_remedies: ["delete" as const],
			requirements: [],
			submission: { status: "not_submitted" as const, reason: "policy" as const },
		};
		expect(reportRelationsMatch({
			command: "scan",
			repository,
			scope,
			findings: [finding],
			summary,
			handoff,
		})).toBe(false);
	});
});
