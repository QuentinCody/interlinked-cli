import { describe, expect, it } from "vitest";
import type { SimplificationReport } from "./simplification-types.js";
import {
	parseSimplificationCoverage,
	parseSimplificationFinding,
	parseSimplificationHandoff,
	parseSimplificationReport,
	parseSummary,
} from "./simplification-schema.js";

const report: SimplificationReport = {
	schema_version: 1,
	lens: "simplification",
	command: "audit",
	repository: {
		repository_id: `repo-${"a".repeat(24)}`,
		root: "/repo",
		head_sha: "head",
		tree_sha: "tree",
		working_tree_sha256: "worktree",
	},
	scope: {
		kind: "repository",
		range: null,
		base_sha: null,
		head_sha: "head",
		selected_paths: null,
	},
	findings: [
		{
			fingerprint: "finding-1",
			lens: "simplification",
			source: "deadcode",
			remedy: "delete",
			evidence_state: "heuristic",
			confidence: 0.8,
			location: {
				path: "src/a.ts",
				start_line: 2,
				end_line: 4,
				tree_sha: "tree",
				working_tree_sha256: "worktree",
			},
			summary: "Remove an unreachable export",
			replacement: null,
			evidence: [
				{
					kind: "import-graph",
					state: "heuristic",
					detail: "No static importer found",
					path: "src/a.ts",
				},
			],
			impact: {
				estimated: { loc: -3, dependencies_removed: [] },
				validated: null,
			},
			overlap_group: null,
			validation: {
				status: "not_run",
				executor: null,
				commands: [],
				artifact_sha: null,
				notes: [],
			},
			advisory: true,
			auto_fix: false,
		},
	],
	summary: {
		findings: 1,
		by_remedy: { delete: 1, stdlib: 0, native: 0, yagni: 0, shrink: 0 },
		by_evidence_state: {
			candidate: 0,
			heuristic: 1,
			proven: 0,
			"sandbox-validated": 0,
		},
	},
	coverage: {
		status: "partial",
		discovered_files: 2,
		selected_files: 1,
		analyzed_files: 1,
		excluded_files: 0,
		missing_paths: [],
		included_paths: ["src/a.ts"],
		excluded_paths: [],
		languages: [
			{
				language: "TypeScript",
				extensions: [".ts"],
				status: "checked",
				files: 1,
				reason: null,
			},
		],
		sources: [
			{
				source: "deadcode",
				status: "checked",
				files_considered: 1,
				analyzed_paths: ["src/a.ts"],
				findings_emitted: 1,
				notes: [],
			},
		],
		limitations: ["Static imports only"],
	},
	deep_handoff: {
		schema_version: 1,
		kind: "agent_ci.simplification_review",
		lens: "simplification",
		scope: {
			kind: "repository",
			range: null,
			base_sha: null,
			head_sha: "head",
			selected_paths: null,
		},
		repository: {
			repository_id: `repo-${"a".repeat(24)}`,
			root: "/repo",
			head_sha: "head",
			tree_sha: "tree",
			working_tree_sha256: "worktree",
		},
		deterministic_finding_fingerprints: ["finding-1"],
		requested_remedies: ["delete", "stdlib", "native", "yagni", "shrink"],
		requirements: ["Return structured findings"],
		submission: { status: "not_submitted", reason: "Explicit handoff only" },
	},
	read_only: true,
};

function requireFirstFinding(): SimplificationReport["findings"][number] {
	const finding = report.findings[0];
	if (!finding) throw new Error("fixture must contain one finding");
	return finding;
}

const firstFinding = requireFirstFinding();

function sandboxValidatedFinding(): SimplificationReport["findings"][number] {
	return {
		...structuredClone(firstFinding),
		evidence_state: "sandbox-validated",
		impact: {
			...structuredClone(firstFinding.impact),
			validated: { loc: -3, dependencies_removed: [] },
		},
		validation: {
			status: "passed",
			executor: "sandbox",
			commands: ["npm test"],
			artifact_sha: "artifact-sha",
			notes: [],
		},
	};
}

describe("simplification schema parser", () => {
	it("constructs a complete report at the JSON boundary", () => {
		expect(parseSimplificationReport(structuredClone(report))).toEqual(report);
	});

	it("rejects findings that claim mutation or invalid confidence", () => {
		const mutating = { ...structuredClone(firstFinding), auto_fix: true };
		expect(parseSimplificationFinding(mutating)).toBeNull();
		expect(
			parseSimplificationFinding({ ...structuredClone(firstFinding), confidence: 1.01 }),
		).toBeNull();
	});

	it("rejects inverted spans and invented validation", () => {
		const finding = structuredClone(firstFinding);
		finding.location.end_line = 1;
		expect(parseSimplificationFinding(finding)).toBeNull();
		const invented = {
			...structuredClone(firstFinding),
			validation: { ...structuredClone(firstFinding.validation), status: "passed" },
		};
		expect(parseSimplificationFinding(invented)).toBeNull();
	});

	it("requires executor, command, and artifact evidence for passed validation", () => {
		const valid = sandboxValidatedFinding();
		expect(parseSimplificationFinding(valid)).toEqual(valid);
		expect(parseSimplificationFinding({
			...valid,
			validation: { ...valid.validation, executor: null },
		})).toBeNull();
		expect(parseSimplificationFinding({
			...valid,
			validation: { ...valid.validation, commands: [] },
		})).toBeNull();
		expect(parseSimplificationFinding({
			...valid,
			validation: { ...valid.validation, artifact_sha: null },
		})).toBeNull();
	});

	it("rejects a validation executor that is not null, local, or sandbox", () => {
		// A heuristic (non sandbox-validated) finding, so the ONLY guard this
		// input can trip is the executor literal-set check: a sandbox-validated
		// finding would also be rejected downstream by findingValidationIsConsistent
		// (which requires executor === "sandbox"), which would still return null
		// with the executor guard removed and so would not discriminate.
		expect(parseSimplificationFinding({
			...structuredClone(firstFinding),
			validation: {
				status: "passed",
				executor: "cloud",
				commands: ["npm test"],
				artifact_sha: "artifact-sha",
				notes: [],
			},
		})).toBeNull();
	});

	it("keeps not-run validation free of execution and exact-delta claims", () => {
		expect(parseSimplificationFinding({
			...structuredClone(firstFinding),
			impact: {
				...structuredClone(firstFinding.impact),
				validated: { loc: -3, dependencies_removed: [] },
			},
		})).toBeNull();
		expect(parseSimplificationFinding({
			...structuredClone(firstFinding),
			validation: {
				...structuredClone(firstFinding.validation),
				executor: "local",
			},
		})).toBeNull();
		expect(parseSimplificationFinding({
			...structuredClone(firstFinding),
			validation: {
				...structuredClone(firstFinding.validation),
				commands: ["npm test"],
			},
		})).toBeNull();
		expect(parseSimplificationFinding({
			...structuredClone(firstFinding),
			validation: {
				...structuredClone(firstFinding.validation),
				artifact_sha: "artifact-sha",
			},
		})).toBeNull();
	});

	it("requires the sandbox-validated state exactly for passed Sandbox deltas", () => {
		const valid = sandboxValidatedFinding();
		expect(parseSimplificationFinding({ ...valid, evidence_state: "heuristic" })).toBeNull();
		expect(parseSimplificationFinding({
			...valid,
			impact: { ...valid.impact, validated: null },
		})).toBeNull();
		expect(parseSimplificationFinding({
			...valid,
			validation: { ...valid.validation, executor: "local" },
		})).toBeNull();
		expect(parseSimplificationFinding({
			...structuredClone(firstFinding),
			evidence_state: "sandbox-validated",
		})).toBeNull();
	});

	it("preserves failed and inconclusive receipts without promoting them", () => {
		const failed = {
			...sandboxValidatedFinding(),
			evidence_state: "heuristic",
			validation: {
				status: "failed",
				executor: "sandbox",
				commands: ["npm test"],
				artifact_sha: "failed-artifact",
				notes: ["regression"],
			},
		};
		expect(parseSimplificationFinding(failed)).toMatchObject({
			evidence_state: "heuristic",
			validation: { status: "failed" },
		});
		const inconclusive = {
			...structuredClone(firstFinding),
			validation: {
				status: "inconclusive",
				executor: null,
				commands: [],
				artifact_sha: null,
				notes: ["environment unavailable"],
			},
		};
		expect(parseSimplificationFinding(inconclusive)).toMatchObject({
			evidence_state: "heuristic",
			validation: { status: "inconclusive" },
		});
	});

	it("rejects absolute and traversal finding paths", () => {
		for (const path of ["/etc/passwd", "../secret.ts", "src/../../secret.ts", "C:\\secret.ts"]) {
			const finding = structuredClone(firstFinding);
			finding.location.path = path;
			expect(parseSimplificationFinding(finding), path).toBeNull();
		}
	});

	it("rejects summary counts that do not match the findings", () => {
		const malformed = structuredClone(report);
		malformed.summary.findings = 2;
		expect(parseSimplificationReport(malformed)).toBeNull();
		const wrongCategory = structuredClone(report);
		wrongCategory.summary.by_remedy.delete = 0;
		wrongCategory.summary.by_remedy.shrink = 1;
		expect(parseSimplificationReport(wrongCategory)).toBeNull();
	});

	it("rejects a summary whose evidence-state counter is not a non-negative integer", () => {
		// heuristic: -1 fails nonNegativeInteger while every other counter (and
		// both totals, computed with the invalid field coerced to 0) still
		// balances against findings — isolating this one disjunct.
		const malformed = {
			findings: 0,
			by_remedy: { delete: 0, stdlib: 0, native: 0, yagni: 0, shrink: 0 },
			by_evidence_state: { candidate: 0, heuristic: -1, proven: 0, "sandbox-validated": 0 },
		};
		expect(parseSummary(malformed)).toBeNull();
	});

	it("binds finding locations and handoffs to the report identity", () => {
		const wrongTree = structuredClone(report);
		wrongTree.findings[0]!.location.tree_sha = "different-tree";
		expect(parseSimplificationReport(wrongTree)).toBeNull();

		const wrongHandoff = structuredClone(report);
		wrongHandoff.deep_handoff!.deterministic_finding_fingerprints = ["different-finding"];
		expect(parseSimplificationReport(wrongHandoff)).toBeNull();

		const wrongScope = structuredClone(report);
		wrongScope.deep_handoff!.scope.head_sha = "different-head";
		expect(parseSimplificationReport(wrongScope)).toBeNull();
	});

	it("rejects coverage that claims more analyzed than selected files", () => {
		const malformed = structuredClone(report);
		malformed.coverage.analyzed_files = 2;
		expect(parseSimplificationReport(malformed)).toBeNull();

		const inconsistentExcluded = structuredClone(report);
		inconsistentExcluded.coverage.excluded_files = 1;
		expect(parseSimplificationReport(inconsistentExcluded)).toBeNull();

		const inventedReadCount = structuredClone(report);
		inventedReadCount.coverage.sources[0]!.analyzed_paths = [];
		inventedReadCount.coverage.sources[0]!.files_considered = 0;
		expect(parseSimplificationReport(inventedReadCount)).toBeNull();
	});

	it("rejects a source whose analyzed-path count disagrees with its own files_considered", () => {
		// Only this one disjunct is tripped: files_considered (2) does not match
		// analyzed_paths.length (1), while every other per-source and top-level
		// field is independently valid.
		const malformed = {
			status: "partial",
			discovered_files: 1,
			selected_files: 1,
			analyzed_files: 1,
			excluded_files: 0,
			missing_paths: [],
			included_paths: [],
			excluded_paths: [],
			languages: [],
			limitations: [],
			sources: [
				{
					source: "deadcode",
					status: "checked",
					files_considered: 2,
					analyzed_paths: ["src/a.ts"],
					findings_emitted: 0,
					notes: [],
				},
			],
		};
		expect(parseSimplificationCoverage(malformed)).toBeNull();
	});

	it("accepts only inspectable, not-submitted local handoffs", () => {
		expect(parseSimplificationHandoff(structuredClone(report.deep_handoff))).toEqual(
			report.deep_handoff,
		);
		const submitted = {
			...structuredClone(report.deep_handoff),
			submission: { status: "submitted", job_id: "job-1" },
		};
		expect(parseSimplificationHandoff(submitted)).toBeNull();

		const handoff = report.deep_handoff;
		if (handoff === null) throw new Error("expected a deep handoff fixture");
		const unpinned = {
			...structuredClone(handoff),
			repository: { ...handoff.repository, head_sha: null },
		};
		expect(parseSimplificationHandoff(unpinned)).toBeNull();
	});
});
