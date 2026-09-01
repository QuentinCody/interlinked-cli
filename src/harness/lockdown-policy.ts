// ===========================================
// Untrusted-context lockdown policy (PR-N1)
// ===========================================
//
// Sibling of `lethal_trifecta_structural` (sequence-checks/injection.ts), but
// a stricter posture: the lethal-trifecta detector requires all THREE legs of
// Simon Willison's lethal trifecta (private data + untrusted content +
// external comm) before blocking. Lockdown fires on TWO of three legs
// (untrusted content + external comm) and additionally upgrades existing
// injection-family `pre_warn` findings to `pre_block`.
//
// Lockdown is a policy layer on top of the deterministic sequence detectors:
// it consumes their output and the trajectory state, and produces (a) an
// upgraded copy of selected findings and (b) optionally a new finding of its
// own. The dispatcher itself is unchanged.
//
// See `docs/design/trajectories-as-primitive.md` §4.1.7 (the design memo for
// this module) and the headline lethal-trifecta detector in
// `src/harness/sequence-checks/injection.ts` for the structural sibling.
//
// Contract:
//   - Pure function. No fs I/O, no mutation of inputs, no side effects.
//   - Determinism: derived entirely from trajectory shape + tool input,
//     parity with the sequence-detector family (which is always
//     `fully_deterministic`).
//   - The caller is responsible for plugging the returned upgraded /
//     emitted findings back into the dispatch path. This module only
//     decides; it does not mutate dispatch output in place.

import type { JsonObject } from "../lib/json-types.js";
import type {
	SequenceDetectorFamily,
	SequenceFinding,
} from "./sequence-checks/types.js";
import type {
	HarnessEvent,
	SessionTrajectory,
	TaintProvenance,
} from "./types.js";

// ============================================================
// Configuration
// ============================================================

/**
 * Lockdown configuration. Surfaced through `.interlinked` config (wiring
 * happens in `pre-tool.ts` — owned by the main agent for this PR).
 */
export interface LockdownConfig {
	/** Master switch — when false, evaluateLockdown returns no upgrades / emissions. */
	enabled: boolean;
	/**
	 * When true, auto-activate lockdown whenever the session has any
	 * untrusted-provenance taint source, regardless of `enabled`.
	 */
	auto_activate_on_untrusted: boolean;
	/**
	 * When lockdown is active, upgrade these families' pre_warn findings
	 * to pre_block. Defaults to ["injection"].
	 */
	upgrade_families?: ReadonlyArray<"injection" | "security-shape">;
}

/** Built-in default — lockdown off; injection-only upgrades when activated. */
export const DEFAULT_LOCKDOWN_CONFIG: LockdownConfig = {
	enabled: false,
	auto_activate_on_untrusted: false,
	upgrade_families: ["injection"],
};

// ============================================================
// Internals
// ============================================================

/** Provenance values that mark a taint source as untrusted (parity with
 *  `UNTRUSTED_PROVENANCE` in `sequence-checks/injection.ts`). */
const UNTRUSTED_PROVENANCE: ReadonlySet<TaintProvenance> = new Set<TaintProvenance>([
	"fetched_external",
	"mcp_remote",
	"document_content",
	"user_provided",
]);

/** Non-localhost http(s) URL — parity with `NON_LOCALHOST_HTTP_URL`
 *  in `sequence-checks/injection.ts`. localhost / loopback is dev-server
 *  traffic and not exfiltration-capable. */
const NON_LOCALHOST_HTTP_URL =
	/https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\[::1\])[^\s'"]+/i;

/** MCP tool-name shape: `mcp__<server>__<tool>`. */
const MCP_TOOL_NAME = /^mcp__.*__/;

/** Generic URL detector for MCP tool inputs (any http(s) URL). MCP servers
 *  by definition reach across a network boundary; localhost MCP servers are
 *  uncommon enough that we treat any URL-bearing input as external. */
const URL_IN_TEXT = /https?:\/\/[^\s'"]+/i;

/** True when the trajectory contains any taint source with untrusted
 *  provenance. */
function hasUntrustedTaint(trajectory: Readonly<SessionTrajectory>): boolean {
	return trajectory.taint_sources.some((s) =>
		UNTRUSTED_PROVENANCE.has(s.provenance),
	);
}

/** Pull a string command out of a Bash tool input, or empty string. */
function getCommand(toolInput: { command?: unknown } | undefined): string {
	if (!toolInput) return "";
	const cmd = toolInput.command;
	return typeof cmd === "string" ? cmd : "";
}

/** True when ANY top-level string value of the tool input contains a URL.
 *  Used for MCP tools — we don't know which field carries the URL, so we
 *  scan the shallow surface. (Deep traversal is unnecessary: MCP tool
 *  schemas keep URLs at the top of the input object in practice.) */
function inputContainsUrl(
	toolInput: JsonObject | undefined,
): boolean {
	if (!toolInput) return false;
	for (const value of Object.values(toolInput)) {
		if (typeof value === "string" && URL_IN_TEXT.test(value)) return true;
	}
	return false;
}

/** True when the candidate event is an external-comm tool: Bash with a
 *  non-localhost http(s) URL, WebFetch, or an MCP tool whose input carries
 *  a URL. Mirrors the leg-3 definition of `lethal_trifecta_structural`
 *  with the Bash branch but broader on the WebFetch / MCP side. */
function isExternalCommCandidate(candidate: Readonly<HarnessEvent>): boolean {
	const toolName = candidate.tool_name;
	if (!toolName) return false;
	if (toolName === "WebFetch") return true;
	if (toolName === "Bash") {
		const cmd = getCommand(candidate.tool_input);
		return NON_LOCALHOST_HTTP_URL.test(cmd);
	}
	if (MCP_TOOL_NAME.test(toolName)) {
		return inputContainsUrl(candidate.tool_input as JsonObject | undefined);
	}
	return false;
}

/** Default upgrade-family set (when caller leaves `upgrade_families` undefined). */
const DEFAULT_UPGRADE_FAMILIES: ReadonlyArray<SequenceDetectorFamily> = ["injection"];

// ============================================================
// Public API
// ============================================================

interface LockdownEvaluation {
	/** Whether lockdown is currently active for this (trajectory, candidate). */
	active: boolean;
	/** Input findings whose `phase` was upgraded from `pre_warn` to `pre_block`. */
	upgradedFindings: SequenceFinding[];
	/** Brand-new findings the lockdown policy itself emits. */
	emittedFindings: SequenceFinding[];
}

/**
 * Evaluate lockdown policy against a (trajectory, candidate, sequenceFindings)
 * triple.
 *
 * Pure: never mutates `args.trajectory`, `args.candidate`, or
 * `args.sequenceFindings`. The caller plugs the returned upgraded /
 * emitted findings back into the dispatch path.
 *
 * Activation logic:
 *   - `active = config.enabled` OR
 *     (`config.auto_activate_on_untrusted` AND trajectory has any
 *     untrusted-provenance taint source).
 *   - When not active, returns `{ active: false, upgradedFindings: [],
 *     emittedFindings: [] }`.
 *
 * Upgrade logic (only when active):
 *   - Any input finding whose `family` is in `config.upgrade_families`
 *     (default: `["injection"]`) AND whose `phase === "pre_warn"` is
 *     returned in `upgradedFindings` with `phase: "pre_block"`. Other
 *     fields are unchanged.
 *
 * Emission logic (only when active):
 *   - Emit ONE new finding with `detector_id: "lockdown_active"`,
 *     `family: "injection"`, `phase: "pre_block"` when ALL of:
 *       - Trajectory has untrusted-provenance taint (i.e. the auto-activate
 *         trigger condition is met — regardless of whether activation came
 *         via `enabled` or `auto_activate_on_untrusted`).
 *       - The candidate is an external-comm tool (Bash with non-localhost
 *         URL, WebFetch, or `mcp__*__*` with a URL in the input).
 *       - The input `sequenceFindings` does NOT already include a
 *         `lethal_trifecta_structural` finding (avoid double-up — the
 *         structural detector is the louder, blocking sibling).
 */
export function evaluateLockdown(args: {
	trajectory: Readonly<SessionTrajectory>;
	candidate: Readonly<HarnessEvent>;
	sequenceFindings: ReadonlyArray<SequenceFinding>;
	config: LockdownConfig;
}): LockdownEvaluation {
	const { trajectory, candidate, sequenceFindings, config } = args;

	const untrustedPresent = hasUntrustedTaint(trajectory);
	const active =
		config.enabled || (config.auto_activate_on_untrusted && untrustedPresent);

	if (!active) {
		return { active: false, upgradedFindings: [], emittedFindings: [] };
	}

	const families: ReadonlyArray<SequenceDetectorFamily> =
		config.upgrade_families ?? DEFAULT_UPGRADE_FAMILIES;
	const familySet = new Set<SequenceDetectorFamily>(families);

	const upgradedFindings: SequenceFinding[] = [];
	for (const finding of sequenceFindings) {
		if (finding.phase !== "pre_warn") continue;
		if (!familySet.has(finding.family)) continue;
		upgradedFindings.push({
			detector_id: finding.detector_id,
			family: finding.family,
			match: finding.match,
			phase: "pre_block",
		});
	}

	const emittedFindings: SequenceFinding[] = [];
	const trifectaAlreadyFired = sequenceFindings.some(
		(f) => f.detector_id === "lethal_trifecta_structural",
	);
	if (
		untrustedPresent &&
		!trifectaAlreadyFired &&
		isExternalCommCandidate(candidate)
	) {
		emittedFindings.push({
			detector_id: "lockdown_active",
			family: "injection",
			phase: "pre_block",
			match: {
				prior_event_count: trajectory.taint_sources.filter((s) =>
					UNTRUSTED_PROVENANCE.has(s.provenance),
				).length,
				prior_summary: "untrusted content active; external-comm candidate",
				message:
					"BLOCKED by lockdown policy: external comm while untrusted content active. " +
					"Lockdown is stricter than the lethal-trifecta detector — it fires on 2 of 3 " +
					"legs (untrusted content + external comm), without requiring confidential data " +
					"access. Disable lockdown or break the leg.",
				evidence: trajectory.taint_sources
					.filter((s) => UNTRUSTED_PROVENANCE.has(s.provenance))
					.slice(-3)
					.map((s) => `${s.file} (${s.provenance})`),
			},
		});
	}

	return { active: true, upgradedFindings, emittedFindings };
}
