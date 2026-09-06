import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimplificationReport } from "../../lib/simplification-types.js";
import { findingsCorpusPath, loadFindings } from "./corpus.js";
import {
	loadSimplificationRecordedStatus,
	loadSimplificationRunReceipts,
	parseSimplificationRunReceipt,
	recordSimplificationReport,
	simplificationCorpusFindingId,
	simplificationRunFingerprint,
	simplificationRunsPath,
} from "./simplification-record.js";

// Only `readFileSync` is overridden (and only when its path matches the
// currently-armed failure target); every other node:fs call forwards to the
// real implementation, so the module's own mkdirSync/appendFileSync fixture
// writes and every pre-existing test in this file keep working unmodified.
const fsFailure = vi.hoisted(() => ({
	// SAFETY: widening a `null` literal to its nullable-string field type; no
	// value is asserted here, only the type of a flag that starts unarmed.
	readPath: null as string | null,
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: (...args: unknown[]) => {
			const [target] = args;
			if (typeof target === "string" && target === fsFailure.readPath) {
				throw new Error("EACCES: permission denied, read");
			}
			// SAFETY: forwards the exact captured arguments to the real
			// overloaded function and preserves its runtime return value.
			return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
		},
	};
});

let fixture: string;

function reportFixture(): SimplificationReport {
	return {
		schema_version: 1,
		lens: "simplification",
		command: "scan",
		repository: {
			repository_id: `repo-${"a".repeat(24)}`,
			root: fixture,
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
				source: "deadcode.static-import-graph",
				remedy: "delete",
				evidence_state: "heuristic",
				confidence: 0.8,
				location: {
					path: "src/a.ts",
					start_line: 2,
					end_line: 2,
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
					estimated: { loc: -1, dependencies_removed: [] },
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
					source: "deadcode.static-import-graph",
					status: "checked",
					files_considered: 1,
					analyzed_paths: ["src/a.ts"],
					findings_emitted: 1,
					notes: [],
				},
			],
			limitations: [],
		},
		deep_handoff: null,
		read_only: true,
	};
}

beforeEach(() => {
	fixture = mkdtempSync(join(tmpdir(), "simplification-record-"));
	const source = join(fixture, "src", "a.ts");
	mkdirSync(dirname(source), { recursive: true });
	writeFileSync(source, "export const used = 1;\nexport const abandoned = 2;\n");
});

afterEach(() => {
	fsFailure.readPath = null;
	rmSync(fixture, { recursive: true, force: true });
});

describe("simplification run recording", () => {
	it("records one receipt and upserts the finding into the common corpus", () => {
		const report = reportFixture();
		const result = recordSimplificationReport(report, fixture, {
			now: "2026-08-30T12:00:00.000Z",
			mirrorGlobal: false,
		});

		expect(result.receipt_path).toBe(simplificationRunsPath(fixture));
		expect(result.corpus_path).toBe(findingsCorpusPath(fixture));
		expect(result.findings_upserted).toBe(1);
		expect(loadSimplificationRunReceipts(fixture)).toEqual([result.receipt]);

		const rows = loadFindings(fixture);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual(expect.objectContaining({
			id: simplificationCorpusFindingId(report, report.findings[0]!),
			message: "Remove an unreachable export",
			category: "quality",
			status: "candidate",
			anchor_context: expect.any(Array),
		}));
		expect(rows[0]?.extensions?.simplification).toEqual(expect.objectContaining({
			run_fingerprint: result.receipt.run_fingerprint,
			recorded_at: "2026-08-30T12:00:00.000Z",
			command: "scan",
			finding: report.findings[0],
		}));
	});

	it("keeps finding identity stable while retaining every explicit run receipt", () => {
		const report = reportFixture();
		recordSimplificationReport(report, fixture, {
			now: "2026-08-30T12:00:00.000Z",
			mirrorGlobal: false,
		});
		recordSimplificationReport(report, fixture, {
			now: "2026-08-30T13:00:00.000Z",
			mirrorGlobal: false,
		});

		const rows = loadFindings(fixture);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.times_observed).toBe(1);
		expect(rows[0]?.extensions?.simplification?.recorded_at).toBe(
			"2026-08-30T13:00:00.000Z",
		);
		const status = loadSimplificationRecordedStatus(fixture);
		expect(status).toEqual(expect.objectContaining({
			run_count: 2,
			finding_observations: 2,
			corpus_findings: 1,
			latest_recorded_at: "2026-08-30T13:00:00.000Z",
		}));
		expect(status.runs.map((receipt) => receipt.recorded_at)).toEqual([
			"2026-08-30T13:00:00.000Z",
			"2026-08-30T12:00:00.000Z",
		]);
	});

	it("skips torn and self-inconsistent receipt rows", () => {
		const result = recordSimplificationReport(reportFixture(), fixture, {
			now: "2026-08-30T12:00:00.000Z",
			mirrorGlobal: false,
		});
		appendFileSync(
			simplificationRunsPath(fixture),
			`${JSON.stringify({ ...result.receipt, run_fingerprint: "tampered" })}\n{torn\n`,
		);
		expect(loadSimplificationRunReceipts(fixture)).toEqual([result.receipt]);
		expect(parseSimplificationRunReceipt({ ...result.receipt, corpus_finding_ids: [] })).toBeNull();
	});

	it("treats an unreadable (but present) receipts file as no receipts, not a throw", () => {
		const result = recordSimplificationReport(reportFixture(), fixture, {
			now: "2026-08-30T12:00:00.000Z",
			mirrorGlobal: false,
		});
		// The file genuinely holds one valid, parseable receipt — proving the
		// empty result below comes from the injected read failure short-circuiting
		// before any line is parsed, not from the file being empty or malformed.
		expect(loadSimplificationRunReceipts(fixture)).toEqual([result.receipt]);

		fsFailure.readPath = simplificationRunsPath(fixture);
		expect(loadSimplificationRunReceipts(fixture)).toEqual([]);
	});

	it("falls back to appending without a repair prefix when the torn-tail probe read fails", () => {
		const path = simplificationRunsPath(fixture);
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, "{torn", "utf8");

		fsFailure.readPath = path;
		const result = recordSimplificationReport(reportFixture(), fixture, {
			now: "2026-08-30T12:00:00.000Z",
			mirrorGlobal: false,
		});
		fsFailure.readPath = null;
		// No "\n" was inserted between the torn tail and the new receipt (the
		// success path, exercised by the sibling test above, would have added
		// one) — proving the read failure was caught and treated as "assume
		// no repair needed" rather than propagating out of recordSimplificationReport.
		expect(readFileSync(path, "utf-8")).toBe(`{torn${JSON.stringify(result.receipt)}\n`);
	});

	it("repairs a torn receipt boundary before appending the next valid run", () => {
		const path = simplificationRunsPath(fixture);
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, "{torn", "utf8");
		const result = recordSimplificationReport(reportFixture(), fixture, {
			now: "2026-08-30T12:00:00.000Z",
			mirrorGlobal: false,
		});
		expect(loadSimplificationRunReceipts(fixture)).toEqual([result.receipt]);
	});

	it("refuses an invalid report before creating persistence files", () => {
		const report = reportFixture();
		report.summary.findings = 2;
		expect(() => recordSimplificationReport(report, fixture, { mirrorGlobal: false })).toThrow(
			"invalid simplification report",
		);
		expect(loadSimplificationRunReceipts(fixture)).toEqual([]);
		expect(loadFindings(fixture)).toEqual([]);
	});

	it("refuses repository spoofing before reading anchors or writing receipts", () => {
		const report = reportFixture();
		report.repository.root = dirname(fixture);
		expect(() => recordSimplificationReport(report, fixture, { mirrorGlobal: false })).toThrow(
			"repository does not match recording root",
		);
		expect(loadSimplificationRunReceipts(fixture)).toEqual([]);
		expect(loadFindings(fixture)).toEqual([]);
	});

	it("hashes canonical report content rather than object insertion order", () => {
		const report = reportFixture();
		const reordered = {
			read_only: report.read_only,
			deep_handoff: report.deep_handoff,
			coverage: report.coverage,
			summary: report.summary,
			findings: report.findings,
			scope: report.scope,
			repository: report.repository,
			command: report.command,
			lens: report.lens,
			schema_version: report.schema_version,
		};
		expect(simplificationRunFingerprint(reordered)).toBe(
			simplificationRunFingerprint(report),
		);
	});

	it("separates otherwise identical finding fingerprints from different repositories", () => {
		const report = reportFixture();
		const other = structuredClone(report);
		other.repository.repository_id = `repo-${"b".repeat(24)}`;
		expect(simplificationCorpusFindingId(report, report.findings[0]!)).not.toBe(
			simplificationCorpusFindingId(other, other.findings[0]!),
		);
	});
});
