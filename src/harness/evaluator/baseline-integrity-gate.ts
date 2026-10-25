// Baseline-integrity gate (test-integrity guard, §9.1b of
// docs/design/test-category-adoption-from-the-wild.md).
//
// PreToolUse BLOCK: an agent Write/Edit/MultiEdit that *loosens* a committed
// ratchet water-line under `.interlinked/` is the canonical gate-gaming move —
// lower the bar instead of meeting it, and every ratchet (coverage / mutation /
// per-edit-coverage / large-file cap / untested-file floor / metric caps) falls
// at once. Water-lines may only move in the tightening direction. The harness's
// OWN raises go through internal fs writes (coverage-ratchet.ts, mutation-gate.ts,
// …), never the Write/Edit tool, so they never reach this gate — only a hand-edit
// does. Pure disk-vs-proposed numeric diff; no execution, no LLM, near-zero FP.
//
// The "before" water-line is the current ON-DISK baseline (not git HEAD): most
// baselines are gitignored local state, and the PreToolUse hook fires before the
// write lands, so disk still holds the pre-edit value. Reconstruction of what a
// call leaves lives in baseline-integrity-proposal.ts / edit-reconstruction.ts;
// a target it cannot reconstruct is refused, never allowed.

import { existsSync } from "node:fs";
import { isJsonObject } from "../../lib/json-types.js";
import { resolve } from "node:path";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { type BaselineProposal, baselineProposals } from "./baseline-integrity-proposal.js";
import { readDiskContent } from "./config-loosening-gate.js";
import { canonicalWaterLineText, parseWaterLineJson, postImageDefects } from "../water-line-json.js";
import { detectCoverageEdit } from "./coverage-edit-baseline-integrity.js";
import { detectFunctionComplexityBaseline, detectSiblingBaseline, ledgerCreationBlock } from "./function-complexity-baseline-gate.js";
import { type BaselineKind, baselineKind } from "./baseline-kind.js";
import { detectLintBaselineGaming } from "./lint-baseline-integrity.js";
import { baselineKeyFor, COVERAGE_METRICS } from "../coverage-metric-names.js";
import { detectE2eBaselineGaming, type E2eGuardContext } from "./e2e-baseline-integrity.js";
import { resolveE2eBase } from "../e2e-store.js";
import {
	detectLargeFilesCap,
	detectMetricCaps,
	detectSkippedCap,
	detectUntestedFloor,
	effectiveLargeFilesCap,
	effectiveSkipCap,
	legacyLineCap,
	waterLineRoot,
} from "./effective-caps.js";

export interface BaselineGamingFinding {
	file: string;
	rule: string;
	before: unknown;
	after: unknown;
	message: string;
}

function isNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function asObj(v: unknown): Record<string, unknown> {
	return isJsonObject(v) ? v : {};
}

/** Default predicate: does the repo-relative `rel` source still exist on disk?
 *  Repo root is the path component preceding `/.interlinked/` in the baseline path. */
function makeDefaultSourceExists(baselineFile: string): (rel: string) => boolean {
	const norm = baselineFile.replace(/\\/g, "/");
	const root = norm.slice(0, norm.lastIndexOf("/.interlinked/"));
	return (rel: string) => existsSync(resolve(root, rel));
}

function fmt(file: string, rule: string, before: unknown, after: unknown, message: string): BaselineGamingFinding {
	return { file, rule, before, after, message };
}

// ---- per-file detectors (pure) ------------------------------------------

// Shared shape: a `files` map of {path: {<metric>: number}} whose metrics may
// only rise, and whose entries may only be removed when the source is gone.
function detectRisingMetricMap(
	file: string,
	beforeFiles: Record<string, unknown>,
	afterFiles: Record<string, unknown>,
	metrics: string[],
	label: string,
	exists: (rel: string) => boolean,
): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = [];
	for (const [path, bRaw] of Object.entries(beforeFiles)) {
		const b = asObj(bRaw);
		const aRaw = afterFiles[path];
		if (aRaw === undefined) {
			if (exists(path)) {
				out.push(
					fmt(
						file,
						`${label}:${path}`,
						bRaw,
						undefined,
						`${label}-baseline entry for ${path} removed while the source file still exists. Restore it — the harness raises baselines via internal writes, not hand-edits.`,
					),
				);
			}
			continue;
		}
		const a = asObj(aRaw);
		for (const metric of metrics) {
			const bv = b[metric];
			const av = a[metric];
			if (isNum(bv) && isNum(av) && av < bv) {
				out.push(
					fmt(
						file,
						`${label}:${path}:${metric}`,
						bv,
						av,
						`${label}-baseline ${metric} for ${path} lowered ${bv}→${av}. This water-line may only rise; meet the bar or set INTERLINKED_DISABLE_BASELINE_GUARD=1 for an intentional reset.`,
					),
				);
			}
		}
	}
	return out;
}

// interlinked: defer code_clones -- These existing cap detectors retain distinct policy messages; lint adoption only adds a separate detector.
function detectLargeFiles(file: string, before: unknown, after: unknown): BaselineGamingFinding[] {
	// The cap is compared by the value the runtime would use (effective-caps.ts).
	const out: BaselineGamingFinding[] = detectLargeFilesCap(file, before, after);
	const b = asObj(before);
	const a = asObj(after);
	const effMax = effectiveLargeFilesCap(after);
	const bFiles = asObj(b.files);
	const aFiles = asObj(a.files);
	for (const [path, bcRaw] of Object.entries(bFiles)) {
		const ac = aFiles[path];
		if (isNum(bcRaw) && isNum(ac) && ac > bcRaw) {
			out.push(fmt(file, `grandfather:${path}`, bcRaw, ac, `grandfather high-water for ${path} raised ${bcRaw}→${ac}. A grandfathered file may shrink or hold, never grow.`));
		}
	}
	for (const [path, acRaw] of Object.entries(aFiles)) {
		if (!(path in bFiles) && isNum(acRaw) && acRaw > effMax) {
			out.push(fmt(file, `grandfather-new:${path}`, undefined, acRaw, `new grandfather entry ${path}=${acRaw} exceeds the cap (${effMax}). That pre-authorizes an over-cap file — decompose it instead.`));
		}
	}
	return out;
}

// The skipped-tests water-line (docs/design/test-oracle-integrity.md §4.2):
// the test suite is the oracle every other ratchet depends on, and skips are
// how an agent quietly erodes it. Same directions as large-files: the global
// cap may only tighten, a grandfather ceiling may only shrink, and a NEW
// grandfather entry above the cap pre-authorizes new skips — blocked.
function detectSkippedTests(file: string, before: unknown, after: unknown): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = detectSkippedCap(file, before, after);
	const b = asObj(before);
	const a = asObj(after);
	const effMax = effectiveSkipCap(after);
	const bFiles = asObj(b.files);
	const aFiles = asObj(a.files);
	for (const [path, bcRaw] of Object.entries(bFiles)) {
		const ac = aFiles[path];
		if (isNum(bcRaw) && isNum(ac) && ac > bcRaw) {
			out.push(
				fmt(
					file,
					`grandfather:${path}`,
					bcRaw,
					ac,
					`skipped-tests grandfather for ${path} raised ${bcRaw}→${ac}. A grandfathered file may re-enable tests, never skip more.`,
				),
			);
		}
	}
	for (const [path, acRaw] of Object.entries(aFiles)) {
		if (!(path in bFiles) && isNum(acRaw) && acRaw > effMax) {
			out.push(
				fmt(
					file,
					`grandfather-new:${path}`,
					undefined,
					acRaw,
					`new skipped-tests grandfather entry ${path}=${acRaw} exceeds the cap (${effMax}). That pre-authorizes new skips — re-enable the tests instead.`,
				),
			);
		}
	}
	return out;
}

function detectUntestedFiles(file: string, before: unknown, after: unknown): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = detectUntestedFloor(file, before, after);
	const b = asObj(before);
	const a = asObj(after);
	const bSet = new Set(Array.isArray(b.files) ? b.files : []);
	const aFiles = Array.isArray(a.files) ? a.files : [];
	for (const p of aFiles) {
		if (typeof p === "string" && !bSet.has(p)) {
			out.push(fmt(file, `exempt-added:${p}`, undefined, p, `${p} added to the untested-files exemption list — that exempts a new file from the coverage floor. Cover it instead.`));
		}
	}
	return out;
}

// The Check Evidence Contract grandfather list (docs/design/verification-density-program.md):
// an EXEMPTION list, so the tightening direction is SHRINK. Adding a check id
// exempts that check from having to ship MUST-FIRE / MUST-NOT-FIRE cases —
// which is how a new detector lands with no evidence that it works.
// `enforced` is GROW-ONLY: it names which evidence dimensions currently fail the
// pin. Dropping one silently retires an obligation the repo already met.
function detectEnforcedShrink(file: string, b: Record<string, unknown>, a: Record<string, unknown>): BaselineGamingFinding[] {
	const before = Array.isArray(b.enforced) ? b.enforced : [];
	const after = new Set(Array.isArray(a.enforced) ? a.enforced : []);
	const dropped = before.filter((d): d is string => typeof d === "string" && !after.has(d));
	return dropped.map((dim) =>
		fmt(
			file,
			`enforced-removed:${dim}`,
			dim,
			undefined,
			`check-evidence dropped the "${dim}" dimension from \`enforced\`. Enforcement may only widen — that retires an obligation the repo already satisfies.`,
		),
	);
}

function detectCheckEvidence(file: string, before: unknown, after: unknown): BaselineGamingFinding[] {
	const b = asObj(before);
	const a = asObj(after);
	const out: BaselineGamingFinding[] = detectEnforcedShrink(file, b, a);
    const previousCohort = Array.isArray(b.corpus_cohort) ? b.corpus_cohort : [];
    const currentCohort = new Set(Array.isArray(a.corpus_cohort) ? a.corpus_cohort : []);
    for (const id of previousCohort) {
        if (typeof id === "string" && !currentCohort.has(id)) {
            out.push(fmt(file, `corpus-cohort-removed:${id}`, id, undefined,
                `Removing ${id} from corpus_cohort retires a qualified check's corpus obligation. Review the exact policy change.`));
        }
    }
	const bSet = new Set(Array.isArray(b.exempt) ? b.exempt : []);
	const aList = Array.isArray(a.exempt) ? a.exempt : [];
	for (const id of aList) {
		if (typeof id === "string" && !bSet.has(id)) {
			out.push(
				fmt(
					file,
					`exempt-added:${id}`,
					undefined,
					id,
					`${id} added to the check-evidence exemption list — that exempts a check from shipping MUST-FIRE / MUST-NOT-FIRE cases. Write the cases instead.`,
				),
			);
		}
	}
	return out;
}


// The mutation-manifest's accepted-survivor set (mutants with status survived /
// equivalent) may only SHRINK across a hand-edit (spec §7 of
// docs/design/per-edit-cloud-mutation-testing.md). A mutation run / the reviewed
// `interlinked mutation` CLI records survivors via internal fs writes (bypassing
// this gate); a hand-edit that ADDS one is the gate-gaming move.
function acceptedSurvivorSet(manifest: unknown): Set<string> {
	const out = new Set<string>();
	for (const symbolsRaw of Object.values(asObj(asObj(manifest).files))) {
		for (const symRaw of Object.values(asObj(symbolsRaw))) {
			for (const [mutantId, mRaw] of Object.entries(asObj(asObj(symRaw).mutants))) {
				const status = asObj(mRaw).status;
				if (status === "survived" || status === "equivalent") out.add(mutantId);
			}
		}
	}
	return out;
}

function detectMutationManifest(file: string, before: unknown, after: unknown): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = [];
	const beforeAccepted = acceptedSurvivorSet(before);
	for (const mutantId of acceptedSurvivorSet(after)) {
		if (!beforeAccepted.has(mutantId)) {
			out.push(
				fmt(
					file,
					`accepted-survivor-added:${mutantId}`,
					undefined,
					mutantId,
					`mutant ${mutantId} was hand-added to the accepted-survivor set. New survivors/equivalents may only enter via a mutation run or the reviewed \`interlinked mutation\` CLI (internal writes); a hand-edit silences the gate. The accepted set may only shrink.`,
				),
			);
		}
	}
	return out;
}

/**
 * Public API — pure detector. Returns the loosening findings for a proposed
 * edit to a `.interlinked/` ratchet baseline (empty for non-baseline files,
 * new baselines, a pre-image that is not strict JSON, or safe-direction moves).
 * For an existing water-line, an empty, unparseable, non-object or
 * duplicate-key post-image is itself a finding.
 */
export function detectBaselineGaming(
	filePath: string,
	beforeText: string,
	afterText: string,
	sourceExists?: (rel: string) => boolean,
	e2eContext?: E2eGuardContext,
): BaselineGamingFinding[] {
	const kind = baselineKind(filePath);
	if (kind === "coverage-e2e") return detectE2eBaselineGaming(filePath, beforeText, afterText, e2eContext);
	// The disposition ledger (not a water-line) rides its sibling detector.
	if (!kind) return detectSiblingBaseline(filePath, beforeText, afterText);
	if (!beforeText) return [];
	// ONE strict parser (water-line-json.ts), with the semantics every runtime
	// consumer reads (red team 2026-10-21 round 3: a JSONC-tolerant parse here let
	// a trailing comma, a `//` line or a `/* */`-spanning key pass as "unchanged"
	// while the runtime read no ledger). A pre-image that does not parse holds no
	// water-line the runtime reads, so any post-image of it is a creation.
	const before = parseWaterLineJson(beforeText);
	if (!before.ok) return [];
	const after = parseWaterLineJson(afterText);
	const defects = postImageDefects(before.value, after);
	if (defects.length > 0 || !after.ok) {
		return defects.map((d) => fmt(filePath, postImageRule(kind, before.value, d.rule), before.value, after.ok ? after.value : afterText, `${filePath}: ${d.message}`));
	}
	const exists = sourceExists ?? makeDefaultSourceExists(filePath);
	// Text-reading detectors get canonical text, which a JSONC-tolerant reader
	// decodes to the strict value too, so no detector judges another value.
	const texts = { beforeText: canonicalWaterLineText(before.value), afterText: canonicalWaterLineText(after.value) };
	const root = waterLineRoot(filePath, e2eContext?.root);
	return compareBaseline({ kind, filePath, ...texts, before: before.value, after: after.value, exists, root });
}

/** The effect arm restores a complexity-ledger loosening only when its rule
 *  names a metric section the pre-image held (baseline-effect-guard.ts
 *  `isRecordOnly`). A post-image defect drops EVERY section, so it is filed
 *  under the first one. */
function postImageRule(kind: BaselineKind, before: unknown, rule: string): string {
	if (kind !== "function-complexity") return rule;
	const section = Object.keys(asObj(asObj(before).metrics))[0];
	return section ? `${section}:${rule}` : rule;
}

interface BaselineComparison {
    kind: Exclude<BaselineKind, "coverage-e2e">;
    filePath: string;
    beforeText: string;
    afterText: string;
    before: unknown;
    after: unknown;
    exists: (rel: string) => boolean;
    /** Repository root of the water-line, when it can be known. */
    root: string | null;
}

function compareBaseline(input: BaselineComparison): BaselineGamingFinding[] {
    const { kind, filePath, beforeText, afterText, before, after, exists, root } = input;
	switch (kind) {
		case "coverage":
			return detectRisingMetricMap(filePath, asObj(asObj(before).files), asObj(asObj(after).files), COVERAGE_METRICS.map(baselineKeyFor), "coverage", exists);
		case "mutation":
			return detectRisingMetricMap(filePath, asObj(asObj(before).files), asObj(asObj(after).files), ["score", "killed"], "mutation", exists);
		case "coverage-edit":
			return detectCoverageEdit(filePath, before, after, exists);
		case "large-files":
			return detectLargeFiles(filePath, before, after);
		case "untested-files":
			return detectUntestedFiles(filePath, before, after);
		case "metric-caps":
			// Every cap by the value the runtime would use (effective-caps.ts);
			// `max_lines` falls back to the large-files baseline, then the default.
			return detectMetricCaps(filePath, before, after, legacyLineCap(root));
		case "mutation-manifest":
			return detectMutationManifest(filePath, before, after);
		case "skipped-tests":
			return detectSkippedTests(filePath, before, after);
		case "check-evidence":
			return detectCheckEvidence(filePath, before, after);
		case "function-complexity":
			return detectFunctionComplexityBaseline(filePath, beforeText, afterText);
		case "lint":
			return detectLintBaselineGaming(filePath, before, after);
	}
}

interface BaselineGateDeps {
	getDisk?: (file: string, cwd: string | undefined) => string | null;
}

/**
 * Public API — PreToolUse entry point (wired in pre-tool-guards.ts behind
 * `isContentWriteCandidate`; safe for any tool — non-writers yield nothing). Blocks a
 * write-capable call (Write/Edit/MultiEdit/apply_patch/any alias, or a shell
 * command carrying a V4A patch) that loosens
 * a committed baseline. Allows a non-baseline target, the disable-bypass, or a
 * not-yet-existing baseline. FAILS CLOSED when it cannot reconstruct what the
 * call leaves in an existing gated baseline (red team 2026-10-21: a
 * `replace_all` Edit used to reconstruct as null and pass). Disk is the source
 * of truth (most baselines are gitignored local state); the hook fires before
 * the write lands, so disk still holds the pre-edit water-line. `deps` is injectable.
 */
export function evaluateBaselineIntegrityForEvent(
	event: HarnessEvent,
	deps: BaselineGateDeps = {},
): HarnessDecision | null {
	if (process.env.INTERLINKED_DISABLE_BASELINE_GUARD === "1") return null;
	const getDisk = deps.getDisk ?? readDiskContent;
	// The tool name is classified by the registry (`isWriteCapableToolName`) and
	// every path is resolved against the event cwd inside `baselineProposals`, so
	// this entry point is safe to call for ANY tool: non-writers yield nothing.
	const proposals = baselineProposals(event.tool_name ?? "", event.tool_input ?? {}, (file) => getDisk(file, event.cwd), event.cwd);
	for (const proposal of proposals) {
		const decision = judgeProposal(proposal, event);
		if (decision) return decision;
	}
	return null;
}

function judgeProposal({ filePath, before, proposed }: BaselineProposal, event: HarnessEvent): HarnessDecision | null {
	const kind = baselineKind(filePath);
	if (before === null && kind === "coverage-e2e") return {
		decision: "block", rule_id: "baseline_integrity_gate", severity: "high", category: "config",
		reason: "Create the e2e baseline from a measured passing run: interlinked coverage check --lane e2e --init-baseline",
	};
	// Absent baseline: creating it isn't loosening — except the complexity ledger (ledgerCreationBlock).
	if (before === null) return kind === "function-complexity" ? ledgerCreationBlock(filePath) : null;
	if (proposed.kind === "undecidable") return undecidableBlock(filePath, event.tool_name ?? "this tool", proposed.reason);
	const context = { root: event.cwd ?? process.cwd(), base: resolveE2eBase() };
	const findings = proposed.contents.flatMap((after) => detectBaselineGaming(filePath, before, after, undefined, context));
	if (findings.length === 0) return null;

	const messages = [...new Set(findings.map((f) => `[${f.rule}] ${f.message}`))].join("\n  ");
	return {
		decision: "block",
		reason:
			`BLOCKED: this edit loosens a ratchet baseline in ${filePath}:\n  ${messages}\n\n` +
			"Ratchet water-lines may only move in the tightening direction. The harness raises them itself via internal writes; an agent hand-lowering one defeats every ratchet at once. If this is an intentional reset, set INTERLINKED_DISABLE_BASELINE_GUARD=1.",
		rule_id: "baseline_integrity_gate",
		severity: "high",
		category: "config",
	};
}

/** Fail-closed refusal: the gate cannot tell what this call leaves in a gated baseline. */
function undecidableBlock(filePath: string, toolName: string, why: string): HarnessDecision {
	return {
		decision: "block",
		reason:
			`BLOCKED: the baseline-integrity gate cannot determine what this ${toolName} call would leave in ${filePath} (${why}). ` +
			"A ratchet water-line edit that cannot be judged is refused. Re-issue the change as a Write of the full file content — a Write is always decidable. " +
			"If this is an intentional reset, set INTERLINKED_DISABLE_BASELINE_GUARD=1.",
		rule_id: "baseline_integrity_gate",
		severity: "high",
		category: "config",
	};
}
