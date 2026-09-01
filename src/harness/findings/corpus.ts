// ===========================================
// Findings — corpus store (the "ever-increasing list")
// ===========================================
// Offline-first JSONL store of review findings, distilled later into
// deterministic harness detectors. Mirrors recurrence.ts conventions:
// append-only, fail-open, torn-line-tolerant. Two scopes:
//   .interlinked/findings/corpus.jsonl   — per-repo, COMMITTED, system of record
//   ~/.interlinked/findings-corpus.jsonl — cross-repo DERIVED cache (rebuildable)
//
// Determinism: nothing here runs on the daemon hook path or calls an LLM. The
// corpus is authoring-time data; the runtime only ever sees compiled rules.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative } from "node:path";
import { interlinkedPath } from "../../lib/interlinked-path.js";
import { parseFinding } from "./parse-finding.js";
import type { FindingExtensions } from "./simplification-extension.js";
import {
	computeCompleteness,
	computeDedupKey,
	computeProvenanceId,
	normalizeFindingPath,
	type ProvenanceCompleteness,
	type ProvenanceTier,
} from "./provenance.js";

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "unknown";
export type FindingCategory = "security" | "performance" | "quality";
export type FindingStatus = "candidate" | "approved" | "distilled" | "superseded";
export type FindingActionability =
	| "bug"
	| "nit"
	| "question"
	| "praise"
	| "suggestion"
	| "out_of_scope";

/** One sighting of a bug — a single review comment / vuln block / paste. A
 *  Finding folds many of these (the cross-repo, multi-reviewer case). */
export interface FindingProvenance {
	provenance_id: string;
	provenance_completeness: ProvenanceCompleteness;
	source_runner: string;
	repo?: string | undefined;
	commit_sha?: string | undefined;
	file?: string | undefined;
	lines?: [number, number] | undefined;
	url?: string | undefined;
	quote?: string | undefined;
	comment_author?: string | undefined;
	created_at?: string | undefined;
	actionability?: FindingActionability | undefined;
	is_outdated?: boolean | undefined;
	is_resolved?: boolean | undefined;
	enriched_fields?: string[] | undefined;
	originating_signature?: string | undefined;
	raw_sha256?: string | undefined;
}

export interface FindingDistilled {
	detector_id: string;
	kind: "guard_rule" | "inline_check";
	cold_path_wired?: boolean | undefined;
}

export interface Finding {
	id: string;
	bug_class: string;
	aliases: string[];
	check: string | null;
	file: string;
	line: number;
	message: string;
	severity: FindingSeverity;
	category?: FindingCategory | undefined;
	fix_instruction?: string | undefined;
	provenance: FindingProvenance[];
	provenance_tier: ProvenanceTier;
	dedup_key: string;
	times_observed: number;
	source_runners: string[];
	status: FindingStatus;
	approved_by?: string | undefined;
	first_seen: string;
	last_seen: string;
	distilled?: FindingDistilled | undefined;
	/** Lens-specific evidence. The common corpus still owns identity, anchors,
	 * status, and reconciliation; extensions must not create a parallel
	 * lifecycle. Unknown sibling keys are preserved by the JSON parser. */
	extensions?: FindingExtensions | undefined;
	/** LG-6 content anchor (anchor-liveness.ts): sha256 of the trailing-ws-
	 *  normalized context window around `line`, captured from the live tree at
	 *  ingest. Absent on legacy/unanchored rows — consumers fail open. */
	anchor_span_sha256?: string | undefined;
	/** The context window's verbatim lines (anchor line ± radius, clamped). */
	anchor_context?: string[] | undefined;
	/** Tree stamp at capture: `<sha>` or `<sha>+dirty`; absent outside git. */
	anchor_tree?: string | undefined;
}

const FINDINGS_SUBDIR = "findings";
const CORPUS_FILE = "corpus.jsonl";
const GLOBAL_CORPUS_FILE = "findings-corpus.jsonl";
const ID_KEY_LENGTH = 12;

export function findingsCorpusPath(cwd: string): string {
	return interlinkedPath(cwd, FINDINGS_SUBDIR, CORPUS_FILE);
}

/** Cross-repo cache. `INTERLINKED_HOME` overrides the home base (test isolation;
 *  keeps the real `~/.interlinked` untouched). */
export function globalCorpusPath(): string {
	const base = process.env.INTERLINKED_HOME ?? homedir();
	return interlinkedPath(base, GLOBAL_CORPUS_FILE);
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function toRepoRelative(file: string, cwd: string): string {
	return normalizeFindingPath(isAbsolute(file) ? relative(cwd, file) : file);
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
	unknown: 0,
	low: 1,
	medium: 2,
	high: 3,
	critical: 4,
};

/** Conservative merge: never RAISE severity on auto-merge — take the lower
 *  rank until a human confirms two sightings are the same class. */
function lessStrictSeverity(a: FindingSeverity, b: FindingSeverity): FindingSeverity {
	return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

const COMPLETENESS_RANK: Record<ProvenanceCompleteness, number> = {
	unanchored: 0,
	anchored_file: 1,
	anchored_line: 2,
	anchored_sha: 3,
};

export interface MakeFindingInput {
	bug_class: string;
	message: string;
	file?: string | undefined;
	line?: number | undefined;
	severity?: FindingSeverity | undefined;
	category?: FindingCategory | undefined;
	fix_instruction?: string | undefined;
	aliases?: string[] | undefined;
	// provenance descriptor for this single sighting:
	source_runner: string;
	repo?: string | undefined;
	commit_sha?: string | undefined;
	lines?: [number, number] | undefined;
	url?: string | undefined;
	quote?: string | undefined;
	comment_author?: string | undefined;
	created_at?: string | undefined;
	actionability?: FindingActionability | undefined;
	raw_sha256?: string | undefined;
	/** Injectable clock for deterministic tests. */
	now?: string | undefined;
}

/** Build a candidate Finding (one provenance entry) with all derived keys.
 *  Same structural site → same id, so re-harvest / a second reviewer folds in. */
export function makeFinding(input: MakeFindingInput, cwd: string): Finding {
	const normFile = input.file ? toRepoRelative(input.file, cwd) : "";
	const line = input.line ?? input.lines?.[0] ?? 0;
	const { tier, key } = computeDedupKey({
		repo: input.repo,
		file: normFile || undefined,
		line,
	});
	const provenance_id = computeProvenanceId({
		source_runner: input.source_runner,
		repo: input.repo,
		commit_sha: input.commit_sha,
		file: normFile || undefined,
		lines: input.lines,
		raw_sha256: input.raw_sha256,
	});
	const completeness = computeCompleteness({
		file: normFile || undefined,
		line,
		lines: input.lines,
		commit_sha: input.commit_sha,
	});
	const ts = input.now ?? new Date().toISOString();
	const id = `${slug(input.bug_class)}-${key ? key.slice(0, ID_KEY_LENGTH) : provenance_id}`;

	const provenance: FindingProvenance = {
		provenance_id,
		provenance_completeness: completeness,
		source_runner: input.source_runner,
		repo: input.repo,
		commit_sha: input.commit_sha,
		file: normFile || undefined,
		lines: input.lines,
		url: input.url,
		quote: input.quote,
		comment_author: input.comment_author,
		created_at: input.created_at,
		actionability: input.actionability,
		raw_sha256: input.raw_sha256,
	};

	return {
		id,
		bug_class: input.bug_class,
		aliases: input.aliases ?? [],
		check: null,
		file: normFile,
		line,
		message: input.message,
		severity: input.severity ?? "unknown",
		category: input.category,
		fix_instruction: input.fix_instruction,
		provenance: [provenance],
		provenance_tier: tier,
		dedup_key: key,
		times_observed: 1,
		source_runners: [input.source_runner],
		status: "candidate",
		first_seen: ts,
		last_seen: ts,
	};
}

export interface RecordOpts {
	/** Mirror to the global cross-repo cache. Default true; tests pass false. */
	mirrorGlobal?: boolean | undefined;
}

/** Append a Finding to the per-repo corpus (system of record) and best-effort
 *  mirror to the global cache. The local write can throw (caller decides); the
 *  global mirror never throws (it's a derived cache). */
export function recordFinding(finding: Finding, cwd: string, opts: RecordOpts = {}): void {
	const path = findingsCorpusPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(finding)}\n`, "utf-8");
	if (opts.mirrorGlobal !== false) {
		try {
			const gpath = globalCorpusPath();
			mkdirSync(dirname(gpath), { recursive: true });
			appendFileSync(gpath, `${JSON.stringify(finding)}\n`, "utf-8");
		} catch (e) {
			void e; // derived cache — never block on a mirror failure
		}
	}
}

export interface LoadOpts {
	scope?: "local" | "global" | "both" | undefined;
}

/** Materialize the corpus: last-write-wins per id. Reads the system-of-record
 *  (local) LAST so it wins over the derived global cache. Torn lines skipped. */
export function loadFindings(cwd: string, opts: LoadOpts = {}): Finding[] {
	const scope = opts.scope ?? "local";
	const paths: string[] = [];
	if (scope === "global" || scope === "both") paths.push(globalCorpusPath());
	if (scope === "local" || scope === "both") paths.push(findingsCorpusPath(cwd));

	const byId = new Map<string, Finding>();
	for (const path of paths) {
		if (!existsSync(path)) continue;
		for (const rawLine of readFileSync(path, "utf-8").split("\n")) {
			if (!rawLine.trim()) continue;
			try {
				const finding = parseFinding(JSON.parse(rawLine));
				if (finding) byId.set(finding.id, finding);
			} catch (e) {
				void e; // torn JSONL — skip, never throw (matches recurrence.ts)
			}
		}
	}
	return [...byId.values()];
}

export function getFinding(id: string, cwd: string, opts: LoadOpts = {}): Finding | null {
	return loadFindings(cwd, opts).find((f) => f.id === id) ?? null;
}

/** Anchor-field merge policy: existing wins (a verify --write re-anchor must
 *  not be clobbered by a re-ingest); a first capture fills legacy rows in. */
function carryAnchor(
	existing: Finding,
	incoming: Finding,
): Pick<Finding, "anchor_span_sha256" | "anchor_context" | "anchor_tree"> {
	return {
		anchor_span_sha256: existing.anchor_span_sha256 ?? incoming.anchor_span_sha256,
		anchor_context: existing.anchor_context ?? incoming.anchor_context,
		anchor_tree: existing.anchor_tree ?? incoming.anchor_tree,
	};
}

function mergeFindings(existing: Finding, incoming: Finding): Finding {
	const byProv = new Map<string, FindingProvenance>();
	for (const p of existing.provenance) byProv.set(p.provenance_id, p);
	for (const p of incoming.provenance) {
		if (!byProv.has(p.provenance_id)) byProv.set(p.provenance_id, p);
	}
	const provenance = [...byProv.values()];
	const first_seen =
		existing.first_seen < incoming.first_seen ? existing.first_seen : incoming.first_seen;
	const last_seen = existing.last_seen > incoming.last_seen ? existing.last_seen : incoming.last_seen;
	return {
		...existing, // keep lifecycle fields (status / check / distilled / approved_by)
		aliases: [...new Set([...existing.aliases, ...incoming.aliases])],
		severity: lessStrictSeverity(existing.severity, incoming.severity),
		provenance,
		times_observed: provenance.length,
		source_runners: [...new Set(provenance.map((p) => p.source_runner))].sort(),
		first_seen,
		last_seen,
		...mergeExtensions(existing, incoming),
		...carryAnchor(existing, incoming),
	};
}

function mergeExtensions(
	existing: Finding,
	incoming: Finding,
): Pick<Finding, "extensions"> | Record<never, never> {
	if (!existing.extensions && !incoming.extensions) return {};
	return { extensions: { ...existing.extensions, ...incoming.extensions } };
}

/** Idempotent upsert: fold `incoming` into an existing row with the same id
 *  (same structural site), else append. Append-only storage + last-write-wins
 *  on read means we just append the merged row. */
export function upsertFinding(incoming: Finding, cwd: string, opts: RecordOpts = {}): Finding {
	const existing = loadFindings(cwd).find((f) => f.id === incoming.id);
	const merged = existing ? mergeFindings(existing, incoming) : incoming;
	recordFinding(merged, cwd, opts);
	return merged;
}

export interface BugClassRow {
	bug_class: string;
	finding_count: number; // distinct Finding rows (sites) in this class
	times_observed: number; // total distinct sightings across the class
	source_runners: string[];
	weakest_completeness: ProvenanceCompleteness;
	status_counts: Record<string, number>;
	sample_files: string[];
}

/** Cross-repo grouping: fold materialized Findings by canonical bug_class. This
 *  is where "3 reviewers / 2 repos → 1 class" actually happens. */
export function foldByBugClass(findings: readonly Finding[]): BugClassRow[] {
	const rows = new Map<
		string,
		{
			finding_count: number;
			times_observed: number;
			runners: Set<string>;
			weakest: ProvenanceCompleteness;
			status_counts: Record<string, number>;
			files: Set<string>;
		}
	>();
	for (const f of findings) {
		const row =
			rows.get(f.bug_class) ??
			{
				finding_count: 0,
				times_observed: 0,
				runners: new Set<string>(),
				weakest: "anchored_sha" as ProvenanceCompleteness,
				status_counts: {},
				files: new Set<string>(),
			};
		row.finding_count++;
		row.times_observed += f.times_observed;
		for (const r of f.source_runners) row.runners.add(r);
		for (const p of f.provenance) {
			if (COMPLETENESS_RANK[p.provenance_completeness] < COMPLETENESS_RANK[row.weakest]) {
				row.weakest = p.provenance_completeness;
			}
		}
		row.status_counts[f.status] = (row.status_counts[f.status] ?? 0) + 1;
		if (f.file) row.files.add(f.file);
		rows.set(f.bug_class, row);
	}
	return [...rows.entries()]
		.map(([bug_class, r]): BugClassRow => ({
			bug_class,
			finding_count: r.finding_count,
			times_observed: r.times_observed,
			source_runners: [...r.runners].sort(),
			weakest_completeness: r.weakest,
			status_counts: r.status_counts,
			sample_files: [...r.files].slice(0, 5),
		}))
		.sort((a, b) => b.times_observed - a.times_observed || a.bug_class.localeCompare(b.bug_class));
}

// `isFinding` was replaced by `parseFinding` (./parse-finding.ts) on 2026-08-09:
// the predicate asserted the whole `Finding` interface while checking four of
// its sixteen required fields. See that module's header for the full list.
