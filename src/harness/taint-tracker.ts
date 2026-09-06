// ===========================================
// Taint Tracker — Trajectory-level sensitivity tracking
// ===========================================
// Implements Bell-LaPadula-inspired information flow control (IFC/MLS).
// Once a session reads sensitive data, its label ratchets UP (never down).
// Outbound network commands are blocked when sensitivity reaches threshold.

import { nonNull } from "../lib/non-null.js";
import { shellSplit, splitSegments, stripLeadingPrefix } from "./shell-structure.js";
import type {
	SensitivityLevel,
	SessionTrajectory,
	TaintProvenance,
	TaintTrackingConfig,
} from "./types.js";

// ===========================================
// Sensitivity Level Ordering
// ===========================================

/** Numeric ordering for monotone sensitivity ratcheting (Bell-LaPadula MLS model) */
export const SENSITIVITY_ORDER: Record<SensitivityLevel, number> = {
	Public: 0,
	Internal: 1,
	Confidential: 2,
	HighlyConfidential: 3,
};

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
		Internal: 50_000,
		Confidential: 10_000,
		HighlyConfidential: 5_000,
	},
	network_block_at: "Confidential",
};

// ===========================================
// Network Command Detection
// ===========================================
// Classification is POSITIONAL — a network verb counts only as the HEAD command
// of a shell segment (segments split on ; | && || newline), never as a
// substring. The previous `\b(curl|…|nc|…|ssh|…)\b` regex matched `nc` inside
// `grep -nc` and `ssh` inside `~/.ssh/config`, because `-` and `.` are
// non-word chars so `\b` fired right before the verb (finding 2026-06, round
// 7) — the flag-attached / path-embedded false-positive class. Tokenizing
// through the blessed shell-structure contract is the same fix round 6 applied
// to the coverage/install/commit classifiers; isNetworkCommand is enrolled in
// the shared adversarial command corpus alongside them.

/** Verbs whose mere invocation opens a network connection. */
const NETWORK_VERBS = new Set([
	"curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "socat", "telnet", "ftp",
]);

/** `head subcommand` pairs that publish to a remote registry. */
const PUBLISH_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
	npm: new Set(["publish"]),
	pnpm: new Set(["publish"]),
	yarn: new Set(["publish"]),
	cargo: new Set(["publish"]),
	pip: new Set(["upload"]),
	twine: new Set(["upload"]),
	gem: new Set(["push"]),
};

/** Last path segment of a command token, so `/usr/bin/curl` reads as `curl`. */
function commandHead(token: string): string {
	return (token.split("/").pop() ?? token).toLowerCase();
}

/** Check if a shell command involves network communication. A verb is counted
 *  only when it is the actual command being run in some segment — the head
 *  token (after env/sudo prefixes strip), or a publish subcommand of it. */
export function isNetworkCommand(command: string): boolean {
	for (const segment of splitSegments(command)) {
		const tokens = stripLeadingPrefix(shellSplit(segment));
		if (tokens.length === 0) continue;
		const head = commandHead(nonNull(tokens[0]));
		if (NETWORK_VERBS.has(head)) return true;
		const sub = PUBLISH_SUBCOMMANDS[head];
		if (sub && tokens[1] !== undefined && sub.has(tokens[1].toLowerCase())) return true;
	}
	return false;
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

/**
 * Ratchet session sensitivity upward if the new level is higher.
 * The optional `provenance` parameter records where the data originated
 * (default: classified from `file` extension as a local read). Older
 * call sites that don't pass it get the inferred classification, which
 * matches the v1 default behaviour for backward compatibility.
 */
export function ratchetSensitivity(
	session: SessionTrajectory,
	file: string,
	level: SensitivityLevel,
	config: TaintTrackingConfig,
	provenance?: TaintProvenance,
): boolean {
	const currentOrder = SENSITIVITY_ORDER[session.sensitivity_level];
	const newOrder = SENSITIVITY_ORDER[level];

	if (newOrder > currentOrder) {
		session.sensitivity_level = level;
		session.step_limit = config.step_limits[level];
		session.taint_sources.push({
			file,
			level,
			at_step: session.tool_call_count,
			// When the caller doesn't specify provenance, infer from the file
			// extension. The Read-of-source-file path passes filePath only;
			// the file extension is enough to discriminate doc vs code.
			provenance: provenance ?? classifyProvenance("Read", file),
		});
		return true; // Sensitivity was escalated
	}
	return false;
}

// ===========================================
// Taint Checks
// ===========================================

/** Check if outbound network should be blocked at current sensitivity */
export function shouldBlockNetwork(
	session: SessionTrajectory,
	config: TaintTrackingConfig,
): boolean {
	const sessionOrder = SENSITIVITY_ORDER[session.sensitivity_level];
	const blockOrder = SENSITIVITY_ORDER[config.network_block_at];
	return sessionOrder >= blockOrder;
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
export function isStepLimitExceeded(session: SessionTrajectory, actor?: string): boolean {
	return actorStepCount(session, actor) > session.step_limit;
}

/** Get step budget warning if approaching the limit. Returns null if no warning needed. */
export function getStepBudgetWarning(session: SessionTrajectory, actor?: string): string | null {
	if (session.step_limit === Number.POSITIVE_INFINITY) return null;
	const steps = actorStepCount(session, actor);
	const pct = steps / session.step_limit;
	const remaining = session.step_limit - steps;
	if (pct >= 0.95) {
		return `[interlinked:budget] CRITICAL: ${remaining} steps remaining (${Math.round(pct * 100)}% of ${session.step_limit} limit at ${session.sensitivity_level} sensitivity). Wrap up current work and commit.`;
	}
	if (pct >= 0.8) {
		return `[interlinked:budget] WARNING: ${remaining} steps remaining (${Math.round(pct * 100)}% of ${session.step_limit} limit at ${session.sensitivity_level} sensitivity). Prioritize remaining work.`;
	}
	return null;
}

/** Format taint sources for display in block/warning messages */
export function formatTaintSources(session: SessionTrajectory): string {
	if (session.taint_sources.length === 0) return "unknown";
	return session.taint_sources
		.map((s) => s.file)
		.slice(-3) // Show last 3 sources
		.join(", ");
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
