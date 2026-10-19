// ===========================================
// Literal-context gate — degrade data-only guard matches to a warning
// ===========================================
// Wires `literal-context.ts` into the PreToolUse destructive-rule loop. A
// Bash rule whose action would stop the call (`block`, `ask`,
// `soft_block`) is re-tested against the command with every data-only
// region blanked. If no positive pattern still matches, the rule fired
// ONLY on text the command treats as data (a `harness test` argument, a
// grep pattern, a string in a `node -e` self-test), so the decision becomes
// a warning instead. Negated (exception) patterns are ignored in the
// re-test on purpose: dropping exceptions can only make the masked command
// match more often, so it can only keep more blocks, never remove one.

import type { JsonObject } from "../../lib/json-types.js";
import { evaluateCompoundCommand } from "../command-decomposition.js";
import type { MatchRuleFn } from "../command-rule-dispatch.js";
import type { GuardRule } from "../types.js";
import { type LiteralRegion, literalContextRegions, maskLiteralContext } from "./literal-context.js";
import { getCachedRegex, getField, projectForPattern } from "./rule-matching.js";
import { isBash } from "./tool-classifiers.js";

export interface LiteralGate {
	raw: string;
	masked: string;
	regions: LiteralRegion[];
}

const DEGRADABLE_ACTIONS: ReadonlySet<string> = new Set(["block", "ask", "soft_block"]);

/** Public API — the masked view of a Bash command, or null when the command
 *  has no data-only region (or the tool is not a shell). */
export function literalGateFor(toolName: string, cmd: string): LiteralGate | null {
	if (!cmd || !isBash(toolName)) return null;
	const regions = literalContextRegions(cmd);
	if (regions.length === 0) return null;
	const masked = maskLiteralContext(cmd, regions);
	return masked === cmd ? null : { raw: cmd, masked, regions };
}

/** Public API — memoize {@link literalGateFor} so the parse runs at most once
 *  per tool call, and only when a stopping rule actually matched. */
export function lazyLiteralGate(toolName: string, cmd: string): () => LiteralGate | null {
	let cached: LiteralGate | null | undefined;
	return () => {
		if (cached === undefined) cached = literalGateFor(toolName, cmd);
		return cached;
	};
}

function anyPositiveMatches(rule: GuardRule, input: JsonObject, fallback: string): boolean {
	const positives = rule.patterns.filter((p) => !p.negate);
	if (positives.length === 0) return true;
	return positives.some((p) => {
		const value: unknown = getField(input, p.field) || fallback;
		if (!value) return false;
		return getCachedRegex(p.regex, p.flags ?? "i").test(projectForPattern(String(value), p));
	});
}

/** Contexts of the regions that overlap the rule's first raw match. */
function contextsHit(rule: GuardRule, gate: LiteralGate): string[] {
	const labels = new Set<string>();
	for (const p of rule.patterns) {
		if (p.negate) continue;
		const m = getCachedRegex(p.regex, p.flags ?? "i").exec(gate.raw);
		if (!m) continue;
		const end = m.index + m[0].length;
		for (const r of gate.regions) if (r.start < end && m.index < r.end) labels.add(r.context);
	}
	if (labels.size === 0) for (const r of gate.regions) labels.add(r.context);
	return [...labels];
}

/** Public API — the stable prefix of a literal-gate warning for one rule, so
 *  the rule loop and the compound pass emit at most one warning per rule. */
export function literalWarningPrefix(ruleId: string): string {
	return `[interlinked:guard] rule ${ruleId} matched inside a string literal (`;
}

/** Public API — the warning text for a rule degraded by the literal gate. */
export function formatLiteralWarning(ruleId: string, contexts: string[]): string {
	return `${literalWarningPrefix(ruleId)}${contexts.join("; ")}); not blocked — the text is data, not an executed command`;
}

/** Public API — a warning when `rule` would stop the call but matches only
 *  inside data-only regions; null when the decision must stand. */
export function literalOnlyWarning(
	rule: GuardRule,
	matchInput: JsonObject,
	getGate: () => LiteralGate | null,
): string | null {
	if (!DEGRADABLE_ACTIONS.has(rule.action)) return null;
	const gate = getGate();
	if (!gate) return null;
	if (anyPositiveMatches(rule, { ...matchInput, command: gate.masked }, gate.masked)) return null;
	return formatLiteralWarning(rule.id, contextsHit(rule, gate));
}

/** Public API — the compound-decomposition twin of {@link literalOnlyWarning}:
 *  a per-subcommand block on `cmd` degrades to a warning only when the SAME
 *  decomposition of the masked command no longer blocks. The masked result's
 *  rewrites are discarded — the agent's command is never replaced by it. */
export function compoundLiteralWarning(
	toolName: string,
	cmd: string,
	ruleId: string | undefined,
	rules: GuardRule[],
	extraExceptions: Record<string, string[]> | undefined,
	matcher: MatchRuleFn,
): string | null {
	const gate = literalGateFor(toolName, cmd);
	if (!gate) return null;
	const masked = evaluateCompoundCommand(gate.masked, rules, extraExceptions, matcher);
	if (masked.decision === "block") return null;
	return formatLiteralWarning(ruleId ?? "compound-subcommand", [...new Set(gate.regions.map((r) => r.context))]);
}
