#!/usr/bin/env node
// backfill-guard.mjs — recover the guard DECISIONS that stopped being logged
// locally on 2026-06-01 (the .mjs → daemon port dropped appendGuardDecision;
// fixed forward in writeGuardDecisionRecord, but Jun 1–23 was never recorded).
//
// The agent SAW each block, so Claude Code's transcript preserves it: a
// PreToolUse denial lands as a `tool_result` with `is_error:true` whose content
// is the harness reason ("BLOCKED: …"), carrying the blocked call's
// `tool_use_id`. We reconstruct a `guard_block` row per denial, joined by
// `tool_use_id` to the existing `tool_use_start` (for tool/session/keys).
//
// Lossy by nature: the verbatim reason is recovered; structured `guard_rule_id`
// is best-effort parsed from the reason; `guard_severity` is not recoverable.
// Rows carry `source:"backfill-guard"` so they stay distinct from live capture.
// Denials whose tool_use_id already has a guard_block row (the pre-Jun-1 live
// records) are skipped — no double-count. Append + re-sort by ts, with a backup.
//
// Usage:  node scripts/backfill-guard.mjs [--dry-run]

import { copyFileSync, createReadStream, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const DRY_RUN = process.argv.includes("--dry-run");
const cwd = process.cwd();
const slug = cwd.replace(/\//g, "-");
const transcriptDir = join(homedir(), ".claude", "projects", slug);
const activityPath = join(cwd, ".interlinked", "activity.jsonl");

if (!existsSync(transcriptDir) || !existsSync(activityPath)) {
	console.error("[guard-backfill] missing transcript dir or activity.jsonl");
	process.exit(1);
}

function isTrackedSourceFileReason(r) {
	return r.includes("tracked source file");
}
function isNewSourceFileReason(r) {
	return r.includes("new source file");
}
function isLineCapReason(r) {
	return r.includes("line") && (r.includes("grow") || r.includes("cap"));
}
function isComplexityReason(r) {
	return r.includes("cyclomatic") || r.includes("complex") || r.includes("function(s)");
}
function isCoverageReason(r) {
	return r.includes("coverage") || r.includes("uncovered");
}
function isGitResetHardReason(r) {
	return r.includes("reset --hard");
}
function isDestructiveRmReason(r) {
	return r.includes("recursive deletion") || r.includes("force-delete") || r.includes("rm -rf");
}
function isForcePushReason(r) {
	return r.includes("force") && r.includes("push");
}
function isBaselineReason(r) {
	return r.includes("baseline");
}
function isSecretsReason(r) {
	return r.includes("secret") || r.includes("redact");
}

/** Best-effort map a harness reason line to the rule that most likely produced
 *  it. Unmatched reasons keep a null rule_id (the verbatim reason is retained). */
function ruleIdFromReason(reason) {
	const r = reason.toLowerCase();
	if (isTrackedSourceFileReason(r)) return "content-quality-gate";
	if (isNewSourceFileReason(r)) return "tdd_gate";
	if (isLineCapReason(r)) return "large_files";
	if (isComplexityReason(r)) return "complexity";
	if (isCoverageReason(r)) return "per_edit_coverage";
	if (isGitResetHardReason(r)) return "destructive-git-reset";
	if (isDestructiveRmReason(r)) return "destructive-rm";
	if (isForcePushReason(r)) return "force-push";
	if (isBaselineReason(r)) return "baseline_integrity_gate";
	if (isSecretsReason(r)) return "secrets";
	return null;
}

// ---- pass 0: existing guard_block ids (skip) + tool_use_id → row context -----

const existingGuardIds = new Set();
const idContext = new Map(); // tool_use_id -> { tool, session, cwd, workspace_key, project_key }
let existingRows = 0;
const keys = { workspace_key: "main", project_key: "main" };
{
	const rl = createInterface({ input: createReadStream(activityPath), crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line.trim()) continue;
		existingRows++;
		let r;
		try {
			r = JSON.parse(line);
		} catch {
			continue;
		}
		if (r.workspace_key && r.project_key && r.source === undefined) {
			keys.workspace_key = r.workspace_key;
			keys.project_key = r.project_key;
		}
		if (r.type === "guard_block" && r.tool_use_id) existingGuardIds.add(r.tool_use_id);
		if (r.tool_use_id && !idContext.has(r.tool_use_id) && (r.type === "tool_use_start" || r.type === "tool_use")) {
			idContext.set(r.tool_use_id, {
				tool: r.tool ?? null,
				session: r.session ?? null,
				cwd: r.cwd ?? cwd,
				workspace_key: r.workspace_key ?? keys.workspace_key,
				project_key: r.project_key ?? keys.project_key,
			});
		}
	}
}

// ---- pass 1: harness denials from transcripts -------------------------------

const denials = new Map(); // tool_use_id -> { reason, ts }
{
	const files = readdirSync(transcriptDir).filter((f) => f.endsWith(".jsonl")).map((f) => join(transcriptDir, f));
	for (const f of files) {
		const rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity });
		for await (const line of rl) {
			if (!line.includes("BLOCKED:")) continue;
			let o;
			try {
				o = JSON.parse(line);
			} catch {
				continue;
			}
			const content = o.message?.content;
			if (!Array.isArray(content)) continue;
			for (const b of content) {
				if (b?.type !== "tool_result" || b.is_error !== true || !b.tool_use_id) continue;
				const txt = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x) => x?.text ?? "").join("") : "";
				const m = txt.match(/BLOCKED:[\s\S]{0,400}/);
				if (!m) continue;
				if (!denials.has(b.tool_use_id)) denials.set(b.tool_use_id, { reason: m[0].replace(/\s+/g, " ").trim().slice(0, 500), ts: o.timestamp ?? null });
			}
		}
	}
}

// ---- reconstruct guard_block rows -------------------------------------------

const newRows = [];
let skipped = 0;
for (const [id, d] of denials) {
	if (existingGuardIds.has(id)) {
		skipped++;
		continue;
	}
	const ctx = idContext.get(id) ?? { tool: null, session: null, cwd, workspace_key: keys.workspace_key, project_key: keys.project_key };
	newRows.push({
		schema_version: 5,
		ts: d.ts ?? new Date(0).toISOString(),
		agent: "claude",
		workspace_key: ctx.workspace_key,
		project_key: ctx.project_key,
		type: "guard_block",
		tool: ctx.tool,
		summary: d.reason.slice(0, 200),
		session: ctx.session,
		hook: "PreToolUse",
		cwd: ctx.cwd,
		tool_use_id: id,
		guard_decision: "block",
		guard_rule_id: ruleIdFromReason(d.reason),
		guard_severity: null,
		guard_reason: d.reason,
		source: "backfill-guard",
	});
}

const report = `denials found=${denials.size}  already-recorded(skipped)=${skipped}  new guard_block rows=${newRows.length}`;
if (DRY_RUN) {
	console.log(`[guard-backfill] DRY RUN — no files written.\n[guard-backfill] ${report}`);
	process.exit(0);
}
if (newRows.length === 0) {
	console.log(`[guard-backfill] nothing to add. ${report}`);
	process.exit(0);
}

// ---- append + re-sort by ts (with backup + row-count verify) -----------------

const backup = `${activityPath}.pre-guard.bak`;
copyFileSync(activityPath, backup);
const allLines = readFileSync(activityPath, "utf-8").split("\n").filter((l) => l.length > 0);
for (const r of newRows) allLines.push(JSON.stringify(r));
const tsRe = /"ts":"([^"]+)"/;
const keyed = allLines.map((l, i) => {
	const m = tsRe.exec(l);
	return { ts: m ? m[1] : "", i, l };
});
keyed.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.i - b.i));
const expected = existingRows + newRows.length;
if (keyed.length !== expected) {
	console.error(`[guard-backfill] ABORT: line count ${keyed.length} != expected ${expected}. activity.jsonl untouched (backup at ${backup}).`);
	process.exit(1);
}
const tmp = `${activityPath}.guard.tmp`;
writeFileSync(tmp, `${keyed.map((k) => k.l).join("\n")}\n`);
renameSync(tmp, activityPath);
console.log(`[guard-backfill] backup → ${backup}`);
console.log(`[guard-backfill] ${report}  (total rows ${existingRows} → ${expected})`);
