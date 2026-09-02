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
// write lands, so disk still holds the pre-edit value. Reuses the disk-read /
// Edit-reconstruction helpers from config-loosening-gate.ts.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { reconstructProposedBaseline } from "./baseline-integrity-proposal.js";
import { readDiskContent, safeJsonParse } from "./config-loosening-gate.js";
import { detectFunctionComplexityBaseline, detectSiblingBaseline, isSiblingBaselinePath, ledgerCreationBlock } from "./function-complexity-baseline-gate.js";
import { type WaterLineStem, waterLineStem } from "./water-line-files.js";

export interface BaselineGamingFinding {
	file: string;
	rule: string;
	before: unknown;
	after: unknown;
	message: string;
}

type BaselineKind =
	| "coverage"
	| "coverage-edit"
	| "mutation"
	| "large-files"
	| "untested-files"
	| "metric-caps"
	| "mutation-manifest"
	| "skipped-tests"
	| "check-evidence"
	| "function-complexity";

/** Keyed by WaterLineStem: a new water-line unhandled here is a compile error. */
const KIND_MAP: Record<WaterLineStem, BaselineKind> = {
	"coverage-baseline": "coverage",
	"coverage-edit-baseline": "coverage-edit",
	"mutation-baseline": "mutation",
	"large-files-baseline": "large-files",
	"untested-files-baseline": "untested-files",
	"metric-caps": "metric-caps",
	"mutation-manifest": "mutation-manifest",
	"skipped-tests-baseline": "skipped-tests",
	"check-evidence-baseline": "check-evidence",
	"function-complexity-baseline": "function-complexity",
};

function baselineKind(filePath: string): BaselineKind | null {
	const stem = waterLineStem(filePath);
	// KIND_MAP is exhaustive over WaterLineStem (compile-time enforced), so a resolved stem always maps.
	return stem ? KIND_MAP[stem] : null;
}

function isNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function asObj(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
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

/** A coverage-edit baseline value in either shape: a legacy bare fraction, or
 *  a scoped `{f, scope}` object (mirrors coverage-obligation-ledger). */
function decodeCovValue(value: unknown): { f: number; scope: string | null } | null {
	if (isNum(value)) return { f: value, scope: null };
	const obj = asObj(value);
	const f = obj.f;
	if (isNum(f)) return { f, scope: typeof obj.scope === "string" ? obj.scope : null };
	return null;
}

function detectCoverageEdit(
	file: string,
	before: unknown,
	after: unknown,
	exists: (rel: string) => boolean,
): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = [];
	const b = asObj(before);
	const a = asObj(after);
	for (const [path, bRaw] of Object.entries(b)) {
		const bv = decodeCovValue(bRaw);
		if (bv === null) continue;
		const aRaw = a[path];
		if (aRaw === undefined) {
			if (exists(path)) {
				out.push(
					fmt(file, `coverage-edit:${path}`, bv.f, undefined, `coverage-edit-baseline entry for ${path} removed while the source still exists.`),
				);
			}
			continue;
		}
		const av = decodeCovValue(aRaw);
		// A DIFFERENT measuring scope is a legitimate re-anchor (the reseed the
		// runtime performs when affected-test selection changes), not gaming — only
		// a SAME-SCOPE fraction drop is a lowered water-line. Legacy null==null
		// (both scope-less) still enforces exactly as before.
		if (av !== null && av.scope === bv.scope && av.f < bv.f) {
			out.push(
				fmt(file, `coverage-edit:${path}`, bv.f, av.f, `coverage-edit-baseline for ${path} lowered ${bv.f}→${av.f} within the same test scope. Per-edit coverage may only rise (a scope change re-anchors automatically).`),
			);
		}
	}
	return out;
}

function detectLargeFiles(file: string, before: unknown, after: unknown): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = [];
	const b = asObj(before);
	const a = asObj(after);
	const bMax = b.max_lines;
	const aMax = a.max_lines;
	if (isNum(bMax) && isNum(aMax) && aMax > bMax) {
		out.push(fmt(file, "max_lines", bMax, aMax, `large-files max_lines raised ${bMax}→${aMax}. The line cap may only tighten.`));
	}
	const effMax = isNum(aMax) ? aMax : Number.POSITIVE_INFINITY;
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
	const out: BaselineGamingFinding[] = [];
	const b = asObj(before);
	const a = asObj(after);
	const bMax = b.max_skipped;
	const aMax = a.max_skipped;
	if (isNum(bMax) && isNum(aMax) && aMax > bMax) {
		out.push(
			fmt(
				file,
				"max_skipped",
				bMax,
				aMax,
				`skipped-tests max_skipped raised ${bMax}→${aMax}. The skip cap may only tighten — fix or delete the skipped test instead.`,
			),
		);
	}
	const effMax = isNum(aMax) ? aMax : Number.POSITIVE_INFINITY;
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
	const out: BaselineGamingFinding[] = [];
	const b = asObj(before);
	const a = asObj(after);
	const bMin = b.min_coverage_pct;
	const aMin = a.min_coverage_pct;
	if (isNum(bMin) && isNum(aMin) && aMin < bMin) {
		out.push(fmt(file, "min_coverage_pct", bMin, aMin, `untested-files min_coverage_pct lowered ${bMin}→${aMin}. The coverage floor may only rise.`));
	}
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

function detectMetricCaps(file: string, before: unknown, after: unknown): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = [];
	const b = asObj(before);
	const a = asObj(after);
	// `max_predicate_drift` is a repo-wide COUNT water-line, not a per-function
	// cap, but it obeys the same direction rule (may only fall) and lives here so
	// the ratchet reuses the guarded file rather than minting a loosenable new one.
	for (const k of [
		"max_lines",
		"max_function_tokens",
		"max_cyclomatic",
		"max_cognitive",
		"crap_threshold",
		"max_predicate_drift",
	]) {
		const bv = b[k];
		const av = a[k];
		if (isNum(bv) && isNum(av) && av > bv) {
			out.push(fmt(file, k, bv, av, `metric-caps ${k} raised ${bv}→${av}. Caps may only tighten.`));
		}
	}
	const bMin = b.min_coverage;
	const aMin = a.min_coverage;
	if (isNum(bMin) && isNum(aMin) && aMin < bMin) {
		out.push(fmt(file, "min_coverage", bMin, aMin, `metric-caps min_coverage lowered ${bMin}→${aMin}. The coverage floor may only rise.`));
	}
	// `coverage_goal` is deliberately NOT direction-locked (2026-08-17): it is a
	// display/nudge TARGET, not a gate input — lowering it from 100 to 80 is a
	// legitimate team choice, and no enforcement reads it, so moving it gains an
	// agent nothing. The gamed levers stay locked above: min_coverage (floor)
	// and the caps.
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
 * new baselines, unparseable JSON, or safe-direction moves).
 */
export function detectBaselineGaming(
	filePath: string,
	beforeText: string,
	afterText: string,
	sourceExists?: (rel: string) => boolean,
): BaselineGamingFinding[] {
	const kind = baselineKind(filePath);
	// The disposition ledger (not a water-line) rides its sibling detector.
	if (!kind) return detectSiblingBaseline(filePath, beforeText, afterText);
	if (!beforeText) return [];
	const before = safeJsonParse(beforeText);
	const after = safeJsonParse(afterText);
	if (before === null || after === null) return [];
	const exists = sourceExists ?? makeDefaultSourceExists(filePath);
	switch (kind) {
		case "coverage":
			return detectRisingMetricMap(filePath, asObj(asObj(before).files), asObj(asObj(after).files), ["lines_pct", "branches_pct"], "coverage", exists);
		case "mutation":
			return detectRisingMetricMap(filePath, asObj(asObj(before).files), asObj(asObj(after).files), ["score", "killed"], "mutation", exists);
		case "coverage-edit":
			return detectCoverageEdit(filePath, before, after, exists);
		case "large-files":
			return detectLargeFiles(filePath, before, after);
		case "untested-files":
			return detectUntestedFiles(filePath, before, after);
		case "metric-caps":
			return detectMetricCaps(filePath, before, after);
		case "mutation-manifest":
			return detectMutationManifest(filePath, before, after);
		case "skipped-tests":
			return detectSkippedTests(filePath, before, after);
		case "check-evidence":
			return detectCheckEvidence(filePath, before, after);
		case "function-complexity":
			return detectFunctionComplexityBaseline(filePath, beforeText, afterText);
	}
}

interface BaselineGateDeps {
	getDisk?: (file: string, cwd: string | undefined) => string | null;
}

/**
 * Public API — PreToolUse entry point (wired in pre-tool-guards.ts). Blocks a
 * Write/Edit/MultiEdit that loosens a committed baseline. Fails open (returns
 * null) on anything it can't conclude: non-baseline file, disable-bypass,
 * unreconstructable edit, or a not-yet-existing baseline. Disk is the source of
 * truth (most baselines are gitignored local state); the hook fires before the
 * write lands, so disk still holds the pre-edit water-line. `deps` is injectable.
 */
export function evaluateBaselineIntegrityForEvent(
	event: HarnessEvent,
	deps: BaselineGateDeps = {},
): HarnessDecision | null {
	if (process.env.INTERLINKED_DISABLE_BASELINE_GUARD === "1") return null;
	const toolInput = event.tool_input || {};
	const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
	const kind = baselineKind(filePath);
	if (!filePath || (!kind && !isSiblingBaselinePath(filePath))) return null;

	const getDisk = deps.getDisk ?? readDiskContent;
	const before = getDisk(filePath, event.cwd);
	// Absent baseline: creating it isn't loosening — except the complexity ledger (ledgerCreationBlock).
	if (before === null) return kind === "function-complexity" ? ledgerCreationBlock(filePath) : null;

	const proposed = reconstructProposedBaseline(before, toolInput);
	if (proposed === null) return null;

	const findings = detectBaselineGaming(filePath, before, proposed);
	if (findings.length === 0) return null;

	const messages = findings.map((f) => `[${f.rule}] ${f.message}`).join("\n  ");
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
