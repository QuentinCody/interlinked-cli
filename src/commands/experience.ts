// ===========================================
// `interlinked experience` — agent-readable trajectory export + analysis
// ===========================================
// The consumption-side surface over the session logs (design:
// docs/design/reproducibility/trace-consumption.md): `export` projects a
// session into trajectory-v1 (Letta interop) or trajectory-ix.v1 (annotated),
// `analyze` prints deterministic session metrics, `list` shows which sessions
// the timeline holds. Bounded scans only; distinct from `interlinked
// trajectory` (live detector-state inspection).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { c } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { analyzeExperience, type ExperienceAnalysis } from "./experience/analyze.js";
import { buildExperience } from "./experience/build.js";
import type { ExperienceFormat } from "./experience/types.js";
import { scanJsonlTail, type TailScanBudget } from "./query/reverse-reader.js";

const LIST_BUDGET: TailScanBudget = { maxRecords: 50_000, maxBytes: 64 * 1024 * 1024 };

// --- export ---

interface ExperienceExportOptions {
	session: string;
	format?: string;
	out?: string;
	truncate?: string;
	cwd?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

function parseFormat(raw: string | undefined): ExperienceFormat | null {
	if (raw === undefined || raw === "ix") return "ix";
	if (raw === "letta") return "letta";
	return null;
}

/** NaN-safe --truncate parse: undefined → default (null return means invalid). */
function parseTruncate(raw: string | undefined): number | undefined | null {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** Consumed by src/registrars/experience.ts (`interlinked experience export`). */
export function experienceExportAction(opts: ExperienceExportOptions): number {
	const mode = getOutputMode(opts);
	const cwd = opts.cwd ?? process.cwd();
	const format = parseFormat(opts.format);
	if (format === null) {
		outputError(mode, `Unknown format "${opts.format}" — use "ix" or "letta".`);
		return 1;
	}
	const truncateChars = parseTruncate(opts.truncate);
	if (truncateChars === null) {
		outputError(mode, `--truncate must be a non-negative number, got "${opts.truncate}".`);
		return 1;
	}

	const built = buildExperience({
		dir: cwd,
		sessionId: opts.session,
		format,
		...(truncateChars !== undefined ? { truncateChars } : {}),
	});
	if (built.records.length === 0) {
		outputError(mode, `No timeline records found for session "${opts.session}".`, {
			scan_truncated: built.diagnostics.scan_truncated,
		});
		return 1;
	}

	const outPath =
		opts.out ?? join(cwd, ".interlinked", "trajectories", `${opts.session}.${format}.jsonl`);
	mkdirSync(join(outPath, ".."), { recursive: true });
	writeFileSync(outPath, `${built.records.map((r) => JSON.stringify(r)).join("\n")}\n`);

	const data = { out: outPath, format, records: built.records.length, ...built.diagnostics };
	output(mode, data, {
		normal: () =>
			[
				c.bold(`Exported ${built.records.length} records (${format}) for ${opts.session}`),
				`  out                 ${outPath}`,
				`  collection joined   ${built.diagnostics.collection_joined}`,
				`  guard joined        ${built.diagnostics.guard_joined}`,
				`  truncated records   ${built.diagnostics.truncated_records}`,
				built.diagnostics.scan_truncated
					? c.yellow("  scan hit its budget — oldest records may be missing (raise with --json tooling)")
					: `  scan complete`,
			].join("\n"),
	});
	return 0;
}

// --- analyze ---

interface ExperienceAnalyzeOptions {
	session: string;
	cwd?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

function renderAnalysis(a: ExperienceAnalysis): string {
	const classes = Object.entries(a.tools.by_class)
		.map(([k, v]) => `${k}=${v}`)
		.join(" ");
	const rules = a.guard.top_rules.slice(0, 3).map(([rule, n]) => `${rule}×${n}`);
	return [
		c.bold(`Experience metrics`),
		`  records            ${a.records}  episodes=${a.episodes}  span_ms=${a.span_ms ?? "-"}`,
		`  roles              ${Object.entries(a.by_role)
			.map(([k, v]) => `${k}=${v}`)
			.join(" ")}`,
		`  tool calls         ${a.tools.calls}  errors=${a.tools.errors}  verification_runs=${a.tools.verification_runs}`,
		`  tool classes       ${classes || "-"}`,
		`  files              edits=${a.files.edit_events} distinct=${a.files.edited} reworked=${a.files.reworked}`,
		`  guard              blocks=${a.guard.blocks} warns=${a.guard.warns}${rules.length > 0 ? `  top: ${rules.join(", ")}` : ""}`,
		`  verify:edit        ${a.ratios.verify_to_edit ?? "-"}`,
		`  think:message      ${a.ratios.think_to_message_chars?.toFixed(2) ?? "-"}`,
	].join("\n");
}

/** Consumed by src/registrars/experience.ts (`interlinked experience analyze`). */
export function experienceAnalyzeAction(opts: ExperienceAnalyzeOptions): number {
	const mode = getOutputMode(opts);
	const cwd = opts.cwd ?? process.cwd();
	const built = buildExperience({ dir: cwd, sessionId: opts.session, format: "ix" });
	if (built.records.length === 0) {
		outputError(mode, `No timeline records found for session "${opts.session}".`);
		return 1;
	}
	const analysis = analyzeExperience(built.records);
	output(mode, analysis, { normal: () => renderAnalysis(analysis) });
	return 0;
}

// --- list ---

interface ExperienceListOptions {
	cwd?: string;
	limit?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

interface SessionSummary {
	session: string;
	records: number;
	provider: string | null;
	first_ts: string;
	last_ts: string;
}

/** Group the timeline tail by session. Pure over the bounded scan. */
export function listExperienceSessions(
	dir: string,
	budget: TailScanBudget = LIST_BUDGET,
): { sessions: SessionSummary[]; scan_truncated: boolean } {
	const bySession = new Map<string, SessionSummary>();
	const stats = scanJsonlTail(join(dir, ".interlinked", "timeline.jsonl"), budget, (rec) => {
		if (rec.schema !== "timeline.v1" || typeof rec.session !== "string") return true;
		if (typeof rec.ts !== "string") return true;
		const existing = bySession.get(rec.session);
		if (existing === undefined) {
			bySession.set(rec.session, {
				session: rec.session,
				records: 1,
				provider: typeof rec.provider === "string" ? rec.provider : null,
				first_ts: rec.ts,
				last_ts: rec.ts,
			});
			return true;
		}
		existing.records++;
		// Newest-first scan: later-delivered records are older.
		existing.first_ts = rec.ts;
		return true;
	});
	const sessions = [...bySession.values()].sort((a, b) =>
		a.last_ts < b.last_ts ? 1 : a.last_ts > b.last_ts ? -1 : 0,
	);
	return { sessions, scan_truncated: stats.truncated };
}

/** Consumed by src/registrars/experience.ts (`interlinked experience list`). */
export function experienceListAction(opts: ExperienceListOptions): number {
	const mode = getOutputMode(opts);
	const cwd = opts.cwd ?? process.cwd();
	const limitRaw = opts.limit === undefined ? 10 : Number(opts.limit);
	const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 10;
	const { sessions, scan_truncated } = listExperienceSessions(cwd);
	const shown = sessions.slice(0, limit);
	output(mode, { sessions: shown, scan_truncated }, {
		normal: () =>
			[
				c.bold(`Sessions in the timeline tail (${shown.length}/${sessions.length})`),
				...shown.map(
					(s) =>
						`  ${s.session}  ${String(s.records).padStart(5)} records  ${s.provider ?? "?"}  ${s.first_ts} → ${s.last_ts}`,
				),
				scan_truncated ? c.dim("  (bounded scan — older sessions may be missing)") : "",
			]
				.filter((line) => line !== "")
				.join("\n"),
	});
	return 0;
}
