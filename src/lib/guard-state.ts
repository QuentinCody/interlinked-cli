// ===========================================
// Guard state — the per-project "intentionally unguarded" primitive
// ===========================================
// The recorded, attributable, every-layer-honored signal that a developer (or
// team) chose to stand the harness down for a project. It is the *consent* half
// of governance.
//
// Local checks are NOT a trust boundary — a determined actor can always bypass
// them — so the honest enterprise property is not "you cannot disable" but
// "you cannot be SILENTLY unguarded": every stand-down leaves a fingerprint (a
// marker file + an append-only audit event) that the cloud / pre-push / doctor
// surfaces can see and gate on.
//
// Leaf module: depends only on node:fs + node:path so the import-light hook
// cold path (hook-entry-daemon-gate.ts) can read it without pulling in config/
// harness modules (which would risk an import cycle and hot-path weight).
//
// Two scopes, two files under <repo>/.interlinked/:
//   guard-disabled.json        — TEAM / committed (shows up in PR diffs)
//   guard-disabled.local.json  — PERSONAL / gitignored (just this machine)
// Precedence: local overrides team (your machine is yours). A crash NEVER
// looks like a disable (it leaves no marker), so the fail-closed gate stays
// fail-closed for crashes while standing down only on an explicit marker.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Disable granularity. Only whole-project today; `paths` (subtree globs) is a
 *  documented future seam, hence the single-member union rather than a bare
 *  string. */
type GuardScope = "project";

/** The on-disk disable marker. Its presence + `disabled: true` = stood down. */
interface GuardDisableRecord {
	disabled: true;
	scope: GuardScope;
	/** Free-text justification. Org policy may require it (see require_reason). */
	reason?: string;
	/** Who recorded it (agent handle / $USER / git user — resolved by the CLI). */
	by?: string;
	/** ISO-8601 when recorded. */
	at?: string;
	/** ISO-8601 auto-expiry; absent = until `interlinked enable`. */
	expires_at?: string;
	version: 1;
}

/** A resolved disable, annotated with which scope it came from (not persisted). */
interface ResolvedGuardDisable extends GuardDisableRecord {
	source: "local" | "team";
}

/**
 * One row in the append-only guard audit log (`guard-events.jsonl`). A
 * discriminated union (not an open `Record`) so every audited field has a
 * declared shape — the same bar the `broad_object_types` check enforces
 * everywhere else in the tree.
 */
type GuardEvent =
	| ({ action: "disable"; source: "local" | "team" } & GuardDisableRecord)
	| { action: "enable"; cleared: Array<"local" | "team">; by?: string; at?: string };

const TEAM_MARKER = "guard-disabled.json";
const LOCAL_MARKER = "guard-disabled.local.json";
const AUDIT_LOG = "guard-events.jsonl";

function markerPath(interlinkedDir: string, source: "local" | "team"): string {
	return join(interlinkedDir, source === "local" ? LOCAL_MARKER : TEAM_MARKER);
}

/**
 * Parse + validate one marker file. Returns null on absent / malformed /
 * not-actually-disabled / expired — every "I can't confirm a deliberate, live
 * stand-down" case fails toward GUARDING (null), never toward silently
 * unguarded.
 */
function readMarker(
	path: string,
	source: "local" | "team",
	now: number,
): ResolvedGuardDisable | null {
	if (!existsSync(path)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null; // malformed → treat as not disabled (fail toward guarding)
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const rec = parsed as Partial<GuardDisableRecord>;
	if (rec.disabled !== true) return null;
	if (rec.expires_at !== undefined) {
		const exp = Date.parse(rec.expires_at);
		// Fail toward GUARDING on a malformed expiry: an unparseable `expires_at`
		// (Date.parse → NaN) must NOT read as a live, never-expiring stand-down.
		// A typo in this human-reviewable marker should re-arm the guard, not
		// silently disable it forever — malformed OR already-past both mean "not a
		// live stand-down" (finding 2026-06, round 8; the inline reader mirrors this).
		if (!Number.isFinite(exp) || exp <= now) return null;
	}
	return {
		disabled: true,
		scope: rec.scope === "project" ? rec.scope : "project",
		...(rec.reason !== undefined ? { reason: rec.reason } : {}),
		...(rec.by !== undefined ? { by: rec.by } : {}),
		...(rec.at !== undefined ? { at: rec.at } : {}),
		...(rec.expires_at !== undefined ? { expires_at: rec.expires_at } : {}),
		version: 1,
		source,
	};
}

/**
 * Resolve the effective disable record for a repo given its `.interlinked` dir.
 * Local (personal) overrides team (committed). Returns null when the guard is
 * active (the common case). `now` is injectable for deterministic tests.
 */
export function readGuardDisable(
	interlinkedDir: string,
	now: number = Date.now(),
): ResolvedGuardDisable | null {
	return (
		readMarker(markerPath(interlinkedDir, "local"), "local", now) ??
		readMarker(markerPath(interlinkedDir, "team"), "team", now)
	);
}

interface WriteGuardDisableInput {
	scope?: GuardScope;
	reason?: string;
	by?: string;
	/** ISO-8601 auto-expiry; absent = no expiry. */
	expires_at?: string;
	/** ISO-8601 timestamp to stamp `at` (injectable for tests). */
	now?: string;
}

/**
 * Write a disable marker (local by default, team/committed when `team` is true)
 * and append an audit event. Returns the resolved record written.
 */
export function writeGuardDisable(
	interlinkedDir: string,
	input: WriteGuardDisableInput,
	team = false,
): ResolvedGuardDisable {
	const source: "local" | "team" = team ? "team" : "local";
	const record: GuardDisableRecord = {
		disabled: true,
		scope: input.scope ?? "project",
		...(input.reason !== undefined ? { reason: input.reason } : {}),
		...(input.by !== undefined ? { by: input.by } : {}),
		at: input.now ?? new Date().toISOString(),
		...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
		version: 1,
	};
	ensureDir(interlinkedDir);
	writeFileSync(markerPath(interlinkedDir, source), `${JSON.stringify(record, null, 4)}\n`);
	appendGuardEvent(interlinkedDir, { action: "disable", source, ...record });
	return { ...record, source };
}

/**
 * Remove disable marker(s) and append an audit event. By default clears BOTH
 * scopes (full re-arm); pass `{ team: false }` / `{ local: false }` to scope it.
 */
export function clearGuardDisable(
	interlinkedDir: string,
	opts: { local?: boolean; team?: boolean; by?: string; now?: string } = {},
): { cleared: Array<"local" | "team"> } {
	const wantLocal = opts.local ?? true;
	const wantTeam = opts.team ?? true;
	const cleared: Array<"local" | "team"> = [];
	for (const source of ["local", "team"] as const) {
		if (source === "local" && !wantLocal) continue;
		if (source === "team" && !wantTeam) continue;
		const p = markerPath(interlinkedDir, source);
		if (existsSync(p)) {
			rmSync(p, { force: true });
			cleared.push(source);
		}
	}
	if (cleared.length > 0) {
		appendGuardEvent(interlinkedDir, {
			action: "enable",
			cleared,
			...(opts.by !== undefined ? { by: opts.by } : {}),
			at: opts.now ?? new Date().toISOString(),
		});
	}
	return { cleared };
}

function ensureDir(interlinkedDir: string): void {
	if (!existsSync(interlinkedDir)) mkdirSync(interlinkedDir, { recursive: true });
}

/**
 * Append one event to the append-only guard audit log. Best-effort: never
 * throws — the audit trail must not break the operation that triggered it.
 */
export function appendGuardEvent(interlinkedDir: string, event: GuardEvent): void {
	try {
		ensureDir(interlinkedDir);
		const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
		appendFileSync(join(interlinkedDir, AUDIT_LOG), line);
	} catch {
		/* audit is best-effort — never block the operation on a log-write failure */
	}
}
