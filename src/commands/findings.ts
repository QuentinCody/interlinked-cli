// `interlinked findings` — review-report ingestion + reconciliation
// (docs/design/spec-audit-runtime-checks.md §4, spike 4). Converts an
// external reviewer's numbered findings (Codex/Sol format) into durable
// corpus rows, then tracks each one to closure: touched by an edit, or
// acked with a reason. Detection and bookkeeping only — resolving a
// finding is always the agent's/human's edit, never this tool's.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Command } from "commander";
import { captureAnchor, classifyAnchor } from "../harness/findings/anchor-liveness.js";
import {
	type Finding,
	findingsCorpusPath,
	loadFindings,
	makeFinding,
	recordFinding,
	upsertFinding,
} from "../harness/findings/corpus.js";
import {
	appendReconciliationTxn,
	loadReconciliation,
	reconciliationStateOf,
} from "../harness/spec/reconciliation.js";
import { parseReviewFindings } from "../harness/spec/review-ingest.js";

/** bug_class slug from the statement's first words. */
function statementSlug(statement: string): string {
	const words = statement.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/);
	return `review_${words.filter(Boolean).slice(0, 6).join("_") || "unstated"}`;
}

/** Ingested-review rows are identified by their bug_class prefix. */
export function isReviewFinding(f: Finding): boolean {
	return f.bug_class.startsWith("review_");
}

export interface IngestSummary {
	parsed: number;
	recorded: number;
	anchored: number;
}

/** Parse a report file and record every finding into the corpus. */
export function ingestReviewReport(
	reportPath: string,
	reviewer: string,
	cwd: string,
): IngestSummary {
	const text = readFileSync(reportPath, "utf8");
	const parsed = parseReviewFindings(text);
	let anchored = 0;
	for (const p of parsed) {
		if (p.file) anchored++;
		const finding = makeFinding(
			{
				bug_class: statementSlug(p.statement),
				message: p.statement,
				file: p.file,
				line: p.line,
				severity: p.severity === "unknown" ? undefined : p.severity,
				source_runner: reviewer,
				url: `file://${reportPath}#finding-${p.index}`,
				quote: p.quote ?? p.raw.slice(0, 300),
				// Content hash so two DISTINCT unanchored findings with the same
				// leading words get distinct ids instead of overwriting each
				// other (round-2 #4). For anchored findings the file:line already
				// disambiguates; this just adds provenance completeness.
				raw_sha256: createHash("sha256").update(p.raw).digest("hex"),
			},
			cwd,
		);
		// Upsert (not append): re-ingesting the same finding from a second
		// reviewer MERGES provenance rather than replacing it (round-2 #6).
		// captureAnchor (LG-6) stamps the content anchor from the live tree so
		// `findings verify` can classify live/moved/drifted/gone later.
		upsertFinding(captureAnchor(finding, cwd), cwd);
	}
	return { parsed: parsed.length, recorded: parsed.length, anchored };
}

export interface AnchorVerifyRow {
	finding: Finding;
	state: ReturnType<typeof classifyAnchor>["state"];
	newLine?: number | undefined;
}

export interface AnchorVerifySummary {
	rows: AnchorVerifyRow[];
	counts: Record<AnchorVerifyRow["state"], number>;
	reanchored: number;
}

/** LG-6: re-verify every anchored review finding against the working tree.
 *  `write` re-anchors `moved` rows — a fresh corpus row (last-write-wins) at
 *  the new line + an append-only `reanchored` txn. State never changes:
 *  remap keeps the ledger true; it never closes anything. */
export function verifyFindingAnchors(cwd: string, write: boolean): AnchorVerifySummary {
	const rows: AnchorVerifyRow[] = [];
	const counts = { live: 0, moved: 0, drifted: 0, gone: 0, unverified: 0 };
	let reanchored = 0;
	for (const f of loadFindings(cwd).filter(isReviewFinding)) {
		if (!f.file || f.line < 1) continue;
		const verdict = classifyAnchor(f, cwd);
		counts[verdict.state]++;
		rows.push({ finding: f, state: verdict.state, newLine: verdict.newLine });
		if (write && verdict.state === "moved" && verdict.newLine !== undefined) {
			recordFinding(captureAnchor({ ...f, line: verdict.newLine }, cwd), cwd);
			appendReconciliationTxn(cwd, {
				finding_id: f.id,
				action: "reanchored",
				by: "findings-verify",
				file: f.file,
				line: verdict.newLine,
				ts: new Date().toISOString(),
			});
			reanchored++;
		}
	}
	return { rows, counts, reanchored };
}

function printIngestSummary(report: string, opts: { reviewer: string }): void {
	const cwd = process.cwd();
	const summary = ingestReviewReport(report, opts.reviewer, cwd);
	console.log(
		`Ingested ${summary.recorded}/${summary.parsed} finding(s) from ${basename(report)} (${summary.anchored} with file anchors) → ${findingsCorpusPath(cwd)}`,
	);
	console.log(
		"Track them with `interlinked findings status`; close with edits (touched) or `interlinked findings ack <id> --reason \"…\"`.",
	);
}

function printFindingStatus(opts: { all?: boolean }): void {
	const cwd = process.cwd();
	const rows = loadFindings(cwd).filter(isReviewFinding);
	const recon = loadReconciliation(cwd);
	const byState = { open: 0, touched: 0, acked: 0 };
	for (const f of rows) byState[reconciliationStateOf(recon, f.id)]++;
	console.log(
		`Review findings: ${rows.length} total — ${byState.open} open, ${byState.touched} touched, ${byState.acked} acked`,
	);
	for (const f of rows) {
		const state = reconciliationStateOf(recon, f.id);
		if (!opts.all && state !== "open") continue;
		const anchor = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : "";
		console.log(`  [${state}] ${f.id}${anchor} — ${f.message.slice(0, 100)}`);
	}
}

function printAnchorVerification(opts: { write?: boolean }): void {
	const cwd = process.cwd();
	const summary = verifyFindingAnchors(cwd, opts.write === true);
	const c = summary.counts;
	console.log(
		`Anchors: ${c.live} live, ${c.moved} moved, ${c.drifted} drifted, ${c.gone} gone, ${c.unverified} unverified` +
			(summary.reanchored > 0 ? ` — re-anchored ${summary.reanchored}` : ""),
	);
	for (const row of summary.rows) {
		if (row.state === "live") continue;
		const move = row.state === "moved" ? ` → :${row.newLine}` : "";
		console.log(
			`  [${row.state}] ${row.finding.id} ${row.finding.file}:${row.finding.line}${move} — ${row.finding.message.slice(0, 80)}`,
		);
	}
	if (c.drifted > 0) {
		console.log(
			"Drifted findings need re-review (content changed at the anchor) — they are NOT auto-closed.",
		);
	}
}

function acknowledgeFinding(findingId: string, opts: { reason: string; by: string }): void {
	appendReconciliationTxn(process.cwd(), {
		finding_id: findingId,
		action: "acked",
		by: opts.by,
		reason: opts.reason,
		ts: new Date().toISOString(),
	});
	console.log(`Acked ${findingId}: ${opts.reason}`);
}

export function registerFindingsCommands(program: Command): void {
	const findings = program
		.command("findings")
		.description("Ingest external review findings and drive them to closure");

	findings
		.command("ingest <report>")
		.description("Parse a numbered-findings review report into the corpus")
		.option("--reviewer <name>", "reviewer attribution", "external-review")
		.action(printIngestSummary);

	findings
		.command("status")
		.description("Reconciliation state of ingested review findings")
		.option("--all", "include touched/acked findings in the listing")
		.action(printFindingStatus);

	findings
		.command("verify")
		.description("Re-verify finding anchors against the working tree (live/moved/drifted/gone)")
		.option("--write", "re-anchor moved findings (new corpus row + reanchored txn)")
		.action(printAnchorVerification);

	findings
		.command("ack <findingId>")
		.description("Acknowledge a finding as deliberately not addressed")
		.requiredOption("--reason <text>", "why this finding is not being addressed")
		.option("--by <name>", "who is acking", process.env.USER ?? "unknown")
		.action(acknowledgeFinding);
}
