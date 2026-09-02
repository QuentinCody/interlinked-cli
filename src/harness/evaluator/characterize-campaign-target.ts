// ===========================================
// Characterize-before-touch — campaign-target half (plan 25, lane 7)
// ===========================================
// The function-complexity ledger (`.interlinked/function-complexity-baseline.json`)
// names every function a `caps ratchet` campaign still has to burn down. Each
// entry is a decomposition target — and decomposing a function whose behavior
// no test pins is exactly the refactor that silently changes behavior. So an
// edit that TOUCHES a listed function must be preceded by a test signal for
// that file in the session trajectory: a companion test written this session,
// a recorded per-file run of the companion, or a test-runner command naming
// the file or its companion (`vitest related src/x.ts`, `vitest run
// src/x.test.ts`). A whole-suite run is deliberately NOT a signal — it says
// nothing about whether THIS function has a characterization test.
//
// "Touches" is decided on the pre/post AST (the same parse the cyclomatic gate
// pays): a uniquely-named function is touched when its source span differs
// between before and after, or when it is gone from after (a decomposition
// removes or renames its target). An edit above the function that only shifts
// its lines is not a touch.
//
// MODE VOCABULARY. The gate keys on `structural_checks.characterize_mode`,
// whose config vocabulary is `block | warn | off` (`types/config-structural.ts`,
// validated in `rules/merge.ts`). It is NOT `test_first_mode`'s
// `nudge | warn | enforce` — there is no "enforce" value for this key. The
// local `CharacterizeMode` type is derived from the config type so the two
// cannot drift. Fires ONLY in `"block"`; `"warn"` (today's default) and
// `"off"` stay silent, so the default posture is unchanged.
//
// The gate is a pure read — it persists nothing — so a `dry_run` simulation
// is honored by construction (the verdict is computed, no ledger moves).
// Analyzer unavailable → fail open, like every AST gate.
//
// Known limits (decided, not accidental):
// - `apply_patch` (Codex / Copilot CLI) IS adjudicated: the payload carries no
//   `file_path`, so `resolveFilePath` yields "" and the Write/Edit/MultiEdit
//   path stands down; `evaluateApplyPatchCampaignTargetGate` then projects
//   each section through `apply-patch-content.ts` (mirroring `checkApplyPatch`
//   in `per-function-metric-gate.ts`) and judges it per-file with the same
//   ledger + trajectory logic. A section that can't be reconstructed with
//   certainty fails open for that file (never a false block); a section whose
//   analyzer is unavailable fails open for the whole payload.
// - Both command signals are outcome-blind (a command carries no result).
//   `test_commands_run` is the durable one: `trackCommand` appends a command
//   there (full text, truncated to 2000 chars) only when it recognizes it as
//   a test-runner invocation (`isTestRunnerCommand`, shared with this file's
//   own `commandNamesFile` so the two predicates cannot drift), capped at 500
//   entries oldest-dropped-first — it does NOT expire from unrelated Bash
//   traffic. `commands_run` remains a 100-entry ring truncated to 200 chars
//   per command and is consulted only as a fallback for a session hydrated
//   from an older, pre-fix snapshot with no `test_commands_run` field; on a
//   live session the durable list is authoritative and a test run can no
//   longer age out from unrelated commands run afterward. Deliberately NOT
//   invalidated when the file is later written: one green run before the
//   FIRST edit characterizes the pre-edit code, which is what "characterize
//   before decomposing" means — re-running after every edit isn't the bar.
//   `files_written` and `test_runs` do not expire either.
// - A companion that merely EXISTS on disk is not a signal. The untested-file
//   half asks "does any test pin this file"; this half asks "did this session
//   characterize this function before decomposing it" — a trajectory question
//   by spec, so on-disk presence is deliberately not accepted.
// - A test-runner command after `cd <dir> &&` resolves its arguments against
//   `event.cwd`, not the hopped-to directory.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import {
	extractApplyPatchRaw,
	looksLikeApplyPatch,
	parseApplyPatchSections,
	reconstructAfterContent,
} from "../apply-patch-content.js";
import { computeCyclomaticAst } from "../checks/cyclomatic-ast.js";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import {
	COMPLEXITY_METRICS,
	type ComplexityMetric,
	type FunctionComplexityLedger,
	loadFunctionComplexityBaseline,
	toLedgerRelPath,
} from "../function-complexity-baseline.js";
import { ALL_TESTS_SENTINEL } from "../server-tdd-cycle.js";
import type { HarnessDecision, SessionTrajectory } from "../types.js";
import type { StructuralChecksConfig } from "../types/config-structural.js";
import { isTestRunnerCommand } from "../verification-stop-checks-predicates.js";
import { companionTestCandidates, isCompanionFileName } from "./companion-test.js";
import { projectContent, resolveFilePath } from "./per-function-metric-gate.js";

const JS_TS_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;
const TEST_PATH_RE = /(\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?)$|(^|\/)__tests__\//;
/** AST entries with this name are anonymous — no cross-edit identity. */
const ANON_FN = "(callback)";

/** The config's own vocabulary for `structural_checks.characterize_mode`
 *  (`block | warn | off`) — derived, never restated, so it cannot drift. */
type CharacterizeMode = NonNullable<StructuralChecksConfig["characterize_mode"]>;

interface CampaignTargetGateArgs {
	toolInput: JsonObject;
	cwd: string;
	session: SessionTrajectory | undefined;
	mode: CharacterizeMode | undefined;
}

/** One ledger hit for a function: the metric it is listed under and its value. */
interface CampaignTarget {
	metric: ComplexityMetric;
	value: number;
}

// ---- ledger view ------------------------------------------------------------

/** name → strongest ledger listing for that name in `relFile`, across both metrics. */
function campaignTargetsFor(
	ledger: FunctionComplexityLedger | null,
	relFile: string,
): Map<string, CampaignTarget> {
	const out = new Map<string, CampaignTarget>();
	if (!ledger) return out;
	for (const metric of COMPLEXITY_METRICS) {
		for (const e of ledger.metrics[metric]?.entries ?? []) {
			if (e.file !== relFile) continue;
			const prior = out.get(e.name);
			if (!prior || e.value > prior.value) out.set(e.name, { metric, value: e.value });
		}
	}
	return out;
}

// ---- touched-function detection --------------------------------------------

/** Source span (declaration line through end line) per uniquely-named function. */
function spansByName(entries: readonly FunctionComplexityEntry[], content: string): Map<string, string> {
	const counts = new Map<string, number>();
	for (const e of entries) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
	const lines = content.split("\n");
	const out = new Map<string, string>();
	for (const e of entries) {
		if (e.name === ANON_FN || counts.get(e.name) !== 1) continue;
		out.set(e.name, lines.slice(e.line - 1, e.endLine).join("\n"));
	}
	return out;
}

/**
 * Names of uniquely-named functions the edit touches: span text differs, or
 * the function is absent after the edit. Null when the TS analyzer is
 * unavailable (the caller fails open).
 */
export function touchedFunctions(before: string, after: string, filePath: string): Set<string> | null {
	const beforeEntries = computeCyclomaticAst(before, filePath);
	const afterEntries = computeCyclomaticAst(after, filePath);
	if (!beforeEntries || !afterEntries) return null;
	const beforeSpans = spansByName(beforeEntries, before);
	const afterSpans = spansByName(afterEntries, after);
	const touched = new Set<string>();
	for (const [name, span] of beforeSpans) {
		if (afterSpans.get(name) !== span) touched.add(name);
	}
	return touched;
}

// ---- trajectory test signal ------------------------------------------------

/** True when `candidateAbs` is a companion test of `srcAbs` (plain, qualified,
 *  `__tests__/`, or a separate-tree mirror the repo profile knows about). */
function isCompanionOf(candidateAbs: string, srcAbs: string, cwd: string): boolean {
	const srcDir = dirname(srcAbs);
	const ext = extname(srcAbs);
	const base = basename(srcAbs, ext);
	const candDir = dirname(candidateAbs);
	if (candDir === srcDir || candDir === resolve(srcDir, "__tests__")) {
		return isCompanionFileName(basename(candidateAbs), base, ext);
	}
	return companionTestCandidates(srcAbs, cwd).some((c) => resolve(c) === candidateAbs);
}

function toAbs(p: string, cwd: string): string {
	return resolve(isAbsolute(p) ? p : resolve(cwd, p));
}

/** True when `abs` is an existing directory that contains `srcAbs` — a
 *  directory-scoped run (`npx vitest run src/`, or bare `src`) exercises the
 *  file's companion as surely as naming it. Existence is required so command
 *  words (`npx`, `vitest`, `run`) never read as directories by accident. */
function isDirContaining(abs: string, srcAbs: string): boolean {
	if (!srcAbs.startsWith(abs + sep)) return false;
	try {
		return existsSync(abs) && statSync(abs).isDirectory();
	} catch {
		return false; // unreadable → not evidence of a directory run
	}
}

/** A test-runner command names the file, one of its companions, or a
 *  directory containing the file as an argument. */
function commandNamesFile(cmd: string, srcAbs: string, cwd: string): boolean {
	if (!isTestRunnerCommand(cmd)) return false;
	for (const raw of cmd.split(/\s+/)) {
		const token = raw.replace(/^['"]|['"]$/g, "");
		if (!token || token.startsWith("-")) continue;
		const abs = toAbs(token, cwd);
		if (JS_TS_RE.test(token)) {
			if (abs === srcAbs || isCompanionOf(abs, srcAbs, cwd)) return true;
		} else if (isDirContaining(abs, srcAbs)) {
			return true;
		}
	}
	return false;
}

/**
 * Whether the session trajectory carries a per-file test signal for `srcAbs`:
 * a companion written this session, a recorded GREEN per-file companion run
 * (a red run pins nothing — the test must pass to be a characterization), or
 * a test-runner command naming the file / its companion / a containing
 * directory (outcome-blind: a command carries no result).
 */
export function hasTestSignalFor(
	session: SessionTrajectory | undefined,
	srcAbs: string,
	cwd: string,
): boolean {
	if (!session) return false;
	for (const w of session.files_written ?? []) {
		if (isCompanionOf(toAbs(w, cwd), srcAbs, cwd)) return true;
	}
	if (hasGreenCompanionRun(session, srcAbs, cwd)) return true;
	// Durable list first (non-expiring, capped — see
	// session-state-mutators.ts::trackCommand); commands_run is the
	// pre-fix ring buffer, kept as a fallback so a hydrated older-schema
	// session (no test_commands_run field) still gets a signal.
	if (anyCommandNamesFile(session.test_commands_run, srcAbs, cwd)) return true;
	return anyCommandNamesFile(session.commands_run, srcAbs, cwd);
}

/** True when any command in `cmds` names `srcAbs` per {@link commandNamesFile}. */
function anyCommandNamesFile(
	cmds: readonly string[] | undefined,
	srcAbs: string,
	cwd: string,
): boolean {
	for (const cmd of cmds ?? []) {
		if (commandNamesFile(cmd, srcAbs, cwd)) return true;
	}
	return false;
}

/** A recorded per-file companion run with status "pass". The whole-suite
 *  sentinel is skipped (it says nothing about THIS file) and a red run is
 *  skipped (a failing test pins no behavior). */
function hasGreenCompanionRun(session: SessionTrajectory, srcAbs: string, cwd: string): boolean {
	for (const [run, record] of session.test_runs ?? []) {
		if (run === ALL_TESTS_SENTINEL || record.status !== "pass") continue;
		if (isCompanionOf(toAbs(run, cwd), srcAbs, cwd)) return true;
	}
	return false;
}

// ---- decision ---------------------------------------------------------------

interface TouchedTarget {
	name: string;
	target: CampaignTarget;
}

function blockReason(rel: string, hit: TouchedTarget, srcAbs: string, cwd: string): string {
	const companions = companionTestCandidates(srcAbs, cwd)
		.slice(0, 2)
		.map((c) => toLedgerRelPath(cwd, c))
		.join(", ");
	return (
		`BLOCKED: characterize first: ${rel}:${hit.name} is a campaign target ` +
		`(function-complexity ledger, ${hit.target.metric} ${hit.target.value}); ` +
		`run/write its characterization test at the public caller before decomposing. ` +
		`No test signal for this file is in the session trajectory — write a companion ` +
		`(searched: ${companions}) or run it first (\`npx vitest run ${companions.split(", ")[0]}\` ` +
		`or \`npx vitest related ${rel}\`), then retry the edit.`
	);
}

/** The first touched campaign target in `targets`, or null. */
function firstTouchedTarget(
	touched: ReadonlySet<string>,
	targets: ReadonlyMap<string, CampaignTarget>,
): TouchedTarget | null {
	for (const [name, target] of targets) {
		if (touched.has(name)) return { name, target };
	}
	return null;
}

function safeRead(abs: string): string | null {
	try {
		return readFileSync(abs, "utf-8");
	} catch {
		return null;
	}
}

/** One section's verdict against the ledger + trajectory: a `TouchedTarget`
 *  to block on, "allow" to keep looking at the next section, or "fail-open"
 *  to abandon the whole payload (the analyzer is unavailable). */
function evaluateApplyPatchSection(
	section: ReturnType<typeof parseApplyPatchSections>[number],
	ledger: FunctionComplexityLedger | null,
	args: CampaignTargetGateArgs,
): { hit: TouchedTarget; rel: string; srcAbs: string } | "allow" | "fail-open" {
	if (!JS_TS_RE.test(section.path)) return "allow";
	if (TEST_PATH_RE.test(section.path.split(sep).join("/"))) return "allow";

	const readPath = section.fromPath ?? section.path;
	const srcAbs = toAbs(readPath, args.cwd);
	const rel = toLedgerRelPath(args.cwd, srcAbs);
	const targets = campaignTargetsFor(ledger, rel);
	if (targets.size === 0) return "allow";

	const before = existsSync(srcAbs) ? safeRead(srcAbs) : "";
	if (before === null || before === "") return "allow"; // unreadable/creation → not this gate's territory
	const after = reconstructAfterContent(section, before);
	if (after === null) return "allow"; // can't reconstruct confidently → fail open for this file

	const touched = touchedFunctions(before, after, section.path);
	if (!touched) return "fail-open"; // analyzer unavailable → fail open for the whole payload
	const hit = firstTouchedTarget(touched, targets);
	if (!hit || hasTestSignalFor(args.session, srcAbs, args.cwd)) return "allow";
	return { hit, rel, srcAbs };
}

/**
 * apply_patch path: judge each V4A section against the ledger + trajectory,
 * mirroring `checkApplyPatch` in `per-function-metric-gate.ts`. Null (allow)
 * on a non-patch or malformed payload, on any section with no ledger hit, or
 * when an analyzer-unavailable section forces a whole-payload fail-open.
 */
function evaluateApplyPatchCampaignTargetGate(args: CampaignTargetGateArgs): HarnessDecision | null {
	const raw = extractApplyPatchRaw(args.toolInput);
	if (!raw || !looksLikeApplyPatch(raw)) return null;

	const ledger = loadFunctionComplexityBaseline(args.cwd);
	for (const section of parseApplyPatchSections(raw)) {
		const verdict = evaluateApplyPatchSection(section, ledger, args);
		if (verdict === "allow") continue;
		if (verdict === "fail-open") return null;
		return {
			decision: "block",
			reason: blockReason(verdict.rel, verdict.hit, verdict.srcAbs, args.cwd),
			rule_id: "characterize_before_touch",
			severity: "high",
			category: "tdd",
		};
	}
	return null;
}

/**
 * Core decision: block when the edit touches a ledger-listed function of a
 * JS/TS source file with no per-file test signal in the session — block mode
 * only. Null otherwise (warn/off, non-target edit, analyzer unavailable).
 */
export function evaluateCampaignTargetGate(args: CampaignTargetGateArgs): HarnessDecision | null {
	if (args.mode !== "block") return null;
	// apply_patch payloads carry no file_path → "" here, so the Write/Edit/
	// MultiEdit shape stands down and the apply_patch path (below) takes over.
	const filePath = resolveFilePath(args.toolInput);
	if (!filePath) return evaluateApplyPatchCampaignTargetGate(args);
	if (!JS_TS_RE.test(filePath)) return null;
	if (TEST_PATH_RE.test(filePath.split(sep).join("/"))) return null;

	// Resolve to absolute BEFORE deriving the ledger key: the ledger stores
	// `src/a.ts`, and a dot-relative tool-input path (`./src/a.ts`) would
	// otherwise never match it (fail-open, probe-verified 2026-09-01).
	const srcAbs = toAbs(filePath, args.cwd);
	const rel = toLedgerRelPath(args.cwd, srcAbs);
	const targets = campaignTargetsFor(loadFunctionComplexityBaseline(args.cwd), rel);
	if (targets.size === 0) return null;

	const projected = projectContent(args.toolInput, srcAbs);
	if (!projected || projected.before === "") return null; // creation → the new-file gate's territory
	const touched = touchedFunctions(projected.before, projected.after, filePath);
	if (!touched) return null; // analyzer unavailable → fail open
	const hit = firstTouchedTarget(touched, targets);
	if (!hit || hasTestSignalFor(args.session, srcAbs, args.cwd)) return null;

	return {
		decision: "block",
		reason: blockReason(rel, hit, srcAbs, args.cwd),
		rule_id: "characterize_before_touch",
		severity: "high",
		category: "tdd",
	};
}
