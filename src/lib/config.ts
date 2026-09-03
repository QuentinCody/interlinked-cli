// ===========================================
// Two-Tier Config Management
// ===========================================
// config.json — committed, team-shared settings
// config.local.json — gitignored, personal (tokens, agent handles)
// Legacy migration from .claude/interlinked-session.json

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	getConfigDir,
	getDataDir,
	getHooksDir,
	getLegacyConfigPath,
	getLocalConfigPath,
	getSharedConfigPath,
} from "./config-paths.js";
import {
	resolveActiveServerEntry,
	resolveConfigEnvOverrides,
	resolveSyncMode,
} from "./config-resolve.js";
import { readJsonFile } from "./json-file.js";

// Path helpers live in ./config-paths.ts (line-cap split). Re-exported here
// so existing `from "./config.js"` imports across the codebase keep working.
export {
	getConfigDir,
	getDataDir,
	getHooksDir,
	getLocalConfigPath,
	getSharedConfigPath,
};

// ===========================================
// Types
// ===========================================

export interface SharedConfig {
	version: 1;
	server_url: string;
	default_workspace_key?: string;
	default_project?: string;
	/**
	 * Tiered harness mode (Phase C). One of `budget` / `quality` / `ci`.
	 * Drives the generated `.mjs` hook's `HARNESS_POST_TIMEOUT_MS` literal
	 * and the daemon's heavy-check enablement. Persisted via
	 * `interlinked harness mode <name>`. Legacy `balanced` strings are
	 * auto-migrated by `migrateLegacyMode()` in `harness/rules/modes.ts`
	 * (per master plan Q&A: balanced → budget on Copilot CLI, → quality
	 * elsewhere) so existing installs keep working without a manual edit.
	 */
	// Widened to `string` (not `HarnessMode | string`, which the type system
	// treats as identical to `string`): known values are "budget" / "quality" /
	// "ci" (see HarnessMode), plus the legacy "balanced" string that
	// migrateLegacyMode() auto-migrates before use.
	mode?: string;
	/** Custom PII patterns for verify detection. */
	pii_patterns?: Array<{ name: string; pattern: string; severity?: string }>;
	/** Opt-in built-in PII patterns (e.g., "email", "phone_us", "ip_address"). */
	pii_opt_in?: string[];
	/**
	 * Path globs to skip for the entire PostToolUse check pipeline. Matched
	 * against the file_path of every Edit/Write event; if the path matches any
	 * entry, both inline detectors and external tool runners short-circuit
	 * with an empty CheckReport (skip category: `config_disabled`).
	 *
	 * Lives on `SharedConfig` (committed) so the team agrees on what is
	 * out-of-scope for harness checks — generated code, vendored deps, build
	 * artifacts, lockfiles, IDE metadata. Personal additions belong in
	 * `.interlinked/guard-rules.local.json` or per-rule disables.
	 *
	 * Glob syntax matches `src/lib/path-glob.ts`: `*` (within segment), `**`
	 * (across segments), `?`, `[abc]` (no ranges), `{a,b}` (alternation).
	 * Defaults are seeded from `getDefaultConfig().skip_paths` in
	 * `src/harness/rules/default-config.ts`.
	 */
	skip_paths?: string[];
	/**
	 * Feature flags. Nested structure addressed by dotted path via
	 * `isFeatureEnabled("harness.evaluator.wrapper_normalization")`. Unknown keys
	 * fall through to `FEATURE_DEFAULTS`; unknown defaults fall through to false
	 * (dark-ship safety).
	 */
	harness?: FeatureNode;
}

/**
 * Recursive feature-flag node — any nested object whose leaves are booleans.
 * `null` is included because this shape is read straight off disk via
 * `JSON.parse`; a hand-edited or partially-written config.json can legally
 * carry `null` at any branch, and the declared type must say so rather than
 * lying about a boundary the reader has to guard anyway.
 */
export type FeatureNode = { [key: string]: boolean | FeatureNode | null };

/** A branch node of the feature tree: an object, not a leaf boolean and not
 *  the on-disk `null` a hand-edited config can carry at any depth. */
function isFeatureNode(value: boolean | FeatureNode | null | undefined): value is FeatureNode {
	return typeof value === "object" && value !== null;
}

export interface ServerEntry {
	server_url: string;
	mcp_prefix?: string | undefined;
	workspace_id?: string | undefined;
}

export interface LocalConfig {
	agent_name?: string | undefined;
	mcp_prefix?: string | undefined;
	workspace_id?: string | undefined;
	access_token?: string | undefined;
	refresh_token?: string | undefined;
	token_expires_at?: string | undefined;
	oauth_client_id?: string | undefined;
	agent_handle?: string | undefined;
	/** Key into `servers` map. Defaults to "production". */
	active_server?: string;
	servers?: Record<string, ServerEntry>;
	/** Sync mode: "realtime" (default), "local", or "manual". */
	sync_mode?: "realtime" | "local" | "manual";
	/** Override data directory (activity.jsonl, sessions/, sync-state.json). */
	data_dir?: string;
	/** Checkpoint configuration. */
	checkpoints?: {
		auto_archive_count?: number;
		auto_archive_days?: number;
		auto_checkpoint_on?: string[];
	};
	/** Guard mode for file reservation enforcement: "warn" (default), "block", or "off". */
	guard_mode?: "warn" | "block" | "off";
	/** Anonymous install id for sponsor telemetry (lazily generated UUID). */
	install_id?: string;
	/** Sponsor-slot settings — docs/design/sponsor-slots.md. */
	sponsor?: SponsorConfig;
}

/** Sponsor-slot settings (all optional; absent = disabled). */
export interface SponsorConfig {
	/** Master opt-in for the statusline sponsor row. */
	enabled?: boolean;
	/** Feed URL override (defaults to the hosted Worker). */
	feed_url?: string;
	/** Anonymous impression/click telemetry (default true when enabled). */
	telemetry?: boolean;
	/** Whether the spinner-verb surface was opted into. */
	spinner?: boolean;
	/** Verbs we wrote into ~/.claude/settings.json (so disable removes exactly ours). */
	spinner_verbs_written?: string[];
}

export interface ResolvedConfig {
	server_url: string;
	workspace_id?: string | undefined;
	default_workspace_key?: string | undefined;
	agent_name?: string | undefined;
	mcp_prefix?: string | undefined;
	access_token?: string | undefined;
	refresh_token?: string | undefined;
	token_expires_at?: string | undefined;
	oauth_client_id?: string | undefined;
	agent_handle?: string | undefined;
	default_project?: string | undefined;
	sync_mode: string;
}

// Legacy format from .claude/interlinked-session.json
interface LegacySession {
	server_url: string;
	workspace_uuid?: string;
	agent_name?: string;
	agent_handle?: string;
	mcp_prefix?: string;
	installed_at?: string;
	clients?: string[];
	default_server?: string;
	servers?: Record<
		string,
		{
			server_url: string;
			agent_name?: string;
			mcp_prefix?: string;
			workspace_uuid?: string;
		}
	>;
}

// Default to localhost — public distribution has no production server to
// point at. Users configure their own remote via `interlinked enable
// --server <url>` or the `INTERLINKED_SERVER_URL` env var.
const DEFAULT_SERVER = "http://localhost:8787";

// ===========================================
// Read/Write Helpers
// ===========================================

function writeJson(path: string, data: unknown): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, `${JSON.stringify(data, null, 4)}\n`);
}

// ===========================================
// Config Operations
// ===========================================

export function readSharedConfig(cwd?: string): SharedConfig | null {
	return readJsonFile<SharedConfig>(getSharedConfigPath(cwd));
}

export function readLocalConfig(cwd?: string): LocalConfig | null {
	return readJsonFile<LocalConfig>(getLocalConfigPath(cwd));
}

export function writeSharedConfig(config: SharedConfig, cwd?: string): void {
	writeJson(getSharedConfigPath(cwd), config);
}

// ===========================================
// Feature flags
// ===========================================

/**
 * Source-of-truth defaults for every feature flag in the codebase. New features
 * MUST add an entry here with their default value. Phase-1 plan flags default
 * to `true`; dark-shipped Phase-2/3 features default to `false` and flip after
 * one release of telemetry confirms low FP rate.
 *
 * Dotted path → default boolean. Lookups via `isFeatureEnabled` consult an
 * override in `SharedConfig.harness` (nested by path segment) first, then this
 * map, then return `false` for unknown keys.
 */
export const FEATURE_DEFAULTS: Readonly<Record<string, boolean>> = Object.freeze({
	// Plan 01 — evaluator architectural upgrades
	"harness.evaluator.wrapper_normalization": true,
	"harness.evaluator.span_classification": true,
	"harness.evaluator.keyword_quick_reject": true,
	"harness.evaluator.dual_engine_regex": true,
	"harness.evaluator.allowlist_expiry": true,
	// Plan 02 — destructive command rules
	"harness.rules.destructive_v1_extras": true,
	// Plan 03 — resource-bomb rules
	"harness.rules.resource_bomb": true,
	// Plan 04 — UBS quality checks (top 10 in Phase 1)
	"harness.checks.ubs_critical_tier": true,
	"harness.checks.ubs_warning_tier": true,
	"harness.checks.ubs_advisory_tier": false,
	// Plan 05 — trajectory state machine (Phase 2; dark for Phase 1)
	"harness.trajectory.tool_loop": false,
	"harness.trajectory.destructive_sequence": false,
	"harness.trajectory.unbackedoff_retry": false,
	"harness.trajectory.silent_stall": false,
	// Plan 06/07 — impact analysis (Phase 2; dark for Phase 1)
	"harness.impact_analysis.pagerank": false,
	"harness.impact_analysis.cycle_detection": false,
	// Plan 09 — PreCompact reminder
	"harness.compact_reminder.enabled": true,
	// Plan 10 — exit code envelope
	"harness.exit_codes.envelope": true,
	// Plan 11 — bench instrumentation
	"harness.bench.section_timing": true,
});

/**
 * Look up a feature flag by dotted path. Resolution order:
 *
 * 1. Override in `config.harness` (nested by path segment).
 * 2. Default in `FEATURE_DEFAULTS`.
 * 3. `false` (unknown keys are off — dark-ship safety).
 *
 * Pass `config` explicitly on the hot path; the default `readSharedConfig()`
 * call hits disk every invocation.
 */
export function isFeatureEnabled(
	path: string,
	config: SharedConfig | null = readSharedConfig(),
): boolean {
	const override = config?.harness
		? readHarnessOverride(config.harness, path)
		: undefined;
	if (override !== undefined) return override;
	const fallback = FEATURE_DEFAULTS[path];
	return fallback ?? false;
}

/**
 * Walk `config.harness` along a dotted feature path and return the boolean
 * override stored there, or `undefined` when the path has no boolean leaf.
 */
function readHarnessOverride(
	harness: FeatureNode,
	path: string,
): boolean | undefined {
	const segments = path.split(".");
	// Path always starts with "harness."; skip the first segment.
	if (segments[0] !== "harness") return undefined;
	let cursor: boolean | FeatureNode | null | undefined = harness;
	for (let i = 1; i < segments.length; i++) {
		// `null` is a legal on-disk branch value; the predicate folds the
		// typeof + null checks so the walk reads as "still a branch?".
		if (!isFeatureNode(cursor)) return undefined;
		cursor = cursor[segments[i] as string];
		if (cursor === undefined || cursor === null) break;
	}
	return typeof cursor === "boolean" ? cursor : undefined;
}

function writeLocalConfig(config: LocalConfig, cwd?: string): void {
	writeJson(getLocalConfigPath(cwd), config);
}

function readLegacyConfig(cwd?: string): LegacySession | null {
	return readJsonFile<LegacySession>(getLegacyConfigPath(cwd));
}

/**
 * Check if config directory exists and has been initialized.
 */
export function isConfigured(cwd?: string): boolean {
	return existsSync(getSharedConfigPath(cwd));
}

/**
 * Check if a legacy .claude/interlinked-session.json exists.
 */
export function hasLegacyConfig(cwd?: string): boolean {
	return existsSync(getLegacyConfigPath(cwd));
}

/**
 * Resolve full config by merging shared + local, with defaults.
 * Uses `active_server` (default "production") to pick the right server entry,
 * ensuring server_url, workspace_id, and mcp_prefix are always paired.
 */
export function resolveConfig(cwd?: string): ResolvedConfig {
	const shared = readSharedConfig(cwd);
	const local = readLocalConfig(cwd);

	const env = resolveConfigEnvOverrides();
	const activeServer = resolveActiveServerEntry(local, env.envServerUrl);
	const resolvedSyncMode = resolveSyncMode(local, env.envSyncMode);

	return {
		server_url:
			env.envServerUrl || activeServer?.server_url || shared?.server_url || DEFAULT_SERVER,
		workspace_id: env.envWorkspaceId || activeServer?.workspace_id || local?.workspace_id,
		mcp_prefix: env.envMcpPrefix || activeServer?.mcp_prefix || local?.mcp_prefix,
		agent_name: env.envAgentName || local?.agent_name,
		access_token: env.envAccessToken || local?.access_token,
		refresh_token: local?.refresh_token,
		token_expires_at: local?.token_expires_at,
		oauth_client_id: local?.oauth_client_id,
		agent_handle: local?.agent_handle,
		default_workspace_key: shared?.default_workspace_key,
		default_project: shared?.default_project,
		sync_mode: resolvedSyncMode,
	};
}

/**
 * Get the active server key from local config.
 * Returns "production" if not explicitly set.
 */
export function getActiveServerKey(cwd?: string): string {
	const local = readLocalConfig(cwd);
	return local?.active_server || "production";
}

/**
 * Update a subset of the local config (merge, not replace).
 */
export function updateLocalConfig(updates: Partial<LocalConfig>, cwd?: string): void {
	const existing = readLocalConfig(cwd) || {};
	let mergedServers = existing.servers;
	if (updates.servers) {
		mergedServers = { ...(existing.servers || {}) };
		for (const [serverKey, serverEntry] of Object.entries(updates.servers)) {
			mergedServers[serverKey] = {
				...(mergedServers[serverKey] || {}),
				...serverEntry,
			};
		}
	}
	writeLocalConfig(
		{
			...existing,
			...updates,
			...(mergedServers ? { servers: mergedServers } : {}),
		},
		cwd,
	);
}

/**
 * Migrate legacy .claude/interlinked-session.json to .interlinked/ format.
 * Returns true if migration was performed.
 */
export function migrateLegacyConfig(cwd?: string): boolean {
	const legacy = readLegacyConfig(cwd);
	if (!legacy) return false;

	// Create shared config
	const shared: SharedConfig = {
		version: 1,
		server_url: legacy.server_url || DEFAULT_SERVER,
	};

	// Merge into existing local config (preserve active_server and other fields)
	const existing = readLocalConfig(cwd) || {};
	const local: LocalConfig = {
		...existing,
		agent_name: legacy.agent_name || existing.agent_name,
		mcp_prefix: legacy.mcp_prefix || existing.mcp_prefix,
		workspace_id: legacy.workspace_uuid || existing.workspace_id,
		agent_handle: legacy.agent_handle || existing.agent_handle,
	};

	// Migrate multi-server config if present
	if (legacy.servers) {
		local.servers = { ...existing.servers };
		for (const [name, entry] of Object.entries(legacy.servers)) {
			local.servers[name] = {
				...local.servers[name],
				server_url: entry.server_url,
				mcp_prefix: entry.mcp_prefix,
				workspace_id: entry.workspace_uuid,
			};
		}
	}

	writeSharedConfig(shared, cwd);
	writeLocalConfig(local, cwd);
	return true;
}

/**
 * Initialize a fresh config with sensible defaults.
 *
 * Re-runnable on already-configured projects (`interlinked enable
 * --server ...` calls this whether the project is fresh or already set
 * up). Preserve every shared field set by sibling commands so a re-init
 * does not silently erase a deliberate setting:
 *  - `mode`: persisted by `interlinked harness mode <budget|quality|ci>`.
 *    A re-init that lost it would regenerate the hook with the default
 *    quality timeout and the daemon would re-enable heavy checks.
 *  - `skip_paths`: team-shared globs the user opted into.
 *  - `pii_patterns` / `pii_opt_in`: extra detector tuning.
 *  - `harness` (feature-flag tree): release-pinned flags.
 *
 * Anything written outside this allow-list is a NEW shared field that
 * must be added here when introduced — there's no general "merge any
 * key" rule because some fields are deliberately scoped to local-only.
 */
export function initConfig(
	options: { serverUrl?: string; agentName?: string; mcpPrefix?: string },
	cwd?: string,
): void {
	const existingShared = readSharedConfig(cwd);
	const existingLocal = readLocalConfig(cwd) || {};

	const shared: SharedConfig = {
		version: 1,
		server_url: options.serverUrl || existingShared?.server_url || DEFAULT_SERVER,
		...(existingShared?.default_workspace_key
			? { default_workspace_key: existingShared.default_workspace_key }
			: {}),
		...(existingShared?.default_project
			? { default_project: existingShared.default_project }
			: {}),
		...(existingShared?.mode ? { mode: existingShared.mode } : {}),
		...(existingShared?.skip_paths ? { skip_paths: existingShared.skip_paths } : {}),
		...(existingShared?.pii_patterns ? { pii_patterns: existingShared.pii_patterns } : {}),
		...(existingShared?.pii_opt_in ? { pii_opt_in: existingShared.pii_opt_in } : {}),
		...(existingShared?.harness ? { harness: existingShared.harness } : {}),
	};
	writeSharedConfig(shared, cwd);

	if (options.agentName || options.mcpPrefix) {
		const local: LocalConfig = { ...existingLocal };
		if (options.agentName) local.agent_name = options.agentName;
		if (options.mcpPrefix) local.mcp_prefix = options.mcpPrefix;
		writeLocalConfig(local, cwd);
	}
}
