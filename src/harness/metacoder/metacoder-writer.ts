// ===========================================
// Metacoder — Overlay writer
// ===========================================
// Atomic writes of the session overlay artifacts to
// `.interlinked/sessions/<sanitized-sid>/`. Two files:
//
//   overlay-rules.json  — full OverlayRulesFile payload (loader reads this)
//   system-prompt.md    — free-form addendum, omitted when empty
//
// Multi-prompt sessions overwrite both files atomically (tmp + rename onto
// the same target paths) so the loader never reads a partial overlay.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { sanitizeSessionId } from "../session-paths.js";
import { overlayRulesPath, type SessionLocation } from "./overlay-loader.js";
import type { OverlayRulesFile } from "./types.js";

export interface WrittenOverlayPaths {
	rulesPath: string;
	systemPromptPath: string;
}

/** Public API — consumed by `src/harness/metacoder/index.ts::runMetacoderForPrompt`
 *  to persist the LLM emission. Writes are atomic (tmp + rename) so the
 *  loader never observes a partial JSON. Returns the resolved paths for
 *  both artifacts even when the addendum is empty — callers compose
 *  observability messages off the paths. Throws if `sessionId` sanitizes
 *  to empty (writer would otherwise pollute `.interlinked/sessions/`). */
export function writeOverlayArtifacts(
	loc: SessionLocation,
	overlay: OverlayRulesFile,
): WrittenOverlayPaths {
	const safe = sanitizeSessionId(loc.sessionId);
	if (!safe) {
		throw new Error(`writeOverlayArtifacts: sessionId '${loc.sessionId}' sanitizes to empty`);
	}
	const sessionDir = join(loc.cwd, ".interlinked", "sessions", safe);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}
	const rulesPath = resolveOverlayRulesPath(loc);
	const systemPromptPath = join(sessionDir, SYSTEM_PROMPT_FILENAME);

	atomicWrite(rulesPath, JSON.stringify(overlay, null, 2));
	if (typeof overlay.system_prompt_addendum === "string" && overlay.system_prompt_addendum.length > 0) {
		atomicWrite(systemPromptPath, overlay.system_prompt_addendum);
	} else if (existsSync(systemPromptPath)) {
		// Replace semantics: a follow-up prompt with no addendum should not
		// leave the previous prompt's addendum on disk.
		try {
			unlinkSync(systemPromptPath);
		} catch (_err) {
			// best-effort; tests assert presence/absence via existsSync
		}
	}

	return { rulesPath, systemPromptPath };
}

/** Public API — consumed by `src/harness/server.ts` on `SessionEnd` / `Stop`.
 *  Removes the session's overlay directory and all artifacts in it. Returns
 *  `true` when something was removed, `false` when nothing existed (the
 *  metacoder may never have fired for this session) or the session id
 *  sanitizes to empty. Never throws; failures degrade to `false`. */
export function evictOverlayForSession(loc: SessionLocation): boolean {
	const safe = sanitizeSessionId(loc.sessionId);
	if (!safe) return false;
	const sessionDir = join(loc.cwd, ".interlinked", "sessions", safe);
	if (!existsSync(sessionDir)) return false;
	try {
		rmSync(sessionDir, { recursive: true, force: true });
		return true;
	} catch (_err) {
		return false;
	}
}

// ============================================================================
// Internals
// ============================================================================

const SYSTEM_PROMPT_FILENAME = "system-prompt.md";

function resolveOverlayRulesPath(loc: SessionLocation): string {
	const path = overlayRulesPath(loc);
	if (!path) {
		// Caller already verified sessionId sanitization; this branch is
		// defensive against future sanitizer changes.
		throw new Error(`overlayRulesPath returned null for sessionId '${loc.sessionId}'`);
	}
	return path;
}

/** Write `contents` to `target` via a tmp file in the same directory, then
 *  rename onto `target`. The rename is atomic on POSIX filesystems, so a
 *  concurrent reader either sees the previous contents or the new contents
 *  — never a partial write. */
function atomicWrite(target: string, contents: string): void {
	const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
	writeFileSync(tmp, contents);
	try {
		renameSync(tmp, target);
	} catch (err) {
		// rename failed; clean up the tmp to avoid leaving stragglers.
		try {
			unlinkSync(tmp);
		} catch (_err2) {
			// nothing useful to do; surface the original error
		}
		throw err;
	}
}
