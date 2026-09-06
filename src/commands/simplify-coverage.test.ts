import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	SimplificationFinding,
	SimplificationSourceCoverage,
} from "../lib/simplification-types.js";
import { buildSimplificationCoverage } from "./simplify-coverage.js";

let root = "";

function write(rel: string, content: string): string {
	const absolute = join(root, rel);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content);
	return absolute;
}

function finding(fingerprint: string, source: string, path: string): SimplificationFinding {
	return {
		fingerprint,
		lens: "simplification",
		source,
		remedy: "shrink",
		evidence_state: "candidate",
		confidence: 0.5,
		location: {
			path,
			start_line: 1,
			end_line: 1,
			tree_sha: null,
			working_tree_sha256: "worktree",
		},
		summary: fingerprint,
		replacement: null,
		evidence: [],
		impact: {
			estimated: { loc: null, dependencies_removed: [] },
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
	};
}

function source(
	name: string,
	analyzedPaths: string[],
): SimplificationSourceCoverage {
	return {
		source: name,
		status: "checked",
		files_considered: analyzedPaths.length,
		analyzed_paths: analyzedPaths,
		findings_emitted: 0,
		notes: [],
	};
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "simplify-coverage-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("buildSimplificationCoverage", () => {
	it("counts exact detector reads and attributes adapter-owned finding families", () => {
		const inspected = write("src/inspected.ts", "export const inspected = true;\n");
		const uninspected = write("src/uninspected.ts", "export const uninspected = true;\n");
		const unsupported = write("README.md", "documentation\n");
		const report = buildSimplificationCoverage({
			cwd: root,
			discovered: [inspected, uninspected, unsupported],
			scope: {
				kind: "repository",
				range: null,
				base_sha: null,
				head_sha: null,
				selected_paths: null,
			},
			sources: [
				source("deadcode.reachability-and-categorization", ["src/inspected.ts"]),
				source("opportunity.advisory-patterns", ["src/inspected.ts"]),
			],
			findings: [
				finding("mutation", "mutation.dead_code_disposition", "src/inspected.ts"),
				finding("metrics", "metrics.cyclomatic_hotspot", "src/inspected.ts"),
			],
		});

		expect(report).toMatchObject({
			status: "partial",
			selected_files: 3,
			analyzed_files: 1,
			excluded_files: 2,
		});
		expect(report.sources.map((entry) => ({
			source: entry.source,
			findings: entry.findings_emitted,
		}))).toEqual([
			{ source: "deadcode.reachability-and-categorization", findings: 1 },
			{ source: "opportunity.advisory-patterns", findings: 1 },
		]);
		expect(report.excluded_paths).toEqual(expect.arrayContaining([
			expect.objectContaining({
				rule: "supported path was not inspected by a local detector",
				sample: ["src/uninspected.ts"],
			}),
			expect.objectContaining({
				rule: "unsupported local simplification language",
				sample: ["README.md"],
			}),
		]));
	});

	it("reports status unavailable when every source came back unavailable", () => {
		const inspected = write("src/inspected.ts", "export const inspected = true;\n");
		const unavailableSource: SimplificationSourceCoverage = {
			source: "deadcode.reachability-and-categorization",
			status: "unavailable",
			files_considered: 0,
			analyzed_paths: [],
			findings_emitted: 0,
			notes: ["detector binary not installed"],
		};
		const report = buildSimplificationCoverage({
			cwd: root,
			discovered: [inspected],
			scope: {
				kind: "repository",
				range: null,
				base_sha: null,
				head_sha: null,
				selected_paths: null,
			},
			sources: [unavailableSource],
			findings: [],
		});

		// If overallStatus's all-unavailable branch were removed, this report
		// would fall through to the generic "missing/unsupported/unanalyzed"
		// check below it — which also evaluates true here (nothing was
		// analyzed) — and report "partial" instead of "unavailable". Asserting
		// the literal "unavailable" is what distinguishes the two branches.
		expect(report.status).toBe("unavailable");
	});
});
