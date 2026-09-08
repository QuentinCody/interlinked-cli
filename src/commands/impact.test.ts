import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFinding, recordFinding } from "../harness/findings/corpus.js";
import {
	recordSimplificationReport,
	simplificationRunsPath,
} from "../harness/findings/simplification-record.js";
import { appendReconciliationTxn } from "../harness/spec/reconciliation.js";
import type { SimplificationExperimentManifest } from "../lib/simplification-agent-ci-experiment.js";
import { buildImpactEvidence } from "../lib/impact-evidence.js";
import { recordManualDebtMarkerSnapshot } from "../lib/manual-debt-marker-record.js";
import { scanManualDebtMarkers } from "../lib/manual-debt-markers.js";
import type {
	SimplificationDelta,
	SimplificationFinding,
	SimplificationReport,
} from "../lib/simplification-types.js";
import { impactCommand } from "./impact.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);

let root = "";

function write(rel: string, content: string): void {
	const absolute = join(root, rel);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content, "utf8");
}

function git(args: string[]): void {
	execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function seedRepository(): void {
	git(["init", "--quiet"]);
	write(
		"package.json",
		JSON.stringify({ dependencies: { alpha: "1.0.0" }, devDependencies: { test: "1.0.0" } }),
	);
	write("src/a.ts", "export const a = 1;\n");
	git(["add", "."]);
	git([
		"-c",
		"user.name=Interlinked Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"--quiet",
		"-m",
		"baseline",
	]);
}

function seedObservedSources(): void {
	write(
		"package.json",
		JSON.stringify({ dependencies: { alpha: "2.0.0", beta: "1.0.0" } }),
	);
	write("src/a.ts", "export const a = 1;\nexport const b = 2;\n");
	write("src/untracked.ts", "export const untracked = true;\n");
	write(
		".interlinked/baseline-folds.jsonl",
		`${JSON.stringify({ kind: "coverage", changed: 2, refused: 1 })}\n`,
	);
	write(
		".interlinked/sessions/s1.json",
		JSON.stringify({
			session_id: "s1",
			agent: "codex",
			phase: "ENDED",
			started_at: "2026-08-01T00:00:00Z",
			last_event_at: "2026-08-01T00:01:00Z",
			tool_count: 3,
			error_count: 1,
			files_touched: ["src/a.ts"],
			tools_used: { Edit: 1 },
			tokens_total: { input: 10, output: 5 },
			edits: [
				{
					timestamp: "2026-08-01T00:00:30Z",
					session_id: "s1",
					agent_name: "codex",
					file: "src/a.ts",
					tool: "Edit",
					lines_added: 1,
					lines_removed: 0,
				},
			],
		}),
	);
	const finding = makeFinding(
		{
			bug_class: "review_missing_guard",
			message: "missing guard",
			file: "src/a.ts",
			line: 1,
			source_runner: "test-reviewer",
			now: "2026-08-01T00:00:00Z",
		},
		root,
	);
	recordFinding(finding, root, { mirrorGlobal: false });
	appendReconciliationTxn(root, {
		finding_id: finding.id,
		action: "touched",
		by: "s1",
		file: "src/a.ts",
		ts: "2026-08-01T00:01:00Z",
	});
}

interface SimplificationFindingOptions {
	overlapGroup?: string | null;
	estimated?: SimplificationDelta;
	validated?: SimplificationDelta | null;
	validation?: SimplificationFinding["validation"];
	evidenceState?: SimplificationFinding["evidence_state"];
}

function simplificationFinding(
	fingerprint: string,
	options: SimplificationFindingOptions = {},
): SimplificationFinding {
	return {
		fingerprint,
		lens: "simplification",
		source: "impact-test",
		remedy: "delete",
		evidence_state: options.evidenceState ?? "heuristic",
		confidence: 0.8,
		location: {
			path: "src/a.ts",
			start_line: 1,
			end_line: 1,
			tree_sha: "tree",
			working_tree_sha256: "worktree",
		},
		summary: `Simplification candidate ${fingerprint}`,
		replacement: null,
		evidence: [
			{
				kind: "test-observation",
				state: options.evidenceState ?? "heuristic",
				detail: `Recorded evidence for ${fingerprint}`,
				path: "src/a.ts",
			},
		],
		impact: {
			estimated: options.estimated ?? { loc: -1, dependencies_removed: [] },
			validated: options.validated ?? null,
		},
		overlap_group: options.overlapGroup ?? null,
		validation: options.validation ?? {
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

function simplificationReport(findings: SimplificationFinding[]): SimplificationReport {
	const byEvidenceState: SimplificationReport["summary"]["by_evidence_state"] = {
		candidate: 0,
		heuristic: 0,
		proven: 0,
		"sandbox-validated": 0,
	};
	for (const finding of findings) byEvidenceState[finding.evidence_state]++;
	return {
		schema_version: 1,
		lens: "simplification",
		command: "audit",
		repository: {
			repository_id: `repo-${"a".repeat(24)}`,
			root,
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
		findings,
		summary: {
			findings: findings.length,
			by_remedy: {
				delete: findings.length,
				stdlib: 0,
				native: 0,
				yagni: 0,
				shrink: 0,
			},
			by_evidence_state: byEvidenceState,
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
					source: "impact-test",
					status: "checked",
					files_considered: 1,
					analyzed_paths: ["src/a.ts"],
					findings_emitted: findings.length,
					notes: [],
				},
			],
			limitations: [],
		},
		deep_handoff: null,
		read_only: true,
	};
}

function recordSimplification(findings: SimplificationFinding[], now: string): void {
	recordSimplificationReport(simplificationReport(findings), root, { now, mirrorGlobal: false });
}

function causalManifest(): SimplificationExperimentManifest {
	return {
		schema_version: "simplification-experiment/v1",
		experiment_id: "paired-simplification-001",
		claim: {
			kind: "causal",
			statement: "The treatment reduced accepted implementation LOC in this pinned task suite.",
		},
		repository: {
			repository_id: "fixtures/simplification",
			tree_sha: SHA_A,
			source_artifact_sha256: SHA_B,
			dirty: false,
		},
		task_suite: {
			name: "simplification-adversarial",
			version: "1.0.0",
			task_set_sha256: SHA_C,
			evaluator_sha256: SHA_D,
		},
		model: {
			provider: "provider",
			family: "family",
			model: "model",
			version: "2026-08-30",
			parameters_sha256: SHA_E,
		},
		environment: {
			container_image_digest: `sha256:${SHA_F}`,
			dependency_lock_sha256: SHA_A,
			harness_version: "0.1.0",
			runtime_versions: [
				{ name: "node", version: "22.18.0" },
				{ name: "typescript", version: "5.9.3" },
			],
		},
		runs: {
			started_at: "2026-08-30T12:00:00.000Z",
			completed_at: "2026-08-30T13:00:00.000Z",
			sample_size: 20,
			failed_runs: 0,
			exclusions: ["pre-registered-timeout"],
		},
		outcomes: {
			primary_metric: "accepted_loc_removed",
			metrics: [
				{ name: "accepted_loc_removed", unit: "lines", direction: "higher_is_better" },
				{ name: "regressions", unit: "count", direction: "lower_is_better" },
			],
			safety: {
				protected_behavior_regressions: 0,
				required_checks_passed: true,
				receipt_path: "artifacts/safety.json",
				receipt_sha256: SHA_D,
			},
			completeness: {
				planned_runs: 20,
				completed_runs: 20,
				scored_runs: 20,
				coverage_path: "artifacts/coverage.json",
				coverage_sha256: SHA_E,
			},
			raw_results_path: "artifacts/raw-results.jsonl",
			raw_results_sha256: SHA_B,
			analysis_output_path: "artifacts/analysis.json",
			analysis_output_sha256: SHA_C,
		},
		causal_design: {
			design: "randomized_paired",
			experimental_unit: "task-model-seed",
			assignment_seed: "seed-2026-08-30",
			assignment_algorithm: "sha256 parity counterbalance",
			control: { name: "baseline", instructions_sha256: SHA_D },
			treatment: { name: "simplification", instructions_sha256: SHA_E },
			analysis_plan_sha256: SHA_F,
			preregistration_sha256: SHA_A,
			missing_data_policy: "Count missing terminal runs as failures.",
			blinded_evaluator: true,
		},
	};
}

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function seedCausalArtifacts(manifest: SimplificationExperimentManifest): void {
	const artifacts = [
		{ path: manifest.outcomes.raw_results_path, content: '{"run":1,"score":7}\n' },
		{ path: manifest.outcomes.analysis_output_path, content: '{"effect":2}\n' },
		{ path: manifest.outcomes.safety.receipt_path, content: '{"regressions":0}\n' },
		{ path: manifest.outcomes.completeness.coverage_path, content: '{"scored":20}\n' },
	];
	for (const artifact of artifacts) write(artifact.path, artifact.content);
	manifest.outcomes.raw_results_sha256 = sha256(artifacts[0]!.content);
	manifest.outcomes.analysis_output_sha256 = sha256(artifacts[1]!.content);
	manifest.outcomes.safety.receipt_sha256 = sha256(artifacts[2]!.content);
	manifest.outcomes.completeness.coverage_sha256 = sha256(artifacts[3]!.content);
}

function marker(ceiling: string, trigger: string): string {
	return `// interlinked-debt: ${JSON.stringify({
		id: "cache-bound",
		decision: "single-process cache",
		ceiling,
		trigger,
	})}\n`;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "impact-command-"));
	seedRepository();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("impact evidence", () => {
	it("reports actual local deltas and retained workflow records as observed", () => {
		seedObservedSources();
		recordSimplification(
			[simplificationFinding("observed-corpus")],
			"2026-08-01T00:02:00.000Z",
		);
		const report = buildImpactEvidence(root);
		const observed = report.evidence.observed.sources;
		expect(observed.git_worktree).toMatchObject({
			availability: "available",
			evidence_class: "observed",
			files_changed: 2,
			// Local `.interlinked/` receipts are measurement substrate, not
			// repository work product; only src/untracked.ts contributes.
			untracked_files: 1,
		});
		expect(observed.dependencies.added.map((row) => row.name)).toEqual(["beta"]);
		expect(observed.dependencies.removed.map((row) => row.name)).toEqual(["test"]);
		expect(observed.dependencies.changed.map((row) => row.name)).toEqual(["alpha"]);
		expect(observed.baseline_folds.by_kind.coverage).toEqual({ events: 1, changed: 2, refused: 1 });
		expect(observed.activity).toMatchObject({ sessions: 1, tool_calls: 3, lines_added: 1 });
		expect(observed.findings.reconciliation).toEqual({ open: 0, touched: 1, acked: 0 });
		expect(observed.findings.simplification).toMatchObject({
			findings: 1,
			reconciliation: { open: 1, touched: 0, acked: 0 },
			lifecycle: { candidate: 1, approved: 0, distilled: 0, superseded: 0 },
		});
	});

	it("treats a complete repository receipt as authoritative for current findings", () => {
		recordSimplification(
			[
				simplificationFinding("a", {
					overlapGroup: "shared",
					estimated: { loc: -5, dependencies_removed: ["alpha"] },
				}),
				simplificationFinding("b", {
					overlapGroup: "shared",
					estimated: { loc: -10, dependencies_removed: ["excluded-overlap"] },
				}),
				simplificationFinding("c", {
					estimated: { loc: -2, dependencies_removed: ["gamma", "beta", "beta"] },
				}),
			],
			"2026-08-30T10:00:00.000Z",
		);
		recordSimplification(
			[
				simplificationFinding("a", {
					overlapGroup: "shared",
					estimated: { loc: -7, dependencies_removed: ["delta", "alpha"] },
				}),
			],
			"2026-08-30T11:00:00.000Z",
		);

		const report = buildImpactEvidence(root);
		expect(report.simplification_receipts).toMatchObject({
			availability: "available",
			receipt_rows: 2,
			valid_receipts: 2,
			malformed_receipts: 0,
			run_count: 2,
			finding_observations: 4,
			latest_finding_count: 1,
		});
		expect(report.simplification_receipts.scopes).toHaveLength(2);
		expect(report.evidence.potential).toMatchObject({
			available: true,
			representative_findings: 1,
			overlap_groups_represented: 1,
			representative_fingerprints: ["a"],
			loc_delta: -7,
			loc_known_findings: 1,
			loc_unknown_findings: 0,
			dependencies_removed: ["alpha", "delta"],
		});
	});

	it("selects the strongest deterministic representative per overlap group", () => {
		recordSimplification(
			[
				simplificationFinding("a", {
					overlapGroup: "shared",
					estimated: { loc: -5, dependencies_removed: ["alpha"] },
				}),
				simplificationFinding("b", {
					overlapGroup: "shared",
					estimated: { loc: -10, dependencies_removed: ["strongest"] },
				}),
				simplificationFinding("c", {
					estimated: { loc: -2, dependencies_removed: ["independent"] },
				}),
			],
			"2026-08-30T10:00:00.000Z",
		);
		expect(buildImpactEvidence(root).evidence.potential).toMatchObject({
			representative_fingerprints: ["b", "c"],
			loc_delta: -12,
			dependencies_removed: ["independent", "strongest"],
		});
	});

	it("does not invent a total when any representative has unknown LOC", () => {
		recordSimplification(
			[
				simplificationFinding("known", {
					estimated: { loc: -3, dependencies_removed: ["alpha"] },
				}),
				simplificationFinding("unknown", {
					estimated: { loc: null, dependencies_removed: ["alpha", "beta"] },
				}),
			],
			"2026-08-30T10:00:00.000Z",
		);
		const potential = buildImpactEvidence(root).evidence.potential;
		expect(potential).toMatchObject({
			loc_delta: null,
			loc_known_findings: 1,
			loc_unknown_findings: 1,
			dependencies_removed: ["alpha", "beta"],
		});
	});

	it("admits exact deltas only through the passed Sandbox validation gate", () => {
		const sandboxPassed: SimplificationFinding["validation"] = {
			status: "passed",
			executor: "sandbox",
			commands: ["npm test"],
			artifact_sha: SHA_A,
			notes: [],
		};
		recordSimplification(
			[
				simplificationFinding("a-sandbox", {
					overlapGroup: "shared",
					validated: { loc: -4, dependencies_removed: ["exact"] },
					validation: sandboxPassed,
					evidenceState: "sandbox-validated",
				}),
				simplificationFinding("e-sandbox", {
					overlapGroup: "shared",
					validated: { loc: -9, dependencies_removed: ["excluded-overlap"] },
					validation: sandboxPassed,
					evidenceState: "sandbox-validated",
				}),
				simplificationFinding("b-local", {
					validated: { loc: -8, dependencies_removed: ["local"] },
					validation: { ...sandboxPassed, executor: "local" },
				}),
				simplificationFinding("c-failed", {
					validated: { loc: -7, dependencies_removed: ["failed"] },
					validation: { ...sandboxPassed, status: "failed" },
				}),
				simplificationFinding("d-inexact", {
					validated: null,
					validation: sandboxPassed,
				}),
			],
			"2026-08-30T10:00:00.000Z",
		);

		expect(buildImpactEvidence(root).evidence.sandbox_validated).toMatchObject({
			available: true,
			availability: "available",
			eligible_validated_findings: 2,
			representative_findings: 1,
			representative_fingerprints: ["e-sandbox"],
			loc_delta: -9,
			dependencies_removed: ["excluded-overlap"],
		});
	});

	it("counts malformed receipt rows without using them as evidence", () => {
		recordSimplification(
			[simplificationFinding("valid", { estimated: { loc: -2, dependencies_removed: [] } })],
			"2026-08-30T10:00:00.000Z",
		);
		appendFileSync(
			simplificationRunsPath(root),
			`${JSON.stringify({ schema_version: 1, kind: "simplification_run" })}\n{torn\n`,
		);
		const report = buildImpactEvidence(root);
		expect(report.simplification_receipts).toMatchObject({
			receipt_rows: 3,
			valid_receipts: 1,
			malformed_receipts: 2,
			run_count: 1,
			finding_observations: 1,
		});
		expect(report.evidence.potential.loc_delta).toBe(-2);
	});

	it("reports manual debt snapshots and transitions only as observed lifecycle facts", () => {
		write("src/debt.ts", marker("10k keys", "keys > 10000 items"));
		recordManualDebtMarkerSnapshot(scanManualDebtMarkers({ cwd: root }), root, {
			now: "2026-08-30T10:00:00.000Z",
		});
		write("src/debt.ts", marker("20k keys", "keys > 20000 items"));
		recordManualDebtMarkerSnapshot(scanManualDebtMarkers({ cwd: root }), root, {
			now: "2026-08-30T11:00:00.000Z",
		});
		write("src/debt.ts", "export const cache = new Map();\n");
		recordManualDebtMarkerSnapshot(scanManualDebtMarkers({ cwd: root }), root, {
			now: "2026-08-30T12:00:00.000Z",
		});

		const observed = buildImpactEvidence(root).evidence.observed.sources.manual_debt;
		expect(observed).toMatchObject({
			availability: "available",
			evidence_class: "observed",
			snapshot_count: 3,
			transitions: { opened: 1, changed: 1, closed: 1 },
			current_markers: 0,
			latest_scope: { repository_root: root, roots: ["."], files_scanned: 2 },
		});
		expect(observed.scope).toContain("latest scope-aware materialized state");
	});

	it("exposes causal evidence only for a valid causal experiment manifest", () => {
		const manifest = causalManifest();
		seedCausalArtifacts(manifest);
		write("experiment.json", JSON.stringify(manifest));
		const causal = buildImpactEvidence(root, { experimentManifest: "experiment.json" }).evidence.causal;
		expect(causal).toMatchObject({
			available: true,
			availability: "available",
			artifacts_verified: true,
			experiment_id: "paired-simplification-001",
			manifest_path: join(root, "experiment.json"),
			manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			safety: { protected_behavior_regressions: 0, required_checks_passed: true },
			completeness: { planned_runs: 20, completed_runs: 20, scored_runs: 20 },
		});
	});

	it("keeps causal evidence unavailable when a declared artifact hash does not match", () => {
		const manifest = causalManifest();
		seedCausalArtifacts(manifest);
		write(manifest.outcomes.analysis_output_path, '{"tampered":true}\n');
		write("experiment.json", JSON.stringify(manifest));
		const causal = buildImpactEvidence(root, { experimentManifest: "experiment.json" }).evidence.causal;
		expect(causal).toMatchObject({
			available: false,
			availability: "unavailable",
			artifacts_verified: false,
			experiment_id: "paired-simplification-001",
		});
		expect(causal.note).toContain("artifact hash does not match");
	});

	it("keeps observational and incomplete causal manifests unavailable", () => {
		const observational = structuredClone(causalManifest());
		observational.claim.kind = "observational";
		observational.causal_design = null;
		write("observational.json", JSON.stringify(observational));
		const observedClaim = buildImpactEvidence(root, {
			experimentManifest: "observational.json",
		}).evidence.causal;
		expect(observedClaim).toMatchObject({ available: false, availability: "unavailable" });
		expect(observedClaim.note).toContain("observational");

		const incomplete = structuredClone(causalManifest());
		incomplete.causal_design = null;
		write("incomplete.json", JSON.stringify(incomplete));
		const rejected = buildImpactEvidence(root, {
			experimentManifest: "incomplete.json",
		}).evidence.causal;
		expect(rejected).toMatchObject({ available: false, availability: "unavailable" });
		expect(rejected.note).toContain("causal claims require");
	});

	it("marks readable malformed manifests unavailable", () => {
		write("malformed.json", "{not-json");
		const causal = buildImpactEvidence(root, {
			experimentManifest: "malformed.json",
		}).evidence.causal;
		expect(causal).toMatchObject({ available: false, availability: "unavailable" });
		expect(causal.note).toContain("not valid JSON");
	});

	it("returns a command error for an explicitly supplied unreadable manifest", async () => {
		const lines: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
			lines.push(String(value));
		});
		let exitCode: number;
		try {
			exitCode = await impactCommand({
				cwd: root,
				json: true,
				experimentManifest: "missing.json",
			});
		} finally {
			spy.mockRestore();
		}
		expect(exitCode).toBe(1);
		expect(JSON.parse(lines.join("\n"))).toMatchObject({
			schema_version: 1,
			error: expect.stringContaining("Explicit experiment manifest is unreadable"),
		});
	});

	it("keeps unrecorded potential, Sandbox-validated, and causal classes explicit", () => {
		const report = buildImpactEvidence(root);
		expect(report.evidence.potential.available).toBe(false);
		expect(report.evidence.potential.loc_delta).toBeNull();
		expect(report.evidence.sandbox_validated.available).toBe(false);
		expect(report.evidence.sandbox_validated.loc_delta).toBeNull();
		expect(report.evidence.causal.available).toBe(false);
		expect(JSON.stringify(report)).not.toMatch(/\bsav(?:ed|ings?)\b/i);
	});

	it("marks an invalid base unavailable instead of guessing a comparison", () => {
		const report = buildImpactEvidence(root, "missing-ref");
		expect(report.evidence.observed.sources.git_worktree.availability).toBe("unavailable");
		expect(report.evidence.observed.sources.dependencies.availability).toBe("unavailable");
	});

	it("emits the same evidence classes through --json", async () => {
		const lines: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
			lines.push(String(value));
		});
		let exitCode: number;
		try {
			exitCode = await impactCommand({ cwd: root, json: true });
		} finally {
			spy.mockRestore();
		}
		expect(exitCode).toBe(0);
		const parsed: unknown = JSON.parse(lines.join("\n"));
		expect(parsed).toMatchObject({
			evidence: {
				potential: { evidence_class: "potential" },
				sandbox_validated: { evidence_class: "sandbox-validated" },
				observed: {
					evidence_class: "observed",
					sources: { manual_debt: { evidence_class: "observed" } },
				},
				causal: { evidence_class: "causal" },
			},
		});
	});

	it("prints the default normal-mode text with rendered potential, sandbox, and unavailable-causal lines", async () => {
		seedObservedSources();
		recordSimplification(
			[
				simplificationFinding("a", {
					overlapGroup: "shared",
					estimated: { loc: -5, dependencies_removed: ["alpha"] },
				}),
				simplificationFinding("b", {
					overlapGroup: "shared",
					estimated: { loc: -10, dependencies_removed: ["strongest"] },
				}),
				simplificationFinding("c", {
					estimated: { loc: -2, dependencies_removed: ["independent"] },
				}),
			],
			"2026-08-30T10:00:00.000Z",
		);
		const lines: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
			lines.push(String(value));
		});
		let exitCode: number;
		try {
			exitCode = await impactCommand({ cwd: root });
		} finally {
			spy.mockRestore();
		}
		expect(exitCode).toBe(0);
		const text = lines.join("\n");
		expect(text.startsWith("Impact evidence\n")).toBe(true);
		expect(text).toContain(
			"[potential:recorded] 2 representative finding(s), LOC delta -12; dependencies removed: independent, strongest",
		);
		expect(text).toContain(
			"[sandbox-validated:not-recorded] 0 representative finding(s), LOC delta unavailable; dependency delta unavailable",
		);
		expect(text).toContain("[causal:not-recorded] No controlled-experiment manifest was supplied.");
		expect(text).toContain("[observed:recorded] git HEAD..worktree: 2 tracked file(s)");
		expect(text).toContain("; 1 untracked");
		expect(text).toContain("[observed:recorded] dependencies: +1/-1, 1 version change(s)");
		expect(text).toContain("[observed:recorded] baseline folds: 1 event(s) across 1 kind(s)");
		expect(text).toContain(
			"[observed:recorded] activity: 1 session(s), 3 tool call(s), 1 edit event(s), +1/-0 gross lines",
		);
		expect(text).toContain(
			"[observed:recorded] review findings: 1 total — 0 open, 1 touched, 0 acked",
		);
	});

	it("reports available causal evidence through the passed experiment manifest in normal mode", async () => {
		const manifest = causalManifest();
		seedCausalArtifacts(manifest);
		write("experiment.json", JSON.stringify(manifest));
		const lines: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
			lines.push(String(value));
		});
		let exitCode: number;
		try {
			exitCode = await impactCommand({ cwd: root, experimentManifest: "experiment.json" });
		} finally {
			spy.mockRestore();
		}
		expect(exitCode).toBe(0);
		const text = lines.join("\n");
		expect(text).toContain(
			"[causal:available] paired-simplification-001: The treatment reduced accepted implementation LOC in this pinned task suite.; artifacts verified, 0 protected-behavior regression(s), 20/20 run(s) scored",
		);
	});

	it("collapses every evidence line into one middle-dot-joined summary in --short mode", async () => {
		const lines: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
			lines.push(String(value));
		});
		let exitCode: number;
		try {
			exitCode = await impactCommand({ cwd: root, short: true });
		} finally {
			spy.mockRestore();
		}
		expect(exitCode).toBe(0);
		expect(lines).toHaveLength(1);
		const text = lines[0]!;
		expect(text).not.toContain("\n");
		expect(text).toContain(" · ");
		expect(text).toContain("[receipts:not-recorded]");
		expect(text).toContain("[causal:not-recorded] No controlled-experiment manifest was supplied.");
	});

	it("prints extended scope and path detail through --full", async () => {
		const lines: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
			lines.push(String(value));
		});
		let exitCode: number;
		try {
			exitCode = await impactCommand({ cwd: root, full: true });
		} finally {
			spy.mockRestore();
		}
		expect(exitCode).toBe(0);
		const text = lines.join("\n");
		expect(text.startsWith("Impact evidence\n")).toBe(true);
		expect(text).toContain(`Simplification receipt path: ${simplificationRunsPath(root)}`);
		expect(text).toContain("Manual debt latest source scope:");
		expect(text).toContain("Baseline fold kinds:");
	});

	it("writes a human-readable error to stderr instead of JSON when --json is not requested", async () => {
		// vi.spyOn(process.stderr, "write") does not observe calls in this
		// runtime (the stream's write accessor is not a plain own property),
		// so capture with a plain reassignment instead.
		const captured: string[] = [];
		const originalWrite = process.stderr.write;
		process.stderr.write = ((chunk: string) => {
			captured.push(chunk);
			return true;
		});
		let exitCode: number;
		try {
			exitCode = await impactCommand({ cwd: root, experimentManifest: "missing.json" });
		} finally {
			process.stderr.write = originalWrite;
		}
		expect(exitCode).toBe(1);
		expect(captured.join("")).toContain(
			"Impact evidence unavailable: Explicit experiment manifest is unreadable",
		);
	});
});
