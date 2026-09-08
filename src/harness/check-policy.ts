// ===========================================
// Check Policy — per-check action + scope configuration
// ===========================================
// Loads .interlinked/check-policy.json (team) + .local.json (personal overrides),
// merges them against built-in defaults derived from the check-registry, and
// resolves an effective action for every check at evaluation time.
//
// Actions (weakest → strongest, see docs inline for semantics):
//   silent | info | warn_after | warn_before | ratchet | ask | block_preview | auto_fix
//
// Scopes:
//   diff (current default — only lines changed in this edit)
//   touched_file (entire file, if this session has edited it)
//   project (every file — used by `verify --all-checks`)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isCheckPolicyFile } from "./check-policy-values.js";
import { CHECK_REGISTRY } from "./check-registry/registry.js";
import type { CheckPhase, CheckRegistration } from "./check-registry/types.js";
import { getPreset, isKnownMode, type ModeName } from "./modes.js";

// ===========================================
// Types
// ===========================================

export type CheckAction =
	| "silent"
	| "info"
	| "warn_after"
	| "warn_before"
	| "ratchet"
	| "ask"
	| "block_preview"
	| "auto_fix";

export type CheckScope = "diff" | "touched_file" | "project";

export interface CheckCondition {
	/** Glob patterns that paths must match for the rule to apply. */
	paths?: string[];
	/** Regex against current git branch; rule only fires when branch matches. */
	branch?: string;
	/** For escalations: apply after this many prior warnings for the same check. */
	after_warnings_gte?: number;
}

export interface CheckPolicyEntry {
	action?: CheckAction;
	scope?: CheckScope;
	when?: CheckCondition;
	/**
	 * Optional escalation: "when the action has been triggered N times, switch
	 * to this stronger action." Used to turn repeat-offender warnings into
	 * blocks without blocking first-time offenses.
	 */
	escalate?: {
		after_warnings_gte: number;
		then: CheckAction;
	};
}

export interface CheckPolicyDefaults {
	action: CheckAction;
	scope: CheckScope;
}

export interface CoverageRatchetConfig {
	enabled: boolean;
	per_file: boolean;
	/** Allow per-file coverage to drop by at most this many percentage points. */
	allow_decrease_pct: number;
}

export interface MutationGateConfig {
	enabled: boolean;
	/** Minimum mutation score (0.0–1.0). */
	min_score: number;
	schedule: "pre_commit" | "pre_push" | "weekly" | "manual";
}

export interface CheckPolicy {
	version: 1;
	/** Named mode preset currently in effect. `custom` = user-authored policy
	 *  with no preset applied. Defaults to `balanced`. */
	mode: ModeName;
	defaults: CheckPolicyDefaults;
	checks: Record<string, CheckPolicyEntry>;
	coverage_ratchet: CoverageRatchetConfig;
	mutation_gate: MutationGateConfig;
}

/** Minimal shape of the on-disk JSON — everything optional, validated on load. */
export interface CheckPolicyFile {
	version?: number;
	mode?: string;
	defaults?: Partial<CheckPolicyDefaults>;
	checks?: Record<string, CheckPolicyEntry>;
	overrides?: Record<string, CheckPolicyEntry>; // .local.json uses "overrides"
	coverage_ratchet?: Partial<CoverageRatchetConfig>;
	mutation_gate?: Partial<MutationGateConfig>;
}

// ===========================================
// Defaults
// ===========================================

export const DEFAULT_POLICY: CheckPolicy = {
	version: 1,
	mode: "balanced",
	defaults: { action: "warn_after", scope: "diff" },
	checks: {},
	coverage_ratchet: { enabled: false, per_file: true, allow_decrease_pct: 0 },
	mutation_gate: { enabled: false, min_score: 0.6, schedule: "weekly" },
};

/**
 * Derive a default action from a check's registration (severity + phase),
 * preserving today's observable behavior when no user policy is present.
 */
export function defaultActionFor(check: CheckRegistration): CheckAction {
	switch (check.phase) {
		case "pre_block":
			return "ask"; // current behavior: PreToolUse asks for user confirmation
		case "pre_warn":
			return "warn_before";
		case "post":
			return "warn_after";
	}
}

/** Which phase a given action effectively fires at. */
export function actionToPhase(action: CheckAction): CheckPhase | null {
	switch (action) {
		case "silent":
			return null; // excluded entirely
		case "info":
		case "warn_after":
			return "post";
		case "warn_before":
		case "ratchet":
			return "pre_warn";
		case "ask":
		case "block_preview":
		case "auto_fix":
			return "pre_block";
	}
}

// ===========================================
// Loading
// ===========================================

/** Two-tier load: team + local overrides, mirroring rules-loader. */
export function loadCheckPolicy(cwd: string = process.cwd()): CheckPolicy {
	const policy: CheckPolicy = {
		...DEFAULT_POLICY,
		defaults: { ...DEFAULT_POLICY.defaults },
		checks: {},
		coverage_ratchet: { ...DEFAULT_POLICY.coverage_ratchet },
		mutation_gate: { ...DEFAULT_POLICY.mutation_gate },
	};

	const teamPath = join(cwd, ".interlinked", "check-policy.json");
	const localPath = join(cwd, ".interlinked", "check-policy.local.json");

	applyPolicyFile(policy, readPolicyFile(teamPath));
	applyPolicyFile(policy, readPolicyFile(localPath));

	return policy;
}

/** Apply a mode preset's overrides onto a policy in place. The policy's
 *  existing `checks` entries (user overrides) take precedence over the
 *  preset, so users can pick a mode and still tweak individual checks.
 *  Exported so the `mode` command can materialize presets at write time. */
export function applyModePreset(policy: CheckPolicy, mode: ModeName): void {
	policy.mode = mode;
	const preset = getPreset(mode);
	if (!preset) return;
	if (preset.default_action) {
		policy.defaults.action = preset.default_action;
	}
	for (const [checkId, action] of Object.entries(preset.check_overrides)) {
		if (!policy.checks[checkId]?.action) {
			policy.checks[checkId] = { ...policy.checks[checkId], action };
		}
	}
}

function readPolicyFile(path: string): CheckPolicyFile | null {
	if (!existsSync(path)) return null;
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return isCheckPolicyFile(value) ? value : null;
	} catch {
		// Best-effort: ignore malformed policy files. Surfaced elsewhere via
		// `interlinked harness status`, which should validate and report.
		return null;
	}
}

function applyPolicyFile(policy: CheckPolicy, file: CheckPolicyFile | null): void {
	if (!file) return;
	// 1. Mode preset first so explicit per-check entries in the same file
	//    win over the preset defaults.
	if (typeof file.mode === "string" && isKnownMode(file.mode)) {
		applyModePreset(policy, file.mode);
	}
	if (file.defaults) {
		if (file.defaults.action) policy.defaults.action = file.defaults.action;
		if (file.defaults.scope) policy.defaults.scope = file.defaults.scope;
	}
	// Local files use `overrides`; team uses `checks`. Accept both for flexibility.
	const entries = { ...(file.checks || {}), ...(file.overrides || {}) };
	for (const [id, entry] of Object.entries(entries)) {
		policy.checks[id] = { ...policy.checks[id], ...entry };
	}
	if (file.coverage_ratchet) {
		policy.coverage_ratchet = { ...policy.coverage_ratchet, ...file.coverage_ratchet };
	}
	if (file.mutation_gate) {
		policy.mutation_gate = { ...policy.mutation_gate, ...file.mutation_gate };
	}
}

// ===========================================
// Resolution
// ===========================================

export interface ResolvedAction {
	action: CheckAction;
	scope: CheckScope;
	phase: CheckPhase | null;
	/** Track whether the action came from policy or the registration default. */
	source: "policy" | "default";
}

/**
 * Resolve the effective action for a check given current policy.
 * Never returns null — falls through to the registration default.
 */
export function resolveAction(check: CheckRegistration, policy: CheckPolicy): ResolvedAction {
	const entry = policy.checks[check.id];
	const action = entry?.action ?? defaultActionFor(check);
	const scope = entry?.scope ?? policy.defaults.scope;
	return {
		action,
		scope,
		phase: actionToPhase(action),
		source: entry?.action ? "policy" : "default",
	};
}

/**
 * Summary for `interlinked harness status`: how many checks are at each
 * action level. Gives the user a single glance at total friction budget.
 *
 * Registry is parameterized so callers can audit subsets or test against
 * a fixture registry without reaching into the CHECK_REGISTRY constant.
 */
export function summarizePolicy(
	policy: CheckPolicy,
	registry: readonly CheckRegistration[] = CHECK_REGISTRY,
): Record<CheckAction, number> {
	const counts: Record<CheckAction, number> = {
		silent: 0,
		info: 0,
		warn_after: 0,
		warn_before: 0,
		ratchet: 0,
		ask: 0,
		block_preview: 0,
		auto_fix: 0,
	};
	for (const check of registry) {
		const resolved = resolveAction(check, policy);
		counts[resolved.action]++;
	}
	return counts;
}
