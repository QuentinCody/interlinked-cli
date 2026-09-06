import { describe, expect, it } from "vitest";
import {
	parseFindingExtensions,
	parseSimplificationExtension,
} from "./simplification-extension.js";

const HASH = "a".repeat(64);

function extensionFixture(): Record<string, unknown> {
	return {
		schema_version: 1,
		run_fingerprint: "run-1",
		recorded_at: "2026-08-30T12:00:00.000Z",
		command: "audit",
		repository: {
			repository_id: `repo-${"a".repeat(24)}`,
			root: "/repo",
			head_sha: null,
			tree_sha: null,
			working_tree_sha256: HASH,
		},
		scope: {
			kind: "repository",
			range: null,
			base_sha: null,
			head_sha: null,
			selected_paths: null,
		},
		coverage: {
			status: "complete",
			discovered_files: 1,
			selected_files: 1,
			analyzed_files: 1,
			excluded_files: 0,
			missing_paths: [],
			included_paths: ["src/a.ts"],
			excluded_paths: [],
			languages: [{
				language: "TypeScript",
				extensions: [".ts"],
				status: "checked",
				files: 1,
				reason: null,
			}],
			sources: [{
				source: "deadcode",
				status: "checked",
				files_considered: 1,
				analyzed_paths: ["src/a.ts"],
				findings_emitted: 1,
				notes: [],
			}],
			limitations: [],
		},
		finding: {
			fingerprint: HASH,
			lens: "simplification",
			source: "deadcode",
			remedy: "delete",
			evidence_state: "heuristic",
			confidence: 0.75,
			location: {
				path: "src/a.ts",
				start_line: 1,
				end_line: 2,
				tree_sha: null,
				working_tree_sha256: HASH,
			},
			summary: "Remove an unreachable export",
			replacement: null,
			evidence: [{
				kind: "reachability",
				state: "heuristic",
				detail: "No static importer was found.",
				path: "src/a.ts",
			}],
			impact: {
				estimated: { loc: -2, dependencies_removed: [] },
				validated: null,
			},
			overlap_group: "src/a.ts",
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
	};
}

describe("simplification finding extension", () => {
	it("parses the typed extension and preserves unknown sibling extensions", () => {
		const simplification = extensionFixture();
		expect(parseSimplificationExtension(simplification)).not.toBeNull();
		expect(parseFindingExtensions({
			simplification,
			future_lens: { schema_version: 7, value: "preserve me" },
		})).toEqual({
			simplification,
			future_lens: { schema_version: 7, value: "preserve me" },
		});
	});

	it("rejects malformed known extension data without rejecting an absent extension", () => {
		const malformed = extensionFixture();
		malformed.command = "submit";
		expect(parseFindingExtensions({ simplification: malformed })).toBeNull();
		expect(parseFindingExtensions(undefined)).toBeUndefined();
	});

	it("rejects an otherwise well-formed extension whose repository field fails its own validation", () => {
		const invalidRepository = extensionFixture();
		invalidRepository.repository = null;
		expect(parseSimplificationExtension(invalidRepository)).toBeNull();
	});
});
