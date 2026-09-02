#!/usr/bin/env node
// =====================================================================
// Receipts audit — verify the landing page's "blocks" table against
// the full local activity-log history + Claude Code session transcripts.
// =====================================================================
//
// Why this exists: every row in landing/public/index.html's receipt
// table is a count drawn from the local guard_block history. The raw
// counts are real, but two classes of inflation/noise had to be
// removed before the numbers are honest:
//
//   1. Substring-FP rules — the older substring-matching rules fired
//      on commit-message bodies, echo arguments, and grep patterns.
//      Every event for those rules is resolved to the agent's actual
//      tool_input via the session transcript at
//      ~/.claude/projects/-Users-quentincody-interlinked-cli/<session>.jsonl
//      and classified real / fp_in_text / needs_review.
//   2. Duplicate hook registrations — until 2026-05-18 the hook
//      installer could register the same hook 3-4x, so one blocked
//      tool call produced 3-4 identical guard_block events. Identical
//      (session, tool, summary) events within DEDUP_WINDOW_MS collapse
//      to one. The collapsed count is reported in the output.
//
// Additionally, grep-accelerator "block-and-answer" events (the index
// answering a grep query via a block decision; identified by the
// guard_grep_stats field) are excluded entirely — they are
// accelerations, not enforcement.
//
// The activity log has rotated several times since dogfooding started
// (plus a v5 schema migration on 2026-05-29), so the audit unions all
// known local segments, oldest first (see SOURCES).
//
// Output: writes landing/receipts.json with confirmed-real counts +
// per-row verdicts. The HTML's receipts table is hand-edited to match
// (gen-markers around the headline numbers); scripts/check-docs.mjs
// validates the HTML agrees with this JSON.
//
// Limitations:
//   - The activity segments are gitignored local data. CI cannot run
//     this script. It runs locally before launch and the resulting
//     receipts.json gets committed.
//   - guard_block records stop on 2026-06-01 (an event-writer
//     regression in the v5 pipeline; tool_use events continue). The
//     audit window therefore ends there until the writer is fixed.
//   - Some sessions' transcripts have rolled out of the local
//     ~/.claude/projects/ retention window. Those events become
//     "transcript_missing" — counted as unverified, not real.
//
// Usage:
//   npm run docs:audit-receipts            # writes landing/receipts.json
//   node scripts/audit-receipts.mjs --json # prints to stdout instead

import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { classify } from "./audit-receipts-classify.mjs";
import { incompleteHistoryError } from "./receipts-completeness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TRANSCRIPT_DIR = join(homedir(), ".claude/projects/-Users-quentincody-interlinked-cli");
const OUT_PATH = join(ROOT, "landing/receipts.json");

// Activity-log segments, oldest first. The .archive files are pre-v5
// rotations; archive/activity-0001.jsonl.gz is the 2026-05-29 v5
// migration segment; activity.jsonl is current. All use
// type:"guard_block" for block events regardless of schema_version.
const SOURCES = [
	".interlinked/activity.jsonl.2026-05-14T19-51-41-310Z.archive",
	".interlinked/activity.jsonl.2026-05-14T21-31-19-843Z.archive",
	".interlinked/archive/activity-0001.jsonl.gz",
	".interlinked/activity.jsonl",
];

// Collapse identical (session, tool, summary) events closer together
// than this. Over-registration duplicates arrive within ~1-2s; real
// agent retries of the same blocked action arrive after a model turn.
const DEDUP_WINDOW_MS = 5000;

// Rows shown on the landing page. Every rule here is content-derived /
// deterministic (compiler gates, structural checks, path confinement,
// resolved-PID checks) — no substring-FP problem, so the deduped raw
// count is the verified count. `rule_ids` supports families that are
// one story split across several rule ids (process kills, destructive
// git). `key` is what check-docs.mjs row markers look up.
const KEEP_ROWS = [
	{
		key: "tsc-diff-overlay",
		rule_ids: ["tsc-diff-overlay"],
		severity: "high",
		label: "Edits that introduced a new TypeScript error — blocked before the write landed",
	},
	{
		key: "tdd_new_file_gate",
		rule_ids: ["tdd_new_file_gate"],
		severity: "high",
		label: "New source file with no companion test",
	},
	{
		key: "bash-code-file-write-bypass",
		rule_ids: ["bash-code-file-write-bypass"],
		severity: "high",
		label: "Shell-redirect bypass attempts (cat > file.ts to dodge content-quality gate)",
	},
	{
		key: "builtin-repo-confinement",
		rule_ids: ["builtin-repo-confinement"],
		severity: "critical",
		label: "Writes outside the repo root",
	},
	{
		key: "empty_catch",
		rule_ids: ["empty_catch"],
		severity: "high",
		label: "Empty catch{} blocks",
	},
	{
		key: "process-kill",
		rule_ids: [
			"self-kill-protection",
			"builtin-kill-signal",
			"builtin-kill-multi-pid",
			"builtin-pkill-f",
			"builtin-killall",
			"builtin-kill-substitution",
			"builtin-pgrep-xargs-kill",
			"builtin-pkill-node",
		],
		severity: "critical",
		label: "kill / pkill / killall at running processes — four aimed at the harness or session itself",
	},
	{
		key: "reservation-conflict",
		rule_ids: ["reservation-conflict"],
		severity: "high",
		label: "Edits to files another agent held the reservation on",
	},
	{
		key: "git-destructive",
		rule_ids: ["builtin-git-reset-hard", "builtin-git-branch-D", "builtin-git-stash-destroy"],
		severity: "high",
		label: "Destructive git (reset --hard, branch -D, stash drop)",
	},
	{
		key: "secrets_in_source",
		rule_ids: ["secrets_in_source"],
		severity: "critical",
		label: "Secrets detected in proposed write content",
	},
	{
		key: "supply-chain",
		rule_ids: ["supply-chain-unapproved-package"],
		severity: "critical",
		label: "Package installs not on the team allowlist (fail-closed)",
	},
];

// Rule IDs that the audit found to be FP-heavy. Counts are still
// reported in the residual but are not treated as real attempts.
const FP_HEAVY_RULES = new Set([
	"builtin-shutdown-reboot",
	"builtin-rm-rf-root",
	"builtin-drop-database",
	"builtin-kubectl-delete-all",
	"builtin-chmod-777",
	"builtin-nohup-network",
	"pretooluse-injection-scan",
]);

const TOOL_USE_TOOLS = new Set(["Bash", "Edit", "Write", "MultiEdit", "apply_patch"]);
const TRANSCRIPT_LOOKBACK_SECONDS = 60;

function parseTs(s) {
	return Date.parse(s);
}

// Some v5-era records (check-engine path, reservation conflicts,
// stale-edit fast-fails) don't carry guard_rule_id. Resolve a rule id
// from the summary prefix; anything unrecognized stays _unknown and
// lands in the residual.
function resolveRuleId(e) {
	if (e.guard_rule_id) return e.guard_rule_id;
	const s = e.summary || "";
	if (s.startsWith("[interlinked:typescript]") || s.startsWith("[interlinked:tsgo]")) {
		return "tsc-diff-overlay";
	}
	if (s.startsWith("[interlinked:secrets_in_source]")) return "secrets_in_source";
	if (s.startsWith("File reserved by")) return "reservation-conflict";
	if (s.startsWith("Edit will fail")) return "stale-edit-fast-fail";
	return "_unknown";
}

function parseActivityBlockLine(line) {
	if (!line || !line.includes("guard_block")) return null;
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return null;
	}
	return event?.type === "guard_block" ? event : null;
}

/** Stream one plain or gzip activity segment. The returned array contains only
 * guard blocks, so memory scales with audit evidence rather than ledger bytes. */
export async function readActivityBlockSource(path) {
	const file = createReadStream(path);
	const input = path.endsWith(".gz") ? file.pipe(createGunzip()) : file;
	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	const events = [];
	let grepAccelAnswers = 0;
	for await (const line of lines) {
		const event = parseActivityBlockLine(line);
		if (!event) continue;
		// Grep-accelerator block-and-answer: the index answering a grep
		// query, not an enforcement decision. Excluded from all counts.
		if ("guard_grep_stats" in event) {
			grepAccelAnswers++;
			continue;
		}
		events.push(event);
	}
	return { events, grepAccelAnswers };
}

async function loadActivityBlocks() {
	const events = [];
	const sourceStats = [];
	let grepAccelAnswers = 0;
	let sawAny = false;
	for (const rel of SOURCES) {
		const path = join(ROOT, rel);
		if (!existsSync(path)) {
			process.stderr.write(`[audit] segment missing, skipped: ${rel}\n`);
			sourceStats.push({ file: rel.split("/").pop(), blocks: 0, missing: true });
			continue;
		}
		sawAny = true;
		const source = await readActivityBlockSource(path);
		for (const event of source.events) events.push(event);
		grepAccelAnswers += source.grepAccelAnswers;
		sourceStats.push({ file: rel.split("/").pop(), blocks: source.events.length });
	}
	if (!sawAny) {
		throw new Error(
			"no activity segments found — audit can only run locally where the activity log exists",
		);
	}
	return { events, sourceStats, grepAccelAnswers };
}

// Collapse over-registration duplicates: identical (session, tool,
// summary) within DEDUP_WINDOW_MS of the last kept occurrence.
function dedupe(events) {
	const sorted = [...events].sort((a, b) => parseTs(a.ts || 0) - parseTs(b.ts || 0));
	const lastKept = new Map();
	const kept = [];
	let collapsed = 0;
	for (const e of sorted) {
		const key = `${e.session || ""}|${e.tool || ""}|${e.summary || ""}`;
		const ts = parseTs(e.ts || 0);
		const prev = lastKept.get(key);
		if (prev !== undefined && ts - prev <= DEDUP_WINDOW_MS) {
			collapsed++;
			continue;
		}
		lastKept.set(key, ts);
		kept.push(e);
	}
	return { kept, collapsed };
}

function loadTranscript(sessionId) {
	const path = join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
	if (!existsSync(path)) return null;
	const entries = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// best-effort: skip malformed JSONL lines, keep the rest
		}
	}
	return entries;
}

const transcriptCache = new Map();
function getTranscript(sessionId) {
	if (transcriptCache.has(sessionId)) return transcriptCache.get(sessionId);
	const t = loadTranscript(sessionId);
	transcriptCache.set(sessionId, t);
	return t;
}

function findCommandForBlock(sessionId, blockTsMs) {
	const transcript = getTranscript(sessionId);
	if (!transcript) return null;
	let best = null;
	let bestDt = Number.POSITIVE_INFINITY;
	for (const rec of transcript) {
		if (rec?.type !== "assistant") continue;
		const ts = parseTs(rec.timestamp || "");
		if (Number.isNaN(ts)) continue;
		const content = rec.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type !== "tool_use") continue;
			if (!TOOL_USE_TOOLS.has(block.name)) continue;
			const cmd = block.input?.command || block.input?.file_path || "";
			if (!cmd) continue;
			const dt = blockTsMs - ts;
			if (dt >= 0 && dt < TRANSCRIPT_LOOKBACK_SECONDS * 1000 && dt < bestDt) {
				best = { command: String(cmd), tool: block.name, ts: rec.timestamp };
				bestDt = dt;
			}
		}
	}
	return best;
}

function auditWindow(blocks) {
	let windowStart = null;
	let windowEnd = null;
	for (const b of blocks) {
		if (!b.ts) continue;
		if (!windowStart || b.ts < windowStart) windowStart = b.ts;
		if (!windowEnd || b.ts > windowEnd) windowEnd = b.ts;
	}
	// Floor, not round — the receipts page underclaims by policy.
	const windowDays =
		windowStart && windowEnd
			? Math.floor((parseTs(windowEnd) - parseTs(windowStart)) / 86_400_000)
			: 0;
	return { windowStart, windowEnd, windowDays };
}

function blocksByRule(blocks) {
	const byRule = new Map();
	for (const b of blocks) {
		const id = resolveRuleId(b);
		if (!byRule.has(id)) byRule.set(id, []);
		byRule.get(id).push(b);
	}
	return byRule;
}

function buildVerifiedRows(byRule) {
	const verifiedRows = [];
	for (const row of KEEP_ROWS) {
		// For "keep" rows we trust the rule fired correctly; the verified
		// count is the deduped raw count. (Rows were chosen because they're
		// content-quality / TDD / structural / resolved-state checks —
		// these rules don't have the substring-FP problem.)
		const count = row.rule_ids.reduce((s, id) => s + (byRule.get(id) || []).length, 0);
		verifiedRows.push({
			rule_id: row.key,
			rule_ids: row.rule_ids,
			label: row.label,
			severity: row.severity,
			count_logged: count,
			count_verified: count,
		});
	}
	return verifiedRows;
}

function buildDroppedRows(byRule) {
	const droppedRows = [];
	for (const ruleId of FP_HEAVY_RULES) {
		const events = byRule.get(ruleId) || [];
		const verdicts = {};
		const samples = [];
		for (const e of events) {
			const blockTs = parseTs(e.ts || "");
			const session = e.session || "";
			let verdict = "transcript_missing";
			let cmd = null;
			if (session && !Number.isNaN(blockTs)) {
				const resolved = findCommandForBlock(session, blockTs);
				if (resolved) {
					cmd = resolved.command;
					verdict = classify(ruleId, cmd);
				}
			}
			verdicts[verdict] = (verdicts[verdict] || 0) + 1;
			if (samples.length < 3 && cmd) {
				samples.push({ verdict, command: cmd.replace(/\s+/g, " ").slice(0, 120), ts: e.ts });
			}
		}
		droppedRows.push({
			rule_id: ruleId,
			count_logged: events.length,
			count_real: verdicts.real || 0,
			verdicts,
			samples,
		});
	}
	return droppedRows;
}

async function audit() {
	const { events: rawEvents, sourceStats, grepAccelAnswers } = await loadActivityBlocks();
	const { kept: blocks, collapsed } = dedupe(rawEvents);
	const { windowStart, windowEnd, windowDays } = auditWindow(blocks);
	const byRule = blocksByRule(blocks);
	const verifiedRows = buildVerifiedRows(byRule);
	const droppedRows = buildDroppedRows(byRule);

	const totalLogged = blocks.length;
	const totalVerified = verifiedRows.reduce((s, r) => s + r.count_verified, 0);
	const totalDropped = droppedRows.reduce((s, r) => s + r.count_logged, 0);
	const residual = totalLogged - totalVerified - totalDropped;

	return {
		audited_at: new Date().toISOString(),
		method:
			"Union of all local activity-log segments (two pre-v5 archives, the 2026-05-29 migration segment, current activity.jsonl). Grep-accelerator block-and-answer events excluded via guard_grep_stats. Identical (session, tool, summary) events within 5s collapsed to remove pre-2026-05-18 hook over-registration duplicates. FP-heavy rules resolved per-event against ~/.claude/projects/<cwd>/<session>.jsonl tool_use entries (nearest-before within 60s) and classified via command-text heuristic (see scripts/audit-receipts.mjs).",
		window_start: windowStart,
		window_end: windowEnd,
		window_days: windowDays,
		total_logged: totalLogged,
		total_verified: totalVerified,
		residual_unverified: residual,
		dedup_window_ms: DEDUP_WINDOW_MS,
		dedup_collapsed: collapsed,
		grep_accel_answers_excluded: grepAccelAnswers,
		sources: sourceStats,
		verified_rows: verifiedRows,
		dropped_rows: droppedRows,
	};
}

async function main() {
	const wantStdout = process.argv.includes("--json");
	const allowPartial = process.argv.includes("--allow-partial");
	const result = await audit();
	const payload = `${JSON.stringify(result, null, 2)}\n`;

	// Never overwrite the committed receipts from an incomplete history — a
	// missing segment understates the totals rather than updating them. See
	// receipts-completeness.mjs for the incident this guards against.
	if (!wantStdout && !allowPartial) {
		const err = incompleteHistoryError(result);
		if (err) {
			process.stderr.write(err);
			process.exit(1);
		}
	}

	if (wantStdout) {
		process.stdout.write(payload);
	} else {
		writeFileSync(OUT_PATH, payload);
		process.stdout.write(
			`wrote landing/receipts.json (${result.total_verified} verified / ${result.total_logged} logged, window ${result.window_start?.slice(0, 10)} → ${result.window_end?.slice(0, 10)}, ${result.dedup_collapsed} duplicates collapsed, ${result.grep_accel_answers_excluded} grep-accel answers excluded)\n`,
		);
	}
}

if (import.meta.main) await main();
