// ===========================================
// Simplification findings — explicit local persistence
// ===========================================
// A simplification report is ephemeral unless its caller opts into recording.
// Recording has two outputs with deliberately different jobs:
//   - simplification-runs.jsonl is an append-only receipt stream;
//   - corpus.jsonl owns finding identity, provenance, and lifecycle.
// The receipt is a snapshot, not a second reconciliation ledger.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalJson } from "../../lib/audit-chain.js";
import { interlinkedPath } from "../../lib/interlinked-path.js";
import { isJsonObject } from "../../lib/json-types.js";
import { parseSimplificationReport } from "../../lib/simplification-schema.js";
import type {
	SimplificationFinding,
	SimplificationReport,
} from "../../lib/simplification-types.js";
import { captureAnchor } from "./anchor-liveness.js";
import {
	findingsCorpusPath,
	loadFindings,
	makeFinding,
	upsertFinding,
	type Finding,
} from "./corpus.js";
import {
	SIMPLIFICATION_EXTENSION_SCHEMA_VERSION,
	type SimplificationFindingExtension,
} from "./simplification-extension.js";

const SIMPLIFICATION_RUN_RECEIPT_SCHEMA_VERSION = 1 as const;
const SIMPLIFICATION_RUNS_FILE = "simplification-runs.jsonl";
const MAX_PROVENANCE_QUOTE_LENGTH = 1000;

export interface SimplificationRunReceipt {
	schema_version: typeof SIMPLIFICATION_RUN_RECEIPT_SCHEMA_VERSION;
	kind: "simplification_run";
	run_fingerprint: string;
	recorded_at: string;
	report: SimplificationReport;
	corpus_finding_ids: string[];
}

interface RecordSimplificationOptions {
	/** Injectable clock for deterministic tests. */
	now?: string | undefined;
	clock?: (() => number) | undefined;
	/** Mirror corpus upserts to the derived global cache. Default true. */
	mirrorGlobal?: boolean | undefined;
}

export interface SimplificationRecordResult {
	receipt: SimplificationRunReceipt;
	receipt_path: string;
	corpus_path: string;
	findings_upserted: number;
}

export interface SimplificationRecordedStatus {
	schema_version: typeof SIMPLIFICATION_RUN_RECEIPT_SCHEMA_VERSION;
	kind: "simplification_recorded_status";
	root: string;
	runs_path: string;
	corpus_path: string;
	run_count: number;
	finding_observations: number;
	corpus_findings: number;
	latest_recorded_at: string | null;
	/** Newest recorded run first. */
	runs: SimplificationRunReceipt[];
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf-8").digest("hex");
}

export function simplificationRunsPath(cwd: string): string {
	return interlinkedPath(resolve(cwd), "findings", SIMPLIFICATION_RUNS_FILE);
}

export function simplificationRunFingerprint(report: SimplificationReport): string {
	return sha256(`simplification-run/v1\0${canonicalJson(report)}`);
}

export function simplificationCorpusFindingId(
	report: SimplificationReport,
	finding: SimplificationFinding,
): string {
	return `simplification-${sha256([
		"simplification-finding/v1",
		report.repository.repository_id,
		finding.fingerprint,
	].join("\0"))}`;
}

function sourceSlug(source: string): string {
	return source.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function findingLines(finding: SimplificationFinding): [number, number] | undefined {
	const start = finding.location.start_line;
	if (start === null) return undefined;
	return [start, finding.location.end_line ?? start];
}

interface SimplificationRecordContext {
	report: SimplificationReport;
	runFingerprint: string;
	recordedAt: string;
	cwd: string;
}

function simplificationExtension(
	context: SimplificationRecordContext,
	finding: SimplificationFinding,
): SimplificationFindingExtension {
	return {
		schema_version: SIMPLIFICATION_EXTENSION_SCHEMA_VERSION,
		run_fingerprint: context.runFingerprint,
		recorded_at: context.recordedAt,
		command: context.report.command,
		repository: context.report.repository,
		scope: context.report.scope,
		coverage: context.report.coverage,
		finding,
	};
}

function corpusFinding(
	context: SimplificationRecordContext,
	finding: SimplificationFinding,
): Finding {
	const lines = findingLines(finding);
	const base = makeFinding({
		bug_class: `simplification_${sourceSlug(finding.source)}_${finding.remedy}`,
		message: finding.summary,
		file: finding.location.path,
		line: finding.location.start_line ?? undefined,
		lines,
		severity: "unknown",
		category: "quality",
		fix_instruction: finding.replacement ?? undefined,
		aliases: ["simplification", `simplification_${finding.remedy}`],
		source_runner: "interlinked-simplify",
		repo: context.report.repository.root,
		commit_sha: context.report.repository.head_sha ?? undefined,
		quote: finding.evidence
			.map((item) => item.detail)
			.join("\n")
			.slice(0, MAX_PROVENANCE_QUOTE_LENGTH),
		created_at: context.recordedAt,
		actionability: "suggestion",
		raw_sha256: sha256(canonicalJson(finding)),
		now: context.recordedAt,
	}, context.cwd);
	return captureAnchor({
		...base,
		id: simplificationCorpusFindingId(context.report, finding),
		extensions: {
			simplification: simplificationExtension(context, finding),
		},
	}, context.cwd);
}

function stringList(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return value.every((entry): entry is string => typeof entry === "string")
		? [...value]
		: null;
}

export function parseSimplificationRunReceipt(value: unknown): SimplificationRunReceipt | null {
	if (!isJsonObject(value)) return null;
	if (value.schema_version !== SIMPLIFICATION_RUN_RECEIPT_SCHEMA_VERSION) return null;
	if (value.kind !== "simplification_run") return null;
	if (typeof value.run_fingerprint !== "string" || value.run_fingerprint.length === 0) return null;
	if (typeof value.recorded_at !== "string" || value.recorded_at.length === 0) return null;
	const report = parseSimplificationReport(value.report);
	const corpusFindingIds = stringList(value.corpus_finding_ids);
	if (!report || !corpusFindingIds) return null;
	if (simplificationRunFingerprint(report) !== value.run_fingerprint) return null;
	const expectedIds = report.findings.map(
		(finding) => simplificationCorpusFindingId(report, finding),
	);
	if (canonicalJson(expectedIds) !== canonicalJson(corpusFindingIds)) return null;
	return {
		schema_version: SIMPLIFICATION_RUN_RECEIPT_SCHEMA_VERSION,
		kind: "simplification_run",
		run_fingerprint: value.run_fingerprint,
		recorded_at: value.recorded_at,
		report,
		corpus_finding_ids: corpusFindingIds,
	};
}

/** Read valid local receipts oldest-first. Missing, corrupt, and torn rows are skipped. */
export function loadSimplificationRunReceipts(cwd: string): SimplificationRunReceipt[] {
	const path = simplificationRunsPath(cwd);
	if (!existsSync(path)) return [];
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch {
		return [];
	}
	const receipts: SimplificationRunReceipt[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const receipt = parseSimplificationRunReceipt(JSON.parse(line));
			if (receipt) receipts.push(receipt);
		} catch (error) {
			// An interrupted append may leave one torn tail row; earlier receipts remain valid.
			void error;
		}
	}
	return receipts;
}

function tornTailPrefix(path: string): string {
	if (!existsSync(path)) return "";
	try {
		const bytes = readFileSync(path);
		return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? "\n" : "";
	} catch (readError) {
		void readError;
		return "";
	}
}

/**
 * Explicitly persist one completed report. Corpus rows land before the run
 * receipt so a visible receipt never claims finding upserts that did not run.
 */
export function recordSimplificationReport(
	reportValue: SimplificationReport,
	cwd: string,
	options: RecordSimplificationOptions = {},
): SimplificationRecordResult {
	const root = resolve(cwd);
	const report = parseSimplificationReport(reportValue);
	if (!report) throw new Error("refusing to record an invalid simplification report");
	if (resolve(report.repository.root) !== root) {
		throw new Error("simplification report repository does not match recording root");
	}
	const recordedAt = options.now
		?? new Date((options.clock ?? Date.now)()).toISOString();
	if (recordedAt.length === 0) throw new Error("recorded_at must be a non-empty timestamp");
	const runFingerprint = simplificationRunFingerprint(report);
	const corpusFindingIds = report.findings.map(
		(finding) => simplificationCorpusFindingId(report, finding),
	);
	const context: SimplificationRecordContext = {
		report,
		runFingerprint,
		recordedAt,
		cwd: root,
	};
	for (const finding of report.findings) {
		upsertFinding(
			corpusFinding(context, finding),
			root,
			{ mirrorGlobal: options.mirrorGlobal },
		);
	}
	const receipt: SimplificationRunReceipt = {
		schema_version: SIMPLIFICATION_RUN_RECEIPT_SCHEMA_VERSION,
		kind: "simplification_run",
		run_fingerprint: runFingerprint,
		recorded_at: recordedAt,
		report,
		corpus_finding_ids: corpusFindingIds,
	};
	const receiptPath = simplificationRunsPath(root);
	mkdirSync(dirname(receiptPath), { recursive: true });
	appendFileSync(receiptPath, `${tornTailPrefix(receiptPath)}${JSON.stringify(receipt)}\n`, "utf-8");
	return {
		receipt,
		receipt_path: receiptPath,
		corpus_path: findingsCorpusPath(root),
		findings_upserted: corpusFindingIds.length,
	};
}

export function loadSimplificationRecordedStatus(cwd: string): SimplificationRecordedStatus {
	const root = resolve(cwd);
	const chronological = loadSimplificationRunReceipts(root);
	const latest = chronological.at(-1) ?? null;
	const corpusFindings = loadFindings(root).filter(
		(finding) => finding.extensions?.simplification !== undefined,
	);
	return {
		schema_version: SIMPLIFICATION_RUN_RECEIPT_SCHEMA_VERSION,
		kind: "simplification_recorded_status",
		root,
		runs_path: simplificationRunsPath(root),
		corpus_path: findingsCorpusPath(root),
		run_count: chronological.length,
		finding_observations: chronological.reduce(
			(total, receipt) => total + receipt.report.summary.findings,
			0,
		),
		corpus_findings: corpusFindings.length,
		latest_recorded_at: latest?.recorded_at ?? null,
		runs: [...chronological].reverse(),
	};
}
