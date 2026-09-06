import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	recordSimplificationReport,
	simplificationRunsPath,
} from "../harness/findings/simplification-record.js";
import type { SimplificationFinding, SimplificationReport } from "./simplification-types.js";
import {
	potentialEvidence,
	readSimplificationReceipts,
	sandboxValidatedEvidence,
} from "./impact-evidence-simplification.js";

let cwd: string;

function writeRuns(lines: string[]): void {
	const path = simplificationRunsPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

/** A minimal, schema-valid finding fixture at a given fingerprint/path. */
function simplificationFinding(fingerprint: string, path: string): SimplificationFinding {
	return {
		fingerprint,
		lens: "simplification",
		source: "impact-test",
		remedy: "delete",
		evidence_state: "heuristic",
		confidence: 0.8,
		location: { path, start_line: 1, end_line: 1, tree_sha: "tree", working_tree_sha256: "worktree" },
		summary: `Simplification candidate ${fingerprint}`,
		replacement: null,
		evidence: [{ kind: "test-observation", state: "heuristic", detail: `Recorded evidence for ${fingerprint}`, path }],
		impact: { estimated: { loc: -1, dependencies_removed: [] }, validated: null },
		overlap_group: null,
		validation: { status: "not_run", executor: null, commands: [], artifact_sha: null, notes: [] },
		advisory: true,
		auto_fix: false,
	};
}

/** A minimal, schema-valid report fixture carrying the given findings and scope. */
function simplificationReport(
	findings: SimplificationFinding[],
	scope: { kind: SimplificationReport["scope"]["kind"]; selected_paths: string[] | null },
): SimplificationReport {
	return {
		schema_version: 1,
		lens: "simplification",
		command: "audit",
		repository: {
			repository_id: `repo-${"a".repeat(24)}`,
			root: cwd,
			head_sha: "head",
			tree_sha: "tree",
			working_tree_sha256: "worktree",
		},
		scope: { kind: scope.kind, range: null, base_sha: null, head_sha: "head", selected_paths: scope.selected_paths },
		findings,
		summary: {
			findings: findings.length,
			by_remedy: { delete: findings.length, stdlib: 0, native: 0, yagni: 0, shrink: 0 },
			by_evidence_state: { candidate: 0, heuristic: findings.length, proven: 0, "sandbox-validated": 0 },
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
			languages: [{ language: "TypeScript", extensions: [".ts"], status: "checked", files: 1, reason: null }],
			sources: [{
				source: "impact-test",
				status: "checked",
				files_considered: 1,
				analyzed_paths: ["src/a.ts"],
				findings_emitted: findings.length,
				notes: [],
			}],
			limitations: [],
		},
		deep_handoff: null,
		read_only: true,
	};
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "impact-simplification-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("readSimplificationReceipts", () => {
	it("reports not-recorded when the receipt stream is absent", () => {
		const parsed = readSimplificationReceipts(cwd);
		expect(parsed.evidence.availability).toBe("not-recorded");
		expect(parsed.evidence.path).toBe(simplificationRunsPath(cwd));
		expect(parsed.evidence.receipt_rows).toBe(0);
		expect(parsed.evidence.reason).toBe("No recorded simplification run receipt is available.");
		expect(parsed.receipts).toEqual([]);
		expect(parsed.latest).toEqual([]);
	});

	it("reports unavailable when every recorded row is malformed", () => {
		writeRuns(["{not json", JSON.stringify({ nope: true })]);
		const parsed = readSimplificationReceipts(cwd);
		expect(parsed.evidence.availability).toBe("unavailable");
		expect(parsed.evidence.receipt_rows).toBe(2);
		expect(parsed.evidence.valid_receipts).toBe(0);
		expect(parsed.evidence.malformed_receipts).toBe(2);
		expect(parsed.evidence.reason).toBe(
			"The simplification receipt stream contains no schema-valid, hash-bound run receipt.",
		);
	});

	it("ignores blank lines when counting receipt rows", () => {
		writeRuns(["", "   ", "{not json"]);
		const parsed = readSimplificationReceipts(cwd);
		expect(parsed.evidence.receipt_rows).toBe(1);
		expect(parsed.evidence.malformed_receipts).toBe(1);
	});

	it("reports not-recorded when an existing receipt stream has no content rows", () => {
		writeRuns(["", "   ", ""]);
		const parsed = readSimplificationReceipts(cwd);
		expect(parsed.evidence.availability).toBe("not-recorded");
		expect(parsed.evidence.receipt_rows).toBe(0);
		expect(parsed.evidence.reason).toBe("No recorded simplification run receipt is available.");
	});

	it("reports unavailable when the receipt stream cannot be read", () => {
		const path = simplificationRunsPath(cwd);
		mkdirSync(path, { recursive: true });
		const parsed = readSimplificationReceipts(cwd);
		expect(parsed.evidence.availability).toBe("unavailable");
		expect(parsed.evidence.reason).toMatch(/EISDIR/);
		expect(parsed.receipts).toEqual([]);
		expect(parsed.latest).toEqual([]);
	});

	it("drops a stale finding once a later authoritative run re-analyzes its path", () => {
		recordSimplificationReport(
			simplificationReport(
				[simplificationFinding("fp-stale", "src/a.ts")],
				{ kind: "repository", selected_paths: null },
			),
			cwd,
			{ now: "2026-08-01T00:00:00Z", mirrorGlobal: false },
		);
		recordSimplificationReport(
			simplificationReport(
				[simplificationFinding("fp-fresh", "src/a.ts")],
				{ kind: "changed", selected_paths: ["src/a.ts"] },
			),
			cwd,
			{ now: "2026-08-02T00:00:00Z", mirrorGlobal: false },
		);
		const parsed = readSimplificationReceipts(cwd);
		expect(parsed.latest.map((finding) => finding.fingerprint)).toEqual(["fp-fresh"]);
		expect(parsed.evidence.latest_finding_count).toBe(1);
		expect(parsed.evidence.finding_observations).toBe(2);
	});
});

describe("potentialEvidence", () => {
	it("carries the receipt reason forward when nothing is recorded", () => {
		const parsed = readSimplificationReceipts(cwd);
		const potential = potentialEvidence(parsed);
		expect(potential.evidence_class).toBe("potential");
		expect(potential.available).toBe(false);
		expect(potential.availability).toBe("not-recorded");
		expect(potential.loc_delta).toBeNull();
		expect(potential.representative_findings).toBe(0);
		expect(potential.note).toBe("No recorded simplification run receipt is available.");
	});
});

describe("sandboxValidatedEvidence", () => {
	it("stays not-recorded with no eligible validated finding", () => {
		const parsed = readSimplificationReceipts(cwd);
		const sandbox = sandboxValidatedEvidence(parsed);
		expect(sandbox.evidence_class).toBe("sandbox-validated");
		expect(sandbox.available).toBe(false);
		expect(sandbox.availability).toBe("not-recorded");
		expect(sandbox.eligible_validated_findings).toBe(0);
		expect(sandbox.loc_delta).toBeNull();
		expect(sandbox.note).toBe(
			"No latest recorded finding has passed Sandbox validation with an exact validated delta.",
		);
	});

	it("reports unavailable when the receipt stream itself is unreadable", () => {
		writeRuns(["{not json"]);
		const sandbox = sandboxValidatedEvidence(readSimplificationReceipts(cwd));
		expect(sandbox.availability).toBe("unavailable");
		expect(sandbox.available).toBe(false);
	});
});
