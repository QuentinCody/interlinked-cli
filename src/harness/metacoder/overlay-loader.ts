// ===========================================
// Metacoder — Overlay loader
// ===========================================
// Validates an LLM-emitted `OverlayRulesEmission` against the floor / overlay
// tighten-only invariant from docs/design/metacoding-agent-plan.md §2.3, and
// loads the persisted overlay JSON for a given session.
//
// Pure validation (`validateOverlayEmission`) is tested directly. The on-disk
// reader (`loadOverlayForSession`) is a thin try/parse wrapper around it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
	ActiveWhen,
	AfterCommandSpec,
	AgentSource,
	GuardRule,
	PhaseSpec,
	RulePattern,
	SessionPredicateSpec,
} from "../types.js";
import { sanitizeSessionId } from "../session-paths.js";
import { validateOverlayPatternCount, validateOverlayRegex } from "./regex-validator.js";
import type { MetacoderConfig } from "./types.js";

/** Returned by validation. `addendum` is the (possibly truncated) free-form
 *  `system_prompt_addendum` from the emission. `rules` are surviving
 *  GuardRule entries to merge after the floor. `warnings` are
 *  `[interlinked:overlay]`-style strings the server can surface. */
export interface OverlayValidationResult {
	rules: GuardRule[];
	warnings: string[];
	addendum?: string;
}

/** Location of a session overlay on disk: filesystem root + the session id
 *  that scopes the overlay directory. Kept as a struct so callers cannot
 *  accidentally swap `cwd` and `sessionId` — both are strings. */
export interface SessionLocation {
	cwd: string;
	sessionId: string;
}

/** Inputs the validator needs to enforce the tighten-only invariant. */
export interface ValidationOpts {
	floorRuleIds: ReadonlySet<string>;
	sessionId: string;
	config: MetacoderConfig;
}

/** Combined inputs for reading + validating an overlay from disk. */
export interface LoadOpts extends ValidationOpts {
	cwd: string;
}

/** Compute the canonical overlay id namespace prefix for a session.
 *  Overlay rule ids MUST start with this prefix; collisions with floor ids
 *  are rejected.
 *
 *  Uses the first 12 chars of the sanitized session id (sanitizer already
 *  whitelists [A-Za-z0-9_-]). Stable for the same input — important because
 *  the metacoder emits id prefixes based on this. */
export function overlayIdPrefix(sessionId: string): string {
	const safe = sanitizeSessionId(sessionId) || "unknown";
	const slug = safe.slice(0, 12);
	return `overlay:${slug}:`;
}

/** Validate an LLM-emitted overlay against the tighten-only invariant.
 *  Returns surviving rules + warnings. Never throws on malformed input;
 *  malformed entries are dropped with a warning, and the rest of the
 *  emission still loads. */
export function validateOverlayEmission(
	emission: unknown,
	opts: ValidationOpts,
): OverlayValidationResult {
	const warnings: string[] = [];
	if (!isPlainObject(emission)) {
		return { rules: [], warnings: ["emission is not a JSON object"], addendum: undefined };
	}
	const e = emission as Record<string, unknown>;

	if (e.version !== OVERLAY_SCHEMA_VERSION) {
		warnings.push(`unsupported version ${JSON.stringify(e.version)}; expected ${OVERLAY_SCHEMA_VERSION}`);
		return { rules: [], warnings, addendum: undefined };
	}

	collectDroppedRelaxFields(e, warnings);

	const rawRules = Array.isArray(e.rules) ? e.rules : [];
	if (!Array.isArray(e.rules) && e.rules !== undefined) {
		warnings.push("rules field is not an array");
	}

	// Plan §reviewer-P1 (round 5): cap the loop by the RAW emitted count,
	// not by survivor count. A runaway model that emits 500 invalid rules
	// would otherwise force us to compile up to (500 × max_patterns_per_rule)
	// regexes while waiting for survivors to reach the cap that they never
	// will. Slice up-front so validation cost is O(max_rules), independent
	// of how many bad rules the model dumps.
	const inputCount = rawRules.length;
	const cappedRules =
		inputCount > opts.config.max_rules ? rawRules.slice(0, opts.config.max_rules) : rawRules;
	if (inputCount > opts.config.max_rules) {
		warnings.push(
			`emitted ${inputCount} rules; cap is ${opts.config.max_rules}; ${inputCount - opts.config.max_rules} dropped pre-validation`,
		);
	}

	const ctx: RuleValidationContext = {
		overlayPrefix: overlayIdPrefix(opts.sessionId),
		floorRuleIds: opts.floorRuleIds,
		config: opts.config,
		warnings,
	};
	const survivors: GuardRule[] = [];
	for (let i = 0; i < cappedRules.length; i++) {
		const validated = validateSingleRule(cappedRules[i], i, ctx);
		if (validated) survivors.push(validated);
	}

	const addendum = pickAddendum(e.system_prompt_addendum, opts.config, warnings);
	return { rules: survivors, warnings, addendum };
}

/** Public API — consumed by `src/harness/rules-loader.ts` to merge the
 *  session overlay onto the floor rules. Read and validate
 *  `.interlinked/sessions/<sid>/overlay-rules.json`. Returns `null` when
 *  the file doesn't exist (typical case: no metacoder has run yet). Returns
 *  an empty `rules` array with warnings on parse / validation failure —
 *  never throws. */
export function loadOverlayForSession(opts: LoadOpts): OverlayValidationResult | null {
	const path = overlayRulesPath({ cwd: opts.cwd, sessionId: opts.sessionId });
	if (!path || !existsSync(path)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		return {
			rules: [],
			warnings: [`overlay-rules.json parse failed: ${err instanceof Error ? err.message : String(err)}`],
			addendum: undefined,
		};
	}
	return validateOverlayEmission(raw, {
		floorRuleIds: opts.floorRuleIds,
		sessionId: opts.sessionId,
		config: opts.config,
	});
}

/** Public API — consumed by `metacoder-writer.ts` to compute the atomic
 *  write target. Returns the absolute path to a session's
 *  `overlay-rules.json`, or `null` when the session id sanitizes to empty. */
export function overlayRulesPath(loc: SessionLocation): string | null {
	const safe = sanitizeSessionId(loc.sessionId);
	if (!safe) return null;
	return join(loc.cwd, ".interlinked", "sessions", safe, "overlay-rules.json");
}

// ============================================================================
// Single-rule validation
// ============================================================================

const OVERLAY_SCHEMA_VERSION = 1;
const VALID_ACTIONS_FOR_OVERLAY = new Set<GuardRule["action"]>(["block"]);
const VALID_TRIGGERS = new Set<GuardRule["trigger"]>(["PreToolUse", "PostToolUse", "both"]);
const VALID_SEVERITIES = new Set<GuardRule["severity"]>(["critical", "high", "medium", "low"]);
const DEFAULT_OVERLAY_TRIGGER: GuardRule["trigger"] = "PreToolUse";
const DEFAULT_OVERLAY_SEVERITY: GuardRule["severity"] = "medium";

interface RuleValidationContext {
	overlayPrefix: string;
	floorRuleIds: ReadonlySet<string>;
	config: MetacoderConfig;
	warnings: string[];
}

interface PatternLocation {
	ruleIndex: number;
	patternIndex: number;
}

function validateSingleRule(
	raw: unknown,
	index: number,
	ctx: RuleValidationContext,
): GuardRule | null {
	if (!isPlainObject(raw)) {
		ctx.warnings.push(`rules[${index}] is not an object`);
		return null;
	}
	const r = raw as Record<string, unknown>;

	const id = validateRuleId(r, index, ctx);
	if (id === null) return null;

	if (!isAllowedOverlayAction(r.action)) {
		ctx.warnings.push(
			`rules[${index}] action '${String(r.action)}' not allowed in overlay (only 'block')`,
		);
		return null;
	}

	const patterns = validateRulePatterns(r, index, ctx);
	if (patterns === null) return null;

	if (!validateRuleActiveWhen(r, index, ctx)) return null;

	const rule: GuardRule = {
		id,
		enabled: r.enabled !== false,
		trigger: pickTrigger(r.trigger),
		tool_match: pickToolMatch(r.tool_match),
		action: "block",
		patterns,
		reason: typeof r.reason === "string" ? r.reason : `Overlay rule ${id}`,
		severity: pickSeverity(r.severity),
	};
	// Plan §reviewer-P3: previously the loader validated active_when but
	// dropped it on the return path, so scoped overlay rules fired
	// session-wide instead of only on their declared axes.
	const activeWhen = pickActiveWhen(r.active_when);
	if (activeWhen !== undefined) rule.active_when = activeWhen;
	return rule;
}

function collectDroppedRelaxFields(
	e: Record<string, unknown>,
	warnings: string[],
): void {
	if ("disabled_rules" in e) {
		warnings.push("dropped disabled_rules field — overlays cannot relax floor rules");
	}
	if ("extra_exceptions" in e) {
		warnings.push(
			"dropped extra_exceptions field — overlays use negate:true patterns inside the rule",
		);
	}
	if ("additional_patterns" in e) {
		warnings.push(
			"dropped additional_patterns field — overlays use negate:true patterns inside the rule",
		);
	}
}

function pickAddendum(
	raw: unknown,
	config: MetacoderConfig,
	warnings: string[],
): string | undefined {
	if (typeof raw !== "string") return undefined;
	if (raw.length > config.max_addendum_chars) {
		warnings.push(
			`system_prompt_addendum truncated from ${raw.length} to ${config.max_addendum_chars} chars`,
		);
		return raw.slice(0, config.max_addendum_chars);
	}
	return raw;
}

function validateRuleId(
	r: Record<string, unknown>,
	index: number,
	ctx: RuleValidationContext,
): string | null {
	const id = typeof r.id === "string" ? r.id : "";
	if (!id) {
		ctx.warnings.push(`rules[${index}] missing id`);
		return null;
	}
	if (ctx.floorRuleIds.has(id)) {
		ctx.warnings.push(
			`rules[${index}] id '${id}' collides with a floor rule — overlay cannot replace floor`,
		);
		return null;
	}
	if (!id.startsWith(ctx.overlayPrefix)) {
		ctx.warnings.push(
			`rules[${index}] id '${id}' missing required prefix '${ctx.overlayPrefix}'`,
		);
		return null;
	}
	return id;
}

function isAllowedOverlayAction(action: unknown): action is "block" {
	return typeof action === "string" && VALID_ACTIONS_FOR_OVERLAY.has(action as GuardRule["action"]);
}

function validateRulePatterns(
	r: Record<string, unknown>,
	index: number,
	ctx: RuleValidationContext,
): RulePattern[] | null {
	if (!Array.isArray(r.patterns)) {
		// Plan §reviewer-P1 (round 4): the matcher treats zero positive
		// patterns as vacuously matching (see `rule-matching.ts::evaluatePatterns`),
		// so a rule missing `patterns` entirely turns into a global block on
		// every tool call. Reject the rule outright — overlay rules MUST
		// declare what they match.
		ctx.warnings.push(`rules[${index}] missing or non-array patterns`);
		return null;
	}
	const patterns = r.patterns;
	const patternCountFailure = validateOverlayPatternCount(patterns.length, ctx.config);
	if (patternCountFailure) {
		ctx.warnings.push(`rules[${index}] patterns: ${patternCountFailure.reason}`);
		return null;
	}

	const validated: RulePattern[] = [];
	let positiveCount = 0;
	for (let p = 0; p < patterns.length; p++) {
		const compiled = validateOnePattern(
			patterns[p],
			{ ruleIndex: index, patternIndex: p },
			ctx,
		);
		if (compiled === null) return null;
		validated.push(compiled);
		if (!compiled.negate) positiveCount++;
	}
	// Plan §reviewer-P1 (round 4): a rule with zero positive patterns (only
	// `negate: true` patterns, or an empty array) matches every input
	// because the positive predicate is vacuously true. Combined with the
	// default `tool_match: ["*"]`, that turns into a global block. Require
	// at least one positive pattern so the overlay narrows the input
	// before any exception can apply.
	if (positiveCount === 0) {
		ctx.warnings.push(
			`rules[${index}] requires at least one positive (non-negate) pattern; got ${patterns.length} pattern(s), none positive`,
		);
		return null;
	}
	return validated;
}

function validateOnePattern(
	pat: unknown,
	loc: PatternLocation,
	ctx: RuleValidationContext,
): RulePattern | null {
	if (!isPlainObject(pat)) {
		ctx.warnings.push(`rules[${loc.ruleIndex}].patterns[${loc.patternIndex}] is not an object`);
		return null;
	}
	const patObj = pat as Record<string, unknown>;
	const field = typeof patObj.field === "string" ? patObj.field : "";
	const regex = typeof patObj.regex === "string" ? patObj.regex : "";
	const flags = typeof patObj.flags === "string" ? patObj.flags : undefined;
	const negate = patObj.negate === true;
	if (!field) {
		ctx.warnings.push(`rules[${loc.ruleIndex}].patterns[${loc.patternIndex}] missing field`);
		return null;
	}
	const regexFailure = validateOverlayRegex(regex, flags, ctx.config);
	if (regexFailure) {
		ctx.warnings.push(
			`rules[${loc.ruleIndex}].patterns[${loc.patternIndex}].regex rejected: ${regexFailure.reason}`,
		);
		return null;
	}
	return { field, regex, flags, negate };
}

function validateRuleActiveWhen(
	r: Record<string, unknown>,
	index: number,
	ctx: RuleValidationContext,
): boolean {
	if (!isPlainObject(r.active_when)) return true;
	const activeWhen = r.active_when as Record<string, unknown>;
	// active_when.file_scope is matched against arbitrary file_path strings
	// inside `evaluator/active-when.ts`, so it carries the same ReDoS risk
	// as patterns[].regex. Same validation.
	if (typeof activeWhen.file_scope === "string") {
		const failure = validateOverlayRegex(activeWhen.file_scope, "i", ctx.config);
		if (failure) {
			ctx.warnings.push(
				`rules[${index}].active_when.file_scope regex rejected: ${failure.reason}`,
			);
			return false;
		}
	}
	// Plan §reviewer-P2 (round 4): `evaluator/active-when.ts::evaluateAfterCommandAxis`
	// compiles `after_command.pattern` with `new RegExp(pattern, flags)` and
	// no try/catch. An LLM-emitted `{ pattern: "[" }` throws on every
	// PreToolUse once the session has command history; a ReDoS shape hangs
	// the hook. Same validation as `patterns[].regex` — drop the rule fail-
	// open instead of letting it crash the evaluator at use time.
	if (isPlainObject(activeWhen.after_command)) {
		const ac = activeWhen.after_command as Record<string, unknown>;
		if (typeof ac.pattern === "string") {
			const failure = validateOverlayRegex(ac.pattern, "i", ctx.config);
			if (failure) {
				ctx.warnings.push(
					`rules[${index}].active_when.after_command.pattern regex rejected: ${failure.reason}`,
				);
				return false;
			}
		}
	}
	return true;
}

function pickTrigger(raw: unknown): GuardRule["trigger"] {
	if (typeof raw === "string" && VALID_TRIGGERS.has(raw as GuardRule["trigger"])) {
		return raw as GuardRule["trigger"];
	}
	return DEFAULT_OVERLAY_TRIGGER;
}

function pickToolMatch(raw: unknown): string[] {
	if (!Array.isArray(raw)) return ["*"];
	return raw.filter((x): x is string => typeof x === "string");
}

function pickSeverity(raw: unknown): GuardRule["severity"] {
	if (typeof raw === "string" && VALID_SEVERITIES.has(raw as GuardRule["severity"])) {
		return raw as GuardRule["severity"];
	}
	return DEFAULT_OVERLAY_SEVERITY;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Sanitize `r.active_when` to the `ActiveWhen` shape `evaluateActiveWhen`
 *  expects. The regex risk in `file_scope` was already vetted by
 *  `validateRuleActiveWhen`; the other axes (skill, phase, after_command,
 *  overlay, agent_source, predicate) are narrowed field-by-field so the
 *  returned object is structurally typed without `as unknown as` smuggling.
 *  The evaluator validates each axis again at use time. */
function pickActiveWhen(raw: unknown): ActiveWhen | undefined {
	if (!isPlainObject(raw)) return undefined;
	const out: ActiveWhen = {};
	const skill = narrowStringOrStringArray(raw.skill);
	if (skill !== undefined) out.skill = skill;
	const phase = narrowPhaseSpec(raw.phase);
	if (phase !== undefined) out.phase = phase;
	const afterCommand = narrowAfterCommandSpec(raw.after_command);
	if (afterCommand !== undefined) out.after_command = afterCommand;
	if (typeof raw.file_scope === "string") out.file_scope = raw.file_scope;
	const overlay = narrowStringOrStringArray(raw.overlay);
	if (overlay !== undefined) out.overlay = overlay;
	const agentSource = narrowAgentSourceOrArray(raw.agent_source);
	if (agentSource !== undefined) out.agent_source = agentSource;
	const predicate = narrowPredicateSpec(raw.predicate);
	if (predicate !== undefined) out.predicate = predicate;
	return Object.keys(out).length > 0 ? out : undefined;
}

function narrowStringOrStringArray(v: unknown): string | string[] | undefined {
	if (typeof v === "string") return v;
	if (Array.isArray(v) && v.every((x): x is string => typeof x === "string")) return v;
	return undefined;
}

function narrowAgentSourceOrArray(v: unknown): AgentSource | AgentSource[] | undefined {
	const s = narrowStringOrStringArray(v);
	if (s === undefined) return undefined;
	// AgentSource is `"claude" | "copilot" | "codex" | "gemini" | "cursor"`;
	// the evaluator tolerates unknown sources by treating them as "scope
	// never matches", which is the right fail-soft behavior for an LLM-
	// emitted rule. Carry through whatever strings we got.
	return s as AgentSource | AgentSource[];
}

const PHASE_SCOPE_FILE = "file" as const;
const PHASE_SCOPE_SESSION = "session" as const;

function narrowPhaseSpec(v: unknown): PhaseSpec | undefined {
	if (!isPlainObject(v)) return undefined;
	if (typeof v.name !== "string" || typeof v.value !== "string") return undefined;
	const phase: PhaseSpec = { name: v.name, value: v.value };
	if (v.scope === PHASE_SCOPE_FILE || v.scope === PHASE_SCOPE_SESSION) {
		phase.scope = v.scope;
	}
	return phase;
}

function narrowAfterCommandSpec(v: unknown): AfterCommandSpec | undefined {
	if (!isPlainObject(v)) return undefined;
	if (typeof v.pattern !== "string") return undefined;
	const out: AfterCommandSpec = { pattern: v.pattern };
	if (typeof v.window_steps === "number") out.window_steps = v.window_steps;
	return out;
}

function narrowPredicateSpec(v: unknown): SessionPredicateSpec | undefined {
	if (!isPlainObject(v)) return undefined;
	if (typeof v.name !== "string") return undefined;
	const out: SessionPredicateSpec = { name: v.name };
	if (isPlainObject(v.args)) out.args = v.args;
	return out;
}
