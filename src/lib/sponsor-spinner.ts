// ===========================================
// Sponsor spinner-verb management (~/.claude/settings.json)
// ===========================================
// Spec: docs/design/sponsor-slots.md. Claude Code >= 2.1.143 reads the
// documented `spinnerVerbs` settings key ({ mode: "append" | "replace",
// verbs: string[] }) at boot. We only ever MANAGE OUR OWN verbs:
//   - add: append one verb, defaulting mode to "append" (sponsored verbs
//     mix with the stock pool — never a takeover), preserving any
//     user-chosen mode and user-authored verbs.
//   - remove: delete exactly the verbs we previously wrote (tracked in
//     config.local.json `sponsor.spinner_verbs_written`), dropping the
//     whole key only when our removal leaves an empty append-mode entry.
// Settings are plain JSON here (matching `hook-installers-statusline.ts`);
// a malformed file is left untouched and reported, never overwritten.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stripControlChars } from "../harness/sponsor/types.js";
import type { JsonObject } from "./json-types.js";

export interface SpinnerEditResult {
	ok: boolean;
	/** The exact verb string written (post-sanitization) — track this for removal. */
	written?: string;
	reason?: string;
}

/** Longest verb we will write — the spinner renders inline, keep it short. */
const MAX_VERB_LEN = 48;

interface SpinnerVerbsShape {
	mode?: unknown;
	verbs?: unknown;
}

function readSettings(path: string): JsonObject | null {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as JsonObject;
		}
		return null;
	} catch {
		return null;
	}
}

function writeSettings(path: string, settings: JsonObject): void {
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Append one sponsored verb. Idempotent; never disturbs other keys. */
export function addSponsorSpinnerVerb(settingsPath: string, verb: string): SpinnerEditResult {
	const clean = stripControlChars(verb).trim().slice(0, MAX_VERB_LEN);
	if (clean.length === 0) return { ok: false, reason: "empty verb after sanitization" };
	const settings = readSettings(settingsPath);
	if (settings === null) {
		return { ok: false, reason: "settings.json not parseable — left untouched" };
	}
	const existing = settings.spinnerVerbs as SpinnerVerbsShape | undefined;
	const verbs: string[] =
		existing && Array.isArray(existing.verbs)
			? existing.verbs.filter((v): v is string => typeof v === "string")
			: [];
	if (!verbs.includes(clean)) verbs.push(clean);
	const mode = existing && typeof existing.mode === "string" ? existing.mode : "append";
	settings.spinnerVerbs = { mode, verbs };
	try {
		writeSettings(settingsPath, settings);
		return { ok: true, written: clean };
	} catch (e) {
		return { ok: false, reason: String(e) };
	}
}

/**
 * Remove exactly `ours` from the verbs array. Drops the `spinnerVerbs` key
 * entirely when removal leaves an empty append-mode entry (a clean
 * settings.json for users who never customized the spinner themselves).
 */
export function removeSponsorSpinnerVerbs(
	settingsPath: string,
	ours: string[],
): SpinnerEditResult {
	if (!existsSync(settingsPath)) return { ok: true };
	const settings = readSettings(settingsPath);
	if (settings === null) {
		return { ok: false, reason: "settings.json not parseable — left untouched" };
	}
	const existing = settings.spinnerVerbs as SpinnerVerbsShape | undefined;
	if (!existing || !Array.isArray(existing.verbs)) return { ok: true };
	const mine = new Set(ours);
	const kept = existing.verbs.filter(
		(v): v is string => typeof v === "string" && !mine.has(v),
	);
	const mode = typeof existing.mode === "string" ? existing.mode : "append";
	if (kept.length === 0 && mode === "append") {
		delete settings.spinnerVerbs;
	} else {
		settings.spinnerVerbs = { mode, verbs: kept };
	}
	try {
		writeSettings(settingsPath, settings);
		return { ok: true };
	} catch (e) {
		return { ok: false, reason: String(e) };
	}
}
