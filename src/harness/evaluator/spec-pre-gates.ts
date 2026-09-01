// Spec pre-gates (docs/design/spec-audit-runtime-checks.md §3.3 Pre policy,
// spike 5): PreToolUse guards over the shared spec ledger for markdown
// writes. Three gates, strictly ordered by FP profile:
//
//   1. Declared-marker drift INTRODUCTION → decision "ask" (the one
//      pre_block-grade spec event: exact-match markers, zero-FP).
//   2. Deleting a heading other files link to → warning.
//   3. Introducing new cross-file drift findings → warning.
//
// Evidence and refusal only — the gates never rewrite content (§6.2). All
// gates fail open when the ledger hasn't been built yet (it arms on the
// first markdown edit's PostToolUse phase).

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { getSharedSpecLedger } from "../server/spec-ledger-phase.js";
import { extractSpecFacts } from "../spec/extract-facts.js";
import type { SpecLedger } from "../spec/ledger.js";
import type { SpecFacts } from "../spec/types.js";
import { isSpecEligibleFile } from "../spec/types.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";

/** realpath with fallback to the input for not-yet-existing paths — canonicalizes
 *  symlink aliases so the rel key matches the ledger's (sol-max #4). */
function canonical(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
/** Max pre-warnings appended per event. */
const MAX_PRE_WARNINGS = 3;

interface EditShape {
	old_string?: unknown;
	new_string?: unknown;
	replace_all?: unknown;
}

/** Projected post-write content, or null when it can't be computed safely. */
export function projectAfterContent(
	toolName: string,
	toolInput: JsonObject,
	before: string,
): string | null {
	if (toolName === "Write") {
		return typeof toolInput.content === "string" ? toolInput.content : null;
	}
	// toolInput comes from the untrusted tool-call payload (agent/hook JSON), so
	// individual edit entries can genuinely be null/undefined at runtime despite
	// the `as` cast below asserting EditShape — the !e guard is load-bearing.
	const edits: (EditShape | null | undefined)[] =
		toolName === "Edit"
			? [toolInput]
			: Array.isArray(toolInput.edits)
				? (toolInput.edits as (EditShape | null | undefined)[])
				: [];
	let after = before;
	for (const e of edits) {
		// A malformed (e.g. null) edit element returns null, not a throw (sol-max
		// #25): the contract is "unsafe projection → null".
		if (!e || typeof e.old_string !== "string" || typeof e.new_string !== "string") {
			return null;
		}
		if (!after.includes(e.old_string)) return null;
		after =
			e.replace_all === true
				? after.split(e.old_string).join(e.new_string)
				: after.replace(e.old_string, e.new_string);
	}
	return after;
}

/** One changed marker's conflict evidence line, or null. The round-5 #2
 *  rule: a CHANGED value that conflicts with some other file fires — even
 *  when the name was already disputed; converging onto a value another
 *  file already holds never fires (healing is the desired move). */
function markerConflict(
	ledger: SpecLedger,
	rel: string,
	beforeVals: Map<string, Set<string>>,
	fact: { name: string; value: string },
): string | null {
	// "Unchanged" = this value was ALREADY declared for the name before the
	// edit (sol-max #2: a Map<name,value> collapsed multiple prior values to the
	// last, so an unchanged value in a legacy self-conflict looked newly set).
	if (beforeVals.get(fact.name)?.has(fact.value)) return null;
	const others = ledger.declaredFactValuesElsewhere(fact.name, rel);
	if (others.size === 0 || others.has(fact.value)) return null;
	return `  - fact:${fact.name} — this write sets "${fact.value}"; other files hold ${[...others].map((v) => `"${v}"`).join(", ")}`;
}

/** Map of declared-fact name → set of distinct values in one file's content. */
function valuesByName(facts: SpecFacts): Map<string, Set<string>> {
	const byName = new Map<string, Set<string>>();
	for (const f of facts.declaredFacts) {
		const set = byName.get(f.name);
		if (set) set.add(f.value);
		else byName.set(f.name, new Set([f.value]));
	}
	return byName;
}

/** Same-file conflict: the edited content itself declares one marker NAME with
 *  two different values (round-2 #17) — bypasses the cross-file check, so catch
 *  it directly. INTRODUCED-only (round-broaden sol #1): a name that was ALREADY
 *  self-conflicting before this edit must not block unrelated edits to the file
 *  (the introduced-only PreToolUse contract). */
function selfConflict(afterFacts: SpecFacts, beforeFacts?: SpecFacts): string | null {
	const before = beforeFacts ? valuesByName(beforeFacts) : new Map<string, Set<string>>();
	for (const [name, values] of valuesByName(afterFacts)) {
		if (values.size <= 1) continue;
		// Introduced-only (sol-max #3): fire only when the edit adds a value not
		// present before — an unchanged pre-existing self-conflict must not block,
		// but WORSENING it with a third contradictory value must.
		const beforeVals = before.get(name) ?? new Set<string>();
		if ([...values].every((v) => beforeVals.has(v))) continue;
		return `  - fact:${name} — this write declares it with conflicting values ${[...values].map((v) => `"${v}"`).join(", ")} in the same file`;
	}
	return null;
}

/** Evidence lines for every marker this edit pushes into conflict. */
function collectMarkerConflicts(
	ledger: SpecLedger,
	rel: string,
	beforeFacts: SpecFacts,
	afterFacts: SpecFacts,
): string[] {
	const beforeVals = valuesByName(beforeFacts);
	const conflicts: string[] = [];
	const self = selfConflict(afterFacts, beforeFacts);
	if (self) conflicts.push(self);
	for (const fact of afterFacts.declaredFacts) {
		if (conflicts.length >= MAX_PRE_WARNINGS) break;
		const line = markerConflict(ledger, rel, beforeVals, fact);
		if (line) conflicts.push(line);
	}
	return conflicts;
}

/** Gate 1: introduced declared-marker conflict blocks (ask). */
function checkIntroducedMarkerDrift(
	ledger: SpecLedger,
	rel: string,
	beforeFacts: SpecFacts,
	afterFacts: SpecFacts,
): HarnessDecision | null {
	const conflicts = collectMarkerConflicts(ledger, rel, beforeFacts, afterFacts);
	if (conflicts.length === 0) return null;
	return {
		decision: "ask",
		reason:
			`[interlinked:spec-marker][proven] This write changes a declared fact marker to a value that conflicts with other files:\n${conflicts.join("\n")}\n` +
			`Update every site of the fact (or the source of truth first), then retry. Declared markers are the zero-FP spec family; one-sided edits are the canonical drift-introduction move.`,
	};
}

/** Gate 2: deleting a heading that other files link to → warning. */
function warnRemovedAnchors(
	ledger: SpecLedger,
	rel: string,
	beforeSlugs: Set<string>,
	afterSlugs: Set<string>,
	warnings: string[],
): void {
	const removed = new Set([...beforeSlugs].filter((s) => !afterSlugs.has(s)));
	if (removed.size === 0) return;
	const referrers = ledger.externalReferrersTo(rel, removed);
	if (referrers.length === 0) return;
	const shown = referrers
		.slice(0, MAX_PRE_WARNINGS)
		.map((r) => `${r.file}:${r.line} (#${r.anchor})`)
		.join(", ");
	warnings.push(
		`[interlinked:spec-xref][proven] This edit removes heading anchor(s) other files link to: ${shown}${referrers.length > MAX_PRE_WARNINGS ? ` +${referrers.length - MAX_PRE_WARNINGS} more` : ""}. Update those references (or restore the heading) — they dangle the moment this lands.`,
	);
}

/** Gate 3: the edit introduces new cross-file drift → warning. */
/** Structural key ignoring line numbers, so merely SHIFTING an existing
 *  finding's line is not reported as newly introduced drift (round-2 #16). */
function driftKey(f: { kind: string; file: string; message: string }): string {
	return `${f.kind}\x00${f.file}\x00${f.message.replace(/:\d+/g, ":N")}`;
}

function warnIntroducedDrift(
	ledger: SpecLedger,
	preview: SpecLedger,
	rel: string,
	warnings: string[],
): void {
	const current = new Set(ledger.computeDrift(rel).map(driftKey));
	// Declared markers and anchor/file existence are compiler/parser-exact →
	// [proven]; count/range census binding is heuristic (sol-max #20).
	const PROVEN_KINDS = new Set([
		"declared_fact_drift",
		"xref_missing_anchor",
		"xref_missing_file",
	]);
	// Dedup introduced findings vs each other before capping (sol-max #21) so
	// repeated identical drift can't consume the warning budget.
	const seen = new Set<string>();
	const introduced = preview.computeDrift(rel).filter((f) => {
		const k = driftKey(f);
		if (current.has(k) || seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	for (const f of introduced.slice(0, MAX_PRE_WARNINGS)) {
		const tag = PROVEN_KINDS.has(f.kind) ? "[proven]" : "[heuristic]";
		warnings.push(
			`[interlinked:spec-drift]${tag} this write introduces cross-file drift — ${f.message}`,
		);
	}
}

/**
 * GUARD: markdown writes vs the spec ledger. Returns an "ask" decision only
 * for introduced declared-marker drift; everything else appends warnings.
 */
export function evaluateSpecPreGates(
	event: HarnessEvent,
	toolName: string,
	rules: GuardRulesConfig,
	warnings: string[],
): HarnessDecision | null {
	// The effective config governs this phase (deep-round #5): hot-reloaded
	// or locally-merged spec_checks.enabled:false disables asks AND warnings.
	if (rules.spec_checks?.enabled === false) return null;
	if (!WRITE_TOOLS.has(toolName)) return null;
	const toolInput = (event.tool_input ?? {}) as Record<string, unknown>;
	const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
	if (!filePath || !isSpecEligibleFile(filePath)) return null;
	const ledger = getSharedSpecLedger();
	if (!ledger) return null;
	const rel = relative(canonical(ledger.repoRoot), canonical(filePath))
		.split("\\")
		.join("/");
	if (rel.startsWith("..")) return null;
	try {
		const before = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
		const after = projectAfterContent(toolName, toolInput, before);
		if (after === null || after === before) return null;
		const beforeFacts = extractSpecFacts(before, rel);
		const afterFacts = extractSpecFacts(after, rel);
		const blocked = checkIntroducedMarkerDrift(ledger, rel, beforeFacts, afterFacts);
		if (blocked) return { ...blocked, warnings };
		const preview = ledger.previewWithFile(rel, after);
		warnRemovedAnchors(
			ledger,
			rel,
			new Set(beforeFacts.headings.map((h) => h.slug)),
			new Set(afterFacts.headings.map((h) => h.slug)),
			warnings,
		);
		warnIntroducedDrift(ledger, preview, rel, warnings);
	} catch {
		// Advisory pre-gates fail open on any I/O or projection error — the
		// PostToolUse phase re-checks against what actually landed.
		return null;
	}
	return null;
}
