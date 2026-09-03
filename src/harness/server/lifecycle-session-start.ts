// ===========================================
// SessionStart side-effect helpers
// ===========================================
// Extracted from `handleSessionStart` in lifecycle-events.ts (cognitive
// complexity split, no behavior change) so the dispatcher stays a short
// straight-line body while each side-effect keeps its own testable home.

import {
	autoStripAllScopes,
	defaultStripAuditLogPath,
	describeReason as describeMalformedReason,
} from "../../lib/settings-validator.js";
import { resetProjectSetupWarningsCache } from "../evaluator/pre-tool.js";
import { refreshPriorityIfStale as refreshFilePriorityIfStale } from "../file-priority.js";
import { findRipgrep } from "../grep-accelerator.js";
import type { HarnessDecision } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

/** Recency-weighted check depth (Mythos Phase 4): refresh the per-file
 *  priority map from git log if the cache is stale. Cold files (>180 days
 *  unchanged) skip advisory checks at PostToolUse via `shouldRunAdvisoryChecks`. */
export function refreshFilePriorityOnSessionStart(
	ctx: ServerRuntime,
	log: ServerRuntime["log"],
): void {
	try {
		const refreshed = refreshFilePriorityIfStale(ctx.cwd);
		if (refreshed.size > 0) {
			ctx.filePriorityMap = refreshed;
			log(`File-priority map refreshed: ${refreshed.size} entries`);
		}
	} catch (err) {
		log(`File-priority refresh failed (non-fatal): ${err}`);
	}
}

/** Incremental index update on session start (catches git changes between
 *  sessions), plus a one-time warning if the index exists but ripgrep is
 *  missing (grep acceleration would otherwise silently do nothing). */
export function refreshTrigramIndexOnSessionStart(
	ctx: ServerRuntime,
	log: ServerRuntime["log"],
): void {
	if (!ctx.trigramIndex) return;
	try {
		const updated = ctx.trigramIndex.incrementalUpdate();
		if (updated > 0) {
			log(`Trigram index refreshed: ${updated} files updated`);
		}
	} catch (err) {
		log(`Trigram index refresh failed (non-fatal): ${err}`);
	}
	if (!findRipgrep()) {
		ctx.logAlways(
			"[interlinked] Trigram index loaded but ripgrep (rg) not found — grep acceleration disabled. Install: brew install ripgrep (macOS), apt install ripgrep (Linux), or cargo install ripgrep",
		);
	}
}

/** Auto-strip malformed permission rules from .claude/settings*.json (project
 *  + user scope), with an audit log so every removed entry is visible. The
 *  agent-write path is already blocked at PreToolUse (write-content-guards.ts),
 *  but Claude Code's "Always allow" UI writes settings.json internally without
 *  firing a tool hook — that path is invisible to PreToolUse, so SessionStart
 *  is the only surface where we can clean it. JSONL audit at
 *  .interlinked/permission-rule-strips.jsonl. Returns an "allow" decision
 *  carrying the strip warning (plus any pending heavy-report warnings) when a
 *  strip happened; `null` when there was nothing to strip or the strip failed. */
export function autoStripSessionStartPermissions(
	ctx: ServerRuntime,
	log: ServerRuntime["log"],
	heavyWarnings: string[],
): HarnessDecision | null {
	try {
		const auditPath = defaultStripAuditLogPath(ctx.cwd);
		const stripResult = autoStripAllScopes(ctx.cwd, auditPath);
		if (stripResult.totalStripped === 0) return null;
		// Invalidate the project-setup-warning cache so the next PreToolUse
		// re-reads settings.json and stops emitting `[interlinked:setup]`
		// for the entries just stripped. Without this, the daemon serves
		// stale warning text for the rest of its process lifetime even
		// though the file is now clean.
		resetProjectSetupWarningsCache();
		const previews = stripResult.entries.slice(0, 5).map((e) => {
			const file = e.file.replace(/^.+?(\.claude\/.+)$/, "$1");
			return `  - ${file} permissions.${e.bucket}[${e.index}] = ${JSON.stringify(e.rule)} (${describeMalformedReason(e.reason)})`;
		});
		const more =
			stripResult.entries.length > previews.length
				? `\n  ...and ${stripResult.entries.length - previews.length} more`
				: "";
		const relAudit = auditPath.startsWith(`${ctx.cwd}/`)
			? auditPath.slice(ctx.cwd.length + 1)
			: auditPath;
		const warning =
			`[interlinked:permission-strip] Auto-stripped ${stripResult.totalStripped} malformed permission rule(s) from Claude Code settings file(s) (full audit at ${relAudit}):\n${previews.join("\n")}${more}\n` +
			"These rules came from Claude Code's permission UI; the upstream extractor occasionally emits bad parens / empty / missing-Tool() entries. The agent-write path is already blocked at PreToolUse — this strip handles the UI-write path that is invisible to hooks.";
		log(
			`Auto-stripped ${stripResult.totalStripped} malformed permission rule(s); audit at ${auditPath}`,
		);
		return { decision: "allow", warnings: [...heavyWarnings, warning] };
	} catch (err) {
		log(`Permission-rule auto-strip failed (non-fatal): ${err}`);
		return null;
	}
}
