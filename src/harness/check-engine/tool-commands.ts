// ===========================================
// Tool Commands — project-defined argv overrides
// ===========================================
// `.interlinked/tool-commands.json` (team, committed) +
// `.interlinked/tool-commands.local.json` (personal, gitignored) let a
// project pin the EXACT argv Interlinked spawns for its build, lint, and
// test tools — e.g. `go build -tags 'dev devaccounts' ./...` so Interlinked's
// checks share the dev server's Go build cache.
//
// Trust split mirrors guard-rules merge.ts (QUALITY_CHECK_SAFE_FIELDS):
//   - TEAM file (`tool-commands.json`) may only set `base_args` for a known
//     tool. The executable is the runner's fixed binary, so a malicious PR
//     cannot inject an arbitrary command — flags only, same tier as a
//     committed Makefile.
//   - LOCAL file (`tool-commands.local.json`) is personal and trusted; it may
//     set `command` (full argv, arbitrary executable) and `env` as well.
// A personal override wins wholesale over the team entry for the same key.
//
// Validation philosophy: unknown TOOL keys are allowed (forward compat — a
// newer config on an older binary) and reported as "not available on this
// version"; unknown FIELDS inside a known entry are schema errors surfaced by
// `interlinked doctor` via toolCommandConfigIssues().

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_CATALOG } from "./tool-catalog.js";
import type { ResolvedToolCommand, ToolCommandConfig } from "./types.js";

/** Hard per-run cap in ms that project config cannot exceed (mirrors the
 *  heavy-process lease design). */
export const HARD_TOOL_TIMEOUT_CAP_MS = 600_000;

const TEAM_FILE = "tool-commands.json";
const LOCAL_FILE = "tool-commands.local.json";

/** Fields a TOOL entry may carry (any tier). */
const ALLOWED_FIELDS = new Set(["command", "base_args", "env", "timeout_ms"]);

/** Fields the TEAM (committed) tier may set — `base_args` (flags for a fixed
 *  binary) and `timeout_ms` (a bounded cap, never executable — mirrors
 *  QUALITY_CHECK_SAFE_FIELDS, which allows team timeout_ms). `command` would
 *  let a malicious PR execute an arbitrary binary on every developer machine,
 *  and `env` can rewire the runtime; both stay personal-tier. */
const TEAM_ALLOWED_FIELDS = new Set(["base_args", "timeout_ms"]);

// ===========================================
// Loading + trust split
// ===========================================

function readToolCommandsFile(cwd: string, file: string): Record<string, ToolCommandConfig> {
	const path = join(cwd, ".interlinked", file);
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		// Canonical shape: `{ "version": 1, "tool_commands": { "<tool>": {...} } }`.
		// A flat map (`{ "<tool>": {...} }`) is tolerated for backwards friendliness.
		const section: unknown =
			(parsed as Record<string, unknown>).tool_commands ??
			parsed;
		if (section === null || typeof section !== "object" || Array.isArray(section)) return {};
		const out: Record<string, ToolCommandConfig> = {};
		for (const [key, value] of Object.entries(section)) {
			// Entries must be objects; anything else is skipped (reported by
			// toolCommandConfigIssues when the file parses at all).
			if (value !== null && typeof value === "object" && !Array.isArray(value)) {
				out[key] = value as ToolCommandConfig;
			}
		}
		return out;
	} catch {
		return {};
	}
}

function allowTeamFields(entry: ToolCommandConfig): ToolCommandConfig {
	const out: ToolCommandConfig = {};
	for (const field of TEAM_ALLOWED_FIELDS) {
		const value = entry[field as keyof ToolCommandConfig];
		if (value !== undefined) {
			(out as Record<string, unknown>)[field] = value;
		}
	}
	return out;
}

/** Merged two-tier view: team entries are field-whitelisted to `base_args`,
 *  local entries are trusted, and a local entry wins wholesale over team. */
export function loadToolCommands(cwd: string): Record<string, ToolCommandConfig> {
	const merged: Record<string, ToolCommandConfig> = {};
	for (const [key, entry] of Object.entries(readToolCommandsFile(cwd, TEAM_FILE))) {
		merged[key] = allowTeamFields(entry);
	}
	for (const [key, entry] of Object.entries(readToolCommandsFile(cwd, LOCAL_FILE))) {
		merged[key] = entry;
	}
	return merged;
}

// ===========================================
// Resolution + argv assembly
// ===========================================

/** Convert a raw config entry into its resolved form (timeout capped). */
export function toResolvedToolCommand(entry: ToolCommandConfig): ResolvedToolCommand {
	const timeoutMs =
		entry.timeout_ms === undefined
			? undefined
			: Math.min(Math.max(0, entry.timeout_ms), HARD_TOOL_TIMEOUT_CAP_MS);
	const out: ResolvedToolCommand = {
		...(Array.isArray(entry.command) && entry.command.length > 0
			? { argv: entry.command }
			: {}),
		baseArgs: Array.isArray(entry.base_args) ? entry.base_args : [],
		...(entry.env && typeof entry.env === "object" && Object.keys(entry.env).length > 0
			? { env: entry.env }
			: {}),
		...(timeoutMs !== undefined && timeoutMs > 0 ? { timeoutMs } : {}),
	};
	return out;
}

/** First config-name alias for a tool id (see TOOL_CATALOG `configNames`).
 *  Returns undefined for tools with no config-name alias (e.g. lizard). */
export function configNameForTool(toolId: string): string | undefined {
	const row = TOOL_CATALOG.find((entry) => entry.id === toolId);
	return row?.configNames?.[0];
}

/**
 * Assemble the argv a runner should spawn.
 *
 * Merge rule: a full `command` override wins outright; otherwise the runner's
 * FIXED prefix (binary + subcommand, e.g. `go build`) is followed by the
 * configured `base_args` — which REPLACE the runner's default scope (e.g.
 * `./...`) rather than being appended after it, so projects keep full control
 * of ordering (Go tool flags must precede the package pattern). An entry with
 * no base_args falls back to the default scope.
 */
export function buildToolCommandArgv(
	override: ResolvedToolCommand | undefined,
	prefix: readonly string[],
	defaultScope: readonly string[],
): string[] {
	if (!override) return [...prefix, ...defaultScope];
	if (override.argv) return override.argv;
	const scope = override.baseArgs.length > 0 ? override.baseArgs : defaultScope;
	return [...prefix, ...scope];
}

/** Resolve the override for one config name at a project root (or undefined
 *  when the tool has no tool-commands entry). */
export function resolveToolCommand(
	cwd: string,
	configName: string,
	prefix: readonly string[],
	defaultScope: readonly string[],
): ResolvedToolCommand | undefined {
	const entry = loadToolCommands(cwd)[configName];
	if (!entry) return undefined;
	return toResolvedToolCommand(entry);
}

// ===========================================
// Validation (doctor-facing)
// ===========================================

export interface ToolCommandsIssue {
	file: "team" | "local";
	key: string;
	message: string;
}

/** Validation issues across both tiers for `interlinked doctor`. Unknown
 *  TOOL keys are forward-compat (not errors); unknown FIELDS and cross-tier
 *  trust violations are. */
export function toolCommandConfigIssues(cwd: string): ToolCommandsIssue[] {
	const issues: ToolCommandsIssue[] = [];
	for (const [tier, file, trusted] of [
		["team", TEAM_FILE, false],
		["local", LOCAL_FILE, true],
	] as const) {
		const entries = readToolCommandsFile(cwd, file);
		for (const [key, entry] of Object.entries(entries)) {
			for (const field of Object.keys(entry)) {
				if (!ALLOWED_FIELDS.has(field)) {
					issues.push({
						file: tier,
						key,
						message: `unknown field "${field}" (allowed: command, base_args, env, timeout_ms)`,
					});
				} else if (!trusted && field !== "base_args") {
					issues.push({
						file: tier,
						key,
						message: `"${field}" is personal-tier only — move it to .interlinked/tool-commands.local.json`,
					});
				}
			}
			if (entry.base_args !== undefined && !Array.isArray(entry.base_args)) {
				issues.push({ file: tier, key, message: "base_args must be an array of strings" });
			}
			if (entry.command !== undefined && !Array.isArray(entry.command)) {
				issues.push({ file: tier, key, message: "command must be an array of strings" });
			}
			if (
				entry.env !== undefined &&
				(entry.env === null || typeof entry.env !== "object" || Array.isArray(entry.env))
			) {
				issues.push({ file: tier, key, message: "env must be an object of string values" });
			}
			if (
				entry.timeout_ms !== undefined &&
				(typeof entry.timeout_ms !== "number" || entry.timeout_ms <= 0)
			) {
				issues.push({ file: tier, key, message: "timeout_ms must be a positive number" });
			}
		}
	}
	return issues;
}