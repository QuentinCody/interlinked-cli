// ===========================================
// Taint Tracker — Trajectory-level sensitivity tracking
// ===========================================
// Implements Bell-LaPadula-inspired information flow control (IFC/MLS).
// Once a session reads sensitive data, its label ratchets UP (never down).
// Outbound network commands are blocked when sensitivity reaches threshold.

import { nonNull } from "../lib/non-null.js";
import { classifyNetworkIntent } from "./network-intent.js";
import { actorLevel, raiseActorLevel, SENSITIVITY_ORDER } from "./taint-lineage.js";
import type {
	SensitivityLevel,
	SessionTrajectory,
	TaintProvenance,
	TaintSource,
	TaintTrackingConfig,
} from "./types.js";

// ===========================================
// Sensitivity Level Ordering
// ===========================================

// The ordering lives with the per-actor lineage (taint-lineage.ts), which needs
// it without importing this module; re-exported here for every existing caller.
export { SENSITIVITY_ORDER };

// ===========================================
// Default Configuration
// ===========================================

export const DEFAULT_TAINT_CONFIG: TaintTrackingConfig = {
	enabled: true,
	file_sensitivity: [
		// HighlyConfidential — raw key material, cloud credentials
		{ glob: "**/*.pem", level: "HighlyConfidential" },
		{ glob: "**/*.key", level: "HighlyConfidential" },
		{ glob: "**/*.p12", level: "HighlyConfidential" },
		{ glob: "**/*.pfx", level: "HighlyConfidential" },
		{ glob: "**/*.jks", level: "HighlyConfidential" },
		{ glob: "**/.ssh/id_*", level: "HighlyConfidential" },
		{ glob: "**/.aws/credentials", level: "HighlyConfidential" },
		{
			glob: "**/.config/gcloud/application_default_credentials.json",
			level: "HighlyConfidential",
		},
		{ glob: "**/.azure/accessTokens.json", level: "HighlyConfidential" },
		{ glob: "**/.azure/msal_token_cache*", level: "HighlyConfidential" },
		{ glob: "**/.kube/config", level: "HighlyConfidential" },
		{ glob: "**/.oci/oci_api_key*", level: "HighlyConfidential" },

		// Confidential — env files, secrets directories
		// Exclude placeholder templates (they contain "your-api-key-here", not real secrets)
		{ glob: "**/.env.example", level: "Public" },
		{ glob: "**/.env.sample", level: "Public" },
		{ glob: "**/.env.template", level: "Public" },
		{ glob: "**/.env", level: "Confidential" },
		{ glob: "**/.env.*", level: "Confidential" },
		{ glob: "**/secrets/**", level: "Confidential" },
		{ glob: "**/secret/**", level: "Confidential" },
		{ glob: "**/credentials.json", level: "Confidential" },
		{ glob: "**/service-account*.json", level: "Confidential" },
		{ glob: "**/.gcloud/**", level: "Confidential" },

		// Internal — local config, interlinked config
		{ glob: "**/.interlinked/config.local.json", level: "Internal" },
		{ glob: "**/config.local.*", level: "Internal" },
	],
	step_limits: {
		Public: Number.POSITIVE_INFINITY,
		Internal: Number.POSITIVE_INFINITY,
		Confidential: Number.POSITIVE_INFINITY,
		HighlyConfidential: Number.POSITIVE_INFINITY,
	},
	network_block_at: "Confidential",
};

// ===========================================
// Network Command Detection
// ===========================================
// Classification is POSITIONAL — a network verb counts only as the HEAD command
// of a shell segment, never as a substring (the old `\b(curl|…|nc|…)\b` regex
// matched `nc` inside `grep -nc`; finding 2026-06, round 7). Since 2026-10-05
// both functions below delegate to the ONE network-intent predicate
// (network-intent.ts): loop/compound bodies (`do curl …`), wrappers, shell
// functions, command substitutions and interpreter inline programs that call a
// network API are all read the same way for every gate. The verb table lives in
// network-verbs.ts; loopback exemption stays in network-loopback.ts.

/** True when some segment runs a network command, loopback peers included. */
export function isNetworkCommand(command: string): boolean {
	return classifyNetworkIntent(command).segments.length > 0;
}

/** Network guard classification: exempt understood loopback invocations only.
 * Each shell segment is checked independently, so one local request cannot
 * exempt a later remote request. Dynamic shell text retains the guard. */
export function isOutboundNetworkCommand(command: string): boolean {
	return classifyNetworkIntent(command).network;
}

// ===========================================
// File Sensitivity Classification
// ===========================================

/** Classify a file's sensitivity based on its path */
export function classifyFileSensitivity(
	filePath: string,
	config: TaintTrackingConfig,
): SensitivityLevel {
	for (const entry of config.file_sensitivity) {
		if (sensitivityGlobMatch(filePath, entry.glob)) {
			return entry.level;
		}
	}
	return "Public";
}

// ===========================================
// Provenance Classification
// ===========================================
//
// Provenance is independent from sensitivity (see types/taint.ts). It records
// WHERE data originated — trusted local read vs untrusted external source.
// The external-action-on-untrusted-input guard
// (`checkProvenanceTaintToExternalAction`) consults this to decide whether
// to surface a confirmation prompt.

/** Doc-shaped extensions whose contents are typically prose, not code.
 *  Treated as `document_content` provenance (prompts may live in here). */
const DOCUMENT_EXTENSIONS = new Set([".md", ".pdf", ".txt", ".rst", ".adoc"]);

/** Code-shaped extensions whose contents we treat as trusted local reads. */
const CODE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".py",
	".go",
	".rs",
	".rb",
	".java",
	".c",
	".cpp",
	".h",
]);

function extLower(filePath: string): string {
	const idx = filePath.lastIndexOf(".");
	if (idx < 0) return "";
	return filePath.slice(idx).toLowerCase();
}

/**
 * Classify the provenance of a taint source given the tool and target path.
 * Used wherever a TaintSource is created to populate the new `provenance`
 * field. Defaults to `local_read` when nothing else matches — the safe
 * choice for the external-action gate (no extra ask fires).
 *
 * Inputs:
 *   - toolName: the originating tool ("Read", "WebFetch", "WebSearch",
 *     "UserPromptSubmit", or any `mcp__*__*` tool name). May be undefined
 *     when the caller (e.g. `ratchetSensitivity` without a toolName arg)
 *     can only consult the filePath — pseudo-filepaths like
 *     `<WebFetch-response>` are parsed in that fallback.
 *   - filePath: the file or pseudo-file (e.g. `<command-output>`) the
 *     taint source was attributed to. Used to discriminate doc vs code
 *     for local reads, and as the fallback signal when toolName is
 *     missing.
 */
export function classifyProvenance(
	toolName: string | undefined,
	filePath: string,
): TaintProvenance {
	// Direct toolName match — takes precedence when caller knows.
	if (toolName === "UserPromptSubmit") return "user_provided";
	if (toolName === "WebFetch" || toolName === "web_fetch" || toolName === "WebSearch") {
		return "fetched_external";
	}
	if (toolName && /^mcp__/.test(toolName)) return "mcp_remote";
	// Pseudo-filepath fallback — content-scanner / output-scan callers
	// attribute taint to `<WebFetch-response>`, `<mcp__github__list_issues-response>`,
	// `<command-output>` etc. without threading the originating toolName
	// through to `ratchetSensitivity`. Parse the bracketed token so those
	// taint sources still land with the correct provenance.
	if (filePath.startsWith("<") && filePath.endsWith(">")) {
		const inner = filePath.slice(1, -1);
		if (/^(?:WebFetch|web_fetch|WebSearch)/.test(inner)) return "fetched_external";
		if (/^mcp__/.test(inner)) return "mcp_remote";
		// `<command-output>`, `<UserPromptSubmit-...>`, etc. fall through.
		if (/^UserPromptSubmit/.test(inner)) return "user_provided";
	}
	// File reads — discriminate doc-shaped vs code-shaped by extension.
	const ext = extLower(filePath);
	if (DOCUMENT_EXTENSIONS.has(ext)) return "document_content";
	if (CODE_EXTENSIONS.has(ext)) return "local_read";
	return "local_read";
}

// ===========================================
// Taint Ratchet
// ===========================================

/** One taint source to apply: what was read and at what level. */
export interface TaintRatchet {
	file: string;
	level: SensitivityLevel;
	provenance?: TaintProvenance | undefined;
	detail?: string | undefined;
}

/**
 * Ratchet the ACTING actor (and, through taint-lineage.ts, every ancestor up
 * to the session root) to `source.level` if that is higher than the actor's
 * level. `actor` is `session-state-mutators.ts::actorKeyOf`; undefined raises
 * every actor (the legacy session-wide behavior, fail safe). A source is
 * recorded only when the actor's level rose. Returns that fact.
 */
export function ratchetActorSensitivity(
	session: SessionTrajectory,
	actor: string | undefined,
	source: TaintRatchet,
	config: TaintTrackingConfig,
): boolean {
	const { actorRose, sessionRose } = raiseActorLevel(session, actor, source.level);
	if (sessionRose) session.step_limit = config.step_limits[source.level];
	if (!actorRose) return false;
	session.taint_sources.push({
		file: source.file,
		level: source.level,
		at_step: session.tool_call_count,
		// Inferred from the file extension when the caller does not know it.
		provenance: source.provenance ?? classifyProvenance("Read", source.file),
		// Every push raised a level: the block reason names the latest one at
		// the acting actor's level as the source that SET it.
		escalated: true,
	});
	const pushed = nonNull(session.taint_sources.at(-1));
	if (source.detail !== undefined) pushed.detail = source.detail;
	if (actor !== undefined) pushed.actor = actor;
	return true;
}

/**
 * Ratchet with no named actor: raises EVERY actor (session-wide, the original
 * semantics). Callers that know the acting actor use `ratchetActorSensitivity`.
 */
export function ratchetSensitivity(
	session: SessionTrajectory,
	file: string,
	level: SensitivityLevel,
	config: TaintTrackingConfig,
	provenance?: TaintProvenance,
	detail?: string,
): boolean {
	return ratchetActorSensitivity(session, undefined, { file, level, provenance, detail }, config);
}

// ===========================================
// Taint Checks
// ===========================================

/** Check if outbound network should be blocked for the acting actor (no
 *  actor ⇒ the session level, which is the max over every actor). */
export function shouldBlockNetwork(
	session: Readonly<SessionTrajectory>,
	config: TaintTrackingConfig,
	actor?: string,
): boolean {
	return SENSITIVITY_ORDER[actorLevel(session, actor)] >= SENSITIVITY_ORDER[config.network_block_at];
}

/**
 * Steps the budget is measured against. A spawned agent's tool calls arrive
 * under the PARENT session id, so `tool_call_count` sums every actor in the
 * session; the budget binds one actor's own count. With no `actor` (legacy
 * callers) or no per-actor map (a session hydrated from a pre-fix snapshot)
 * the session total still governs. An actor the map has not seen yet has made
 * zero counted calls.
 */
export function actorStepCount(session: SessionTrajectory, actor?: string): number {
	const perActor = session.actor_tool_calls;
	if (actor === undefined || perActor === undefined) return session.tool_call_count;
	return perActor.get(actor) ?? 0;
}

/** Check if the actor (or, without one, the session) has exceeded its step limit */
export function isStepLimitExceeded(session: SessionTrajectory, actor?: string, limit = session.step_limit): boolean {
	return actorStepCount(session, actor) > limit;
}

/** Get step budget warning if approaching the limit. Returns null if no warning needed. */
export function getStepBudgetWarning(session: SessionTrajectory, actor?: string, limit = session.step_limit): string | null {
	if (limit === Number.POSITIVE_INFINITY) return null;
	const steps = actorStepCount(session, actor);
	const pct = steps / limit;
	const remaining = limit - steps;
	const level = actorLevel(session, actor);
	if (pct >= 0.95) {
		return `[interlinked:budget] CRITICAL: ${remaining} steps remaining (${Math.round(pct * 100)}% of ${limit} limit at ${level} sensitivity). Wrap up current work and hand off.`;
	}
	if (pct >= 0.8) {
		return `[interlinked:budget] WARNING: ${remaining} steps remaining (${Math.round(pct * 100)}% of ${limit} limit at ${level} sensitivity). Prioritize remaining work.`;
	}
	return null;
}

/**
 * The source that SET the session's current level.
 *
 * Two formats exist on disk. New snapshots mark the raising source with
 * `escalated: true`, so the latest escalated source at the current level is
 * the setter — proven. Snapshots written before that flag carry no mark at
 * all; there the EARLIEST source whose level equals the current level is the
 * one that raised it (every later source at that level found the level
 * already there), so it is reported as `inferred`. Without the fallback an
 * old snapshot's level is opaque and nothing can re-judge it — which is how
 * one false ratchet became permanent (2026-10-02).
 */
export function findTaintSetter(
	sources: readonly TaintSource[],
	level: SensitivityLevel,
): { source: TaintSource; inferred: boolean } | null {
	for (let i = sources.length - 1; i >= 0; i--) {
		const candidate = sources[i];
		if (candidate?.escalated === true && candidate.level === level) {
			return { source: candidate, inferred: false };
		}
	}
	const earliest = sources.find((s) => s.level === level);
	return earliest ? { source: earliest, inferred: true } : null;
}

/** Format taint sources for display in block/warning messages. Leads with the
 *  source that SET the acting actor's level (no actor ⇒ the session level),
 *  then the last three sources. A setter recovered from a pre-`escalated`
 *  snapshot is marked `(inferred)`. */
export function formatTaintSources(session: SessionTrajectory, actor?: string): string {
	if (session.taint_sources.length === 0) return "unknown";
	const recent = session.taint_sources
		.map((s) => s.file)
		.slice(-3) // Show last 3 sources
		.join(", ");
	const found = findTaintSetter(session.taint_sources, actorLevel(session, actor));
	if (!found) return recent;
	const { source: setter, inferred } = found;
	const label = setter.detail ? `${setter.file.replace(/>$/, "")}: ${setter.detail}>` : setter.file;
	const prefix = inferred ? "set by (inferred)" : "set by";
	return `${prefix} ${label} at step ${setter.at_step}; recent: ${recent}`;
}

// ===========================================
// Simple Glob Match (for sensitivity patterns)
// ===========================================

function sensitivityGlobMatch(filePath: string, pattern: string): boolean {
	if (filePath === pattern) return true;

	// "**/*.ext" or "**/*.ext*"
	if (pattern.startsWith("**/")) {
		const rest = pattern.slice(3);
		if (rest.startsWith("*.")) {
			const suffix = rest.slice(1);
			if (suffix.endsWith("*")) {
				return filePath.includes(suffix.slice(0, -1));
			}
			return filePath.endsWith(suffix);
		}
		// "**/.ssh/id_*" — match path ending with prefix
		if (rest.includes("*")) {
			const prefix = rest.replaceAll("*", "");
			return filePath.includes(prefix);
		}
		return filePath.endsWith(`/${rest}`) || filePath === rest;
	}

	return false;
}
