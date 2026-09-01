// ===========================================
// `.interlinked/config.json` loader
// ===========================================
// Distinct from `cli/src/lib/config.ts` (multi-server CLI config). This
// schema covers harness-level settings: per-tool-class budgets, daemon
// tuning, runner-enablement, and optional cloud opt-in metadata.
// See docs/design/free-cli-architecture.md §"Configuration file schemas".

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
import type { ToolClassBudgets } from "./evaluator-unified.js";
import type { RunnerId } from "./unified-event.js";

export interface InterlinkedConfig {
	schema_version: "1";
	binary_version: string;
	workspace_id: string | null;
	runners_enabled: RunnerId[];
	daemon: {
		auto_start: boolean;
		idle_shutdown_ms: number;
		log_level: "debug" | "info" | "warn" | "error";
		tsgo_enabled: boolean;
	};
	tool_classes: ToolClassBudgets;
	cloud: {
		enabled: boolean;
		product: "guardrails" | "agent-ci" | null;
		portal_url: string | null;
		token_env: string | null;
	};
}

export const DEFAULT_CONFIG: InterlinkedConfig = {
	schema_version: "1",
	binary_version: "0.0.0",
	workspace_id: null,
	runners_enabled: ["claude-code", "copilot-cli"],
	daemon: {
		auto_start: true,
		idle_shutdown_ms: 900_000,
		log_level: "info",
		tsgo_enabled: true,
	},
	tool_classes: {
		read_budget_ms: 300,
		modify_budget_ms: 800,
		side_effect_budget_ms: 2000,
		long_running_budget_ms: 5000,
		unknown_budget_ms: 800,
	},
	cloud: {
		enabled: false,
		product: null,
		portal_url: null,
		token_env: null,
	},
};

/** Discover and load `.interlinked/config.json` under `cwd`. Returns the
 *  defaults merged with whatever was found; absent or malformed files never
 *  raise. Validation errors go to stderr but do not block the caller. */
export function loadInterlinkedConfig(cwd: string): InterlinkedConfig {
	const path = join(cwd, ".interlinked", "config.json");
	if (!existsSync(path)) return DEFAULT_CONFIG;
	const text = readSafe(path);
	if (text === null) return DEFAULT_CONFIG;
	const raw = parseSafe(text, path);
	if (raw === null) return DEFAULT_CONFIG;
	return mergeConfig(DEFAULT_CONFIG, raw);
}

/** Merge a parsed raw object over the defaults. Fields with wrong types are
 *  silently replaced with the default — cautious parsing. */
export function mergeConfig(base: InterlinkedConfig, raw: unknown): InterlinkedConfig {
	if (raw == null || typeof raw !== "object") return base;
	const obj = raw as JsonObject;
	return {
		schema_version: "1",
		binary_version: pickString(obj.binary_version, base.binary_version),
		workspace_id: pickStringOrNull(obj.workspace_id, base.workspace_id),
		runners_enabled: pickRunners(obj.runners_enabled, base.runners_enabled),
		daemon: mergeDaemon(obj.daemon, base.daemon),
		tool_classes: mergeBudgets(obj.tool_classes, base.tool_classes),
		cloud: mergeCloud(obj.cloud, base.cloud),
	};
}

// -----------------------------------------------------------------------------
// Section mergers
// -----------------------------------------------------------------------------

function mergeDaemon(raw: unknown, base: InterlinkedConfig["daemon"]): InterlinkedConfig["daemon"] {
	if (raw == null || typeof raw !== "object") return base;
	const obj = raw as JsonObject;
	return {
		auto_start: pickBool(obj.auto_start, base.auto_start),
		idle_shutdown_ms: pickNumber(obj.idle_shutdown_ms, base.idle_shutdown_ms),
		log_level: pickLogLevel(obj.log_level, base.log_level),
		tsgo_enabled: pickBool(obj.tsgo_enabled, base.tsgo_enabled),
	};
}

function mergeBudgets(raw: unknown, base: ToolClassBudgets): ToolClassBudgets {
	if (raw == null || typeof raw !== "object") return base;
	const obj = raw as JsonObject;
	return {
		read_budget_ms: pickNumber(obj.read_budget_ms, base.read_budget_ms),
		modify_budget_ms: pickNumber(obj.modify_budget_ms, base.modify_budget_ms),
		side_effect_budget_ms: pickNumber(obj.side_effect_budget_ms, base.side_effect_budget_ms),
		long_running_budget_ms: pickNumber(obj.long_running_budget_ms, base.long_running_budget_ms),
		unknown_budget_ms: pickNumber(obj.unknown_budget_ms, base.unknown_budget_ms),
	};
}

function mergeCloud(raw: unknown, base: InterlinkedConfig["cloud"]): InterlinkedConfig["cloud"] {
	if (raw == null || typeof raw !== "object") return base;
	const obj = raw as JsonObject;
	return {
		enabled: pickBool(obj.enabled, base.enabled),
		product: pickCloudProduct(obj.product, base.product),
		portal_url: pickStringOrNull(obj.portal_url, base.portal_url),
		token_env: pickStringOrNull(obj.token_env, base.token_env),
	};
}

// -----------------------------------------------------------------------------
// Small coercion helpers
// -----------------------------------------------------------------------------

function pickString(v: unknown, fallback: string): string {
	return typeof v === "string" ? v : fallback;
}

function pickStringOrNull(v: unknown, fallback: string | null): string | null {
	if (v === null) return null;
	return typeof v === "string" ? v : fallback;
}

function pickBool(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}

function pickNumber(v: unknown, fallback: number): number {
	if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
	return fallback;
}

function pickLogLevel(
	v: unknown,
	fallback: InterlinkedConfig["daemon"]["log_level"],
): InterlinkedConfig["daemon"]["log_level"] {
	return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : fallback;
}

const VALID_RUNNERS: readonly RunnerId[] = [
	"claude-code",
	"copilot-cli",
	"codex",
	"gemini-cli",
	"cursor",
	"opencode",
	"opencode2",
	"pi",
	"unknown",
];

function pickRunners(v: unknown, fallback: RunnerId[]): RunnerId[] {
	if (!Array.isArray(v)) return fallback;
	const entries: readonly unknown[] = v;
	const out: RunnerId[] = [];
	for (const e of entries) {
		if (typeof e === "string" && (VALID_RUNNERS as readonly string[]).includes(e)) {
			out.push(e as RunnerId);
		}
	}
	return out.length > 0 ? out : fallback;
}

function pickCloudProduct(
	v: unknown,
	fallback: InterlinkedConfig["cloud"]["product"],
): InterlinkedConfig["cloud"]["product"] {
	if (v === null) return null;
	return v === "guardrails" || v === "agent-ci" ? v : fallback;
}

function readSafe(path: string): string | null {
	let text = "";
	let ok = true;
	try {
		text = readFileSync(path, "utf-8");
	} catch (err) {
		ok = false;
		process.stderr.write(`[interlinked] could not read ${path}: ${(err as Error).message}\n`);
	}
	return ok ? text : null;
}

function parseSafe(text: string, path: string): unknown {
	let parsed: unknown = null;
	let ok = true;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		ok = false;
		process.stderr.write(
			`[interlinked] could not parse ${path} (${(err as Error).message}); using defaults\n`,
		);
	}
	return ok ? parsed : null;
}
