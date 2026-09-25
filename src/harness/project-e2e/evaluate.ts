// ===========================================
// Evaluate — current verdict for every selected scenario
// ===========================================
// The read side used by `tests e2e status|check`, verify and Stop. It first
// reconciles the working tree (a missed hook must not erase an obligation,
// plan §7.1), then applies the one qualification predicate per scenario.
// Inspection never runs a suite and never manufactures a pass: UNCONFIGURED
// is exit 2, an open required obligation or an unmapped protected input in a
// required-mode project is exit 1.

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { scenarioGeneration } from "./generation.js";
import { readE2eTxns, reduceE2eLedger, scenarioKey, type E2eLedgerState } from "./ledger.js";
import { loadE2ePolicy, type E2eGates, type E2ePolicy, type E2eProject, type E2eScenario, type LoadedPolicy } from "./policy.js";
import { exitCodeFor, qualifyScenario, type QualifyInput, type ScenarioVerdict } from "./qualify.js";
import { readE2eReceiptDetailed } from "./receipt.js";
import { loadBasePolicy } from "./policy-base.js";
import { readPolicyChanges, type PolicyChangeRecord } from "./policy-changes.js";
import { comparePolicies, type PolicyComparison } from "./policy-diff.js";
import { projectMappingGaps, reconcileChanges, type MappingGap } from "./reconcile.js";
import { quarantineFor } from "./stability.js";
import { exportTarget, type E2eTarget, type TargetIdentity } from "./target.js";

export interface EvaluateOptions {
    root: string; projectId?: string; scenarioIds?: string[]; atMs: number; sessionId?: string; reconcile?: boolean; dryRun?: boolean;
    /** Where git refs (proof revisions, the trusted base) resolve when `root` is an exported tree without `.git` (CI candidate). */ gitRoot?: string;
    /** F1: the exact bytes to judge; the working tree unless said otherwise. */ target?: E2eTarget;
    /** F3: the TRUSTED base revision whose policy the judged policy is compared with (never `proof.revision`). */ base?: string;
}
/** F3: the base comparison — who the base was, what changed, what a reviewed record already discharged, and WHERE the records were read (review F-R4: the judged target, never a local file the target does not carry). */
export interface PolicyEvaluation extends PolicyComparison { base: { revision: string; commit: string }; recordsFrom: "working-tree" | "target"; }
export interface EvaluationScope { requested: "all" | "subset"; projectId?: string; scenarioIds?: string[]; }
/** The judged policy's enforcement shape per project (review F-R2): gate decisions are taken from the SAME bytes as the verdicts. */
export interface ProjectEnforcement { id: string; mode: E2eProject["mode"]; gates: E2eGates; }
export interface E2eEvaluation {
    version: 1; status: "configured" | "unconfigured" | "invalid" | "unavailable"; reason?: string; root: string; policyDigest?: string;
    scope: EvaluationScope; verdicts: ScenarioVerdict[]; /** Protected inputs no scenario maps (needs-mapping); gates required-mode projects. */ mappingGaps: MappingGap[]; exitCode: 0 | 1 | 2;
    /** F1: what was judged — the working tree, the index (tree id) or a revision (commit + tree). */ target: TargetIdentity;
    /** F3: present when a base was requested; `weakening` non-empty ⇒ exit 1 (`POLICY_WEAKENED`). */ policy?: PolicyEvaluation;
    /** F4: the judged policy's projects with mode and gates (from the target's bytes), for `--gate` decisions. */ projects: ProjectEnforcement[];
}
/** Where the judged bytes live (`inputRoot`), where the ledger/receipts live (`root`) and where git refs resolve (`gitRoot`). */
interface Roots { root: string; inputRoot: string; gitRoot: string; }
export interface Selected { project: E2eProject; scenario: E2eScenario; }

function scopeOf(options: Pick<EvaluateOptions, "projectId" | "scenarioIds">): EvaluationScope {
    const subset = options.projectId !== undefined || (options.scenarioIds?.length ?? 0) > 0;
    const scope: EvaluationScope = { requested: subset ? "subset" : "all" };
    if (options.projectId !== undefined) scope.projectId = options.projectId;
    if (options.scenarioIds?.length) scope.scenarioIds = [...options.scenarioIds];
    return scope;
}
/** Projects in scope — resolved independently of scenario rows so a project with no scenarios keeps its obligations (F5). */
export function selectProjects(policy: E2ePolicy, options: Pick<EvaluateOptions, "projectId">): E2eProject[] {
    const projects = options.projectId === undefined ? policy.projects : policy.projects.filter(project => project.id === options.projectId);
    if (!projects.length) throw new Error(`e2e: unknown project ${options.projectId}`);
    return projects;
}
/** Resolves the requested selection; an unknown id is a refusal, never an empty pass. */
export function selectScenarios(policy: E2ePolicy, options: Pick<EvaluateOptions, "projectId" | "scenarioIds">): Selected[] {
    const projects = selectProjects(policy, options);
    const selected: Selected[] = [];
    for (const project of projects) for (const scenario of project.scenarios) selected.push({ project, scenario });
    const wanted = options.scenarioIds ?? [];
    for (const id of wanted) if (!selected.some(row => row.scenario.id === id)) throw new Error(`e2e: unknown scenario ${id}`);
    return wanted.length ? selected.filter(row => wanted.includes(row.scenario.id)) : selected;
}
function notConfigured(loaded: LoadedPolicy, root: string, scope: EvaluationScope, target: TargetIdentity): E2eEvaluation {
    const evaluation: E2eEvaluation = { version: 1, status: loaded.status === "invalid" ? "invalid" : "unconfigured", root, scope, verdicts: [], mappingGaps: [], exitCode: 2, target, projects: [] };
    if (loaded.status === "invalid") evaluation.reason = loaded.reason;
    return evaluation;
}
function canonicalProjectRoot(root: string, project: E2eProject): string {
    const projectRoot = project.root === "." ? root : join(root, project.root);
    try { return realpathSync(projectRoot); } catch { return projectRoot; }
}
function qualifyInput(options: EvaluateOptions, roots: Roots, loaded: Extract<LoadedPolicy, { status: "configured" }>, ledger: E2eLedgerState, selected: Selected): QualifyInput {
    const { project, scenario } = selected;
    const generation = scenarioGeneration(roots.inputRoot, loaded.policy, loaded.digest, project, scenario, roots.gitRoot);
    const state = ledger.get(scenarioKey(project.id, scenario.id));
    const input: QualifyInput = { policy: loaded.policy, project, scenario, policyDigest: loaded.digest, canonicalRoot: canonicalProjectRoot(roots.root, project), generation: { generation: generation.generation, gaps: generation.gaps, caseDigests: generation.inputs.caseDigests }, state, receipt: null };
    if (generation.comparison !== undefined) input.generation.comparison = generation.comparison; // D3: the comparator this generation was computed against
    if (scenario.stability) input.quarantine = quarantineFor(options.root, scenarioKey(project.id, scenario.id), generation.generation);
    if (!state?.lastReceipt) return input;
    const read = readE2eReceiptDetailed(options.root, state.lastReceipt);
    input.receipt = read.receipt;
    if (read.issue !== undefined) input.receiptIssue = read.issue;
    return input;
}
function gatedByMappingGaps(gaps: MappingGap[], projects: E2eProject[]): boolean {
    return gaps.some(gap => projects.find(project => project.id === gap.projectId)?.mode === "required");
}
/** Mapping gaps for the judged bytes: the working tree reconciles (and may open obligations); an exported target is only inspected. */
function mappingGapsFor(options: EvaluateOptions, roots: Roots, projects: E2eProject[]): MappingGap[] {
    if (roots.inputRoot !== roots.root) return projects.flatMap(project => projectMappingGaps(roots.inputRoot, project));
    const reconciled = reconcileChanges({ root: options.root, changedPaths: "all", atMs: options.atMs, ...(options.sessionId ? { sessionId: options.sessionId } : {}), ...(options.reconcile === false || options.dryRun ? { dryRun: true } : {}) });
    return reconciled.mappingGaps.filter(gap => projects.some(project => project.id === gap.projectId));
}
function evaluateAt(options: EvaluateOptions, roots: Roots, target: TargetIdentity): E2eEvaluation {
    const loaded = loadE2ePolicy(roots.inputRoot);
    const scope = scopeOf(options);
    if (loaded.status !== "configured") return notConfigured(loaded, options.root, scope, target);
    const projects = selectProjects(loaded.policy, options);
    const selection = selectScenarios(loaded.policy, options);
    const mappingGaps = mappingGapsFor(options, roots, projects);
    const ledger = reduceE2eLedger(readE2eTxns(options.root));
    const verdicts = selection.map(selected => qualifyScenario(qualifyInput(options, roots, loaded, ledger, selected)));
    const exitCode = exitCodeFor(verdicts) || (gatedByMappingGaps(mappingGaps, projects) ? 1 : 0);
    const enforcement = projects.map(project => ({ id: project.id, mode: project.mode, gates: project.gates ?? {} }));
    return { version: 1, status: "configured", root: options.root, policyDigest: loaded.digest, scope, verdicts, mappingGaps, exitCode, target, projects: enforcement };
}
/**
 * Current verdicts. The working tree reconciles first unless `reconcile: false` (a caller that just published attempts and
 * re-reads). An index or revision target (F1) is exported into a disposable directory and judged from THOSE bytes against the
 * real root's ledger and receipts — a worktree receipt certifies the target only when the generation is byte-identical.
 */
export function evaluateE2e(options: EvaluateOptions): E2eEvaluation {
    const target = options.target ?? { mode: "working-tree" };
    const evaluation = evaluateTarget(options, target);
    return options.base === undefined ? evaluation : withBase(options, evaluation);
}
function unavailable(options: EvaluateOptions, reason: string, target: TargetIdentity): E2eEvaluation {
    return { version: 1, status: "unavailable", reason, root: options.root, scope: scopeOf(options), verdicts: [], mappingGaps: [], exitCode: 2, target, projects: [] };
}
function gitRootOf(options: EvaluateOptions): string { return options.gitRoot ?? options.root; }
function evaluateTarget(options: EvaluateOptions, target: E2eTarget): E2eEvaluation {
    if (target.mode === "working-tree") return evaluateAt(options, { root: options.root, inputRoot: options.root, gitRoot: gitRootOf(options) }, { mode: "working-tree" });
    const exported = exportTarget(gitRootOf(options), target);
    if (!exported.ok) return unavailable(options, exported.reason, { mode: target.mode });
    try { return evaluateAt(options, { root: options.root, inputRoot: exported.directory, gitRoot: gitRootOf(options) }, exported.identity); }
    finally { exported.cleanup(); }
}
/**
 * F3 (§13): compare the judged policy with the trusted base's. An unresolvable base is UNAVAILABLE (PE-37, never HEAD); a base
 * without a policy is a bootstrap (PE-38); an unreplaced weakening makes the exit 1 whatever the verdicts said (PE-33).
 */
function withBase(options: EvaluateOptions, evaluation: E2eEvaluation): E2eEvaluation {
    if (evaluation.status !== "configured") return evaluation;
    const base = loadBasePolicy(gitRootOf(options), options.base!);
    if (base.status === "unavailable") return unavailable(options, `trusted base: ${base.reason}`, evaluation.target);
    if (base.status === "invalid") return unavailable(options, `trusted base ${options.base} (${base.commit.slice(0, 12)}) carries an invalid policy: ${base.reason}`, evaluation.target);
    const judged = judgedSide(options, evaluation);
    const comparison = comparePolicies(base.status === "configured" ? base.policy : null, judged.policy, judged.records);
    const policy: PolicyEvaluation = { ...comparison, base: { revision: options.base!, commit: base.commit }, recordsFrom: judged.recordsFrom };
    // An unreplaced weakening is an unmet requirement (exit 1) whatever the scenario verdicts said — including when no scenario is left to judge.
    return { ...evaluation, policy, exitCode: comparison.weakening.length ? 1 : evaluation.exitCode };
}
interface JudgedSide { policy: E2ePolicy; records: PolicyChangeRecord[]; recordsFrom: PolicyEvaluation["recordsFrom"]; }
function judgedAt(directory: string, recordsFrom: PolicyEvaluation["recordsFrom"]): JudgedSide {
    const loaded = loadE2ePolicy(directory);
    if (loaded.status !== "configured") throw new Error("judged policy vanished between evaluation and comparison");
    return { policy: loaded.policy, records: readPolicyChanges(directory).records, recordsFrom };
}
/**
 * The judged policy AND the §13 replacement records, read from the same bytes: the working tree's, or the exported target's
 * (re-exported once for the comparison). A record only the working tree holds never discharges a staged or committed
 * weakening (review F-R4) — commit the record (carve `.interlinked/e2e-policy-changes.jsonl` out of `.gitignore`).
 */
function judgedSide(options: EvaluateOptions, evaluation: E2eEvaluation): JudgedSide {
    const target = options.target ?? { mode: "working-tree" };
    if (evaluation.target.mode === "working-tree" || target.mode === "working-tree") return judgedAt(options.root, "working-tree");
    const exported = exportTarget(gitRootOf(options), target);
    if (!exported.ok) throw new Error(exported.reason);
    try { return judgedAt(exported.directory, "target"); }
    finally { exported.cleanup(); }
}
function verdictLines(verdict: ScenarioVerdict): string[] {
    const flag = verdict.required ? "required" : "advisory";
    const head = `${verdict.key}: ${verdict.status} [${flag}] generation ${verdict.generation.slice(0, 12)}${verdict.runId ? ` run ${verdict.runId}` : ""}`;
    const dims = Object.entries(verdict.dimensions).map(([name, value]) => `${name}=${value}`).join(" ");
    const reasons = verdict.reasons.map(reason => `  - ${reason.code}: ${reason.message}`);
    const advisories = verdict.advisories.map(note => `  ~ ${note}`);
    return [head, `  ${dims}`, ...reasons, ...advisories];
}
function targetLine(target: TargetIdentity): string {
    if (target.mode === "working-tree") return "target: working tree (observed files, including untracked ones)";
    if (target.mode === "index") return `target: index (staged bytes only; tree ${target.tree?.slice(0, 12) ?? "?"}) — an unstaged fix does not count`;
    return `target: revision ${target.commit?.slice(0, 12) ?? "?"} (tree ${target.tree?.slice(0, 12) ?? "?"})`;
}
function policyLines(policy: PolicyEvaluation | undefined): string[] {
    if (!policy) return [];
    const head = `policy base: ${policy.base.revision} (${policy.base.commit.slice(0, 12)})${policy.bootstrap ? " — no policy at the base: bootstrap, every scenario is new" : ""}; replacement records read from the ${policy.recordsFrom}`;
    const weakened = policy.weakening.map(row => `  - POLICY_WEAKENED [${row.kind}] ${row.detail}; record the reviewed replacement: interlinked tests e2e policy replace --base ${policy.base.revision} --project ${row.projectId}${row.scenarioId ? ` --scenario ${row.scenarioId}` : ""} --rationale "<why>"`);
    const replaced = policy.replaced.map(row => `  ~ replaced (reviewed) [${row.kind}] ${row.detail}`);
    return [head, ...weakened, ...replaced];
}
/** Human-readable lines; machine consumers use the evaluation object. */
export function formatEvaluation(evaluation: E2eEvaluation): string[] {
    if (evaluation.status === "unconfigured") return [`e2e: UNCONFIGURED — no .interlinked/e2e-policy.json under ${evaluation.root}. Declare projects, suites and scenarios there; configuration alone produces no pass. exit 2`];
    if (evaluation.status === "invalid") return [`e2e: INVALID policy — ${evaluation.reason ?? "unknown"}. No scenario is verified while the policy is invalid. exit 2`];
    if (evaluation.status === "unavailable") return [`e2e: UNAVAILABLE — ${evaluation.reason ?? "the target could not be exported"}. No verdict exists for this target. exit 2`];
    const lines = [targetLine(evaluation.target), ...policyLines(evaluation.policy), ...evaluation.verdicts.flatMap(verdictLines)];
    for (const gap of evaluation.mappingGaps) lines.push(gap.issue ? `${gap.projectId}: protected inventory incomplete — ${gap.issue}` : `${gap.projectId}: needs-mapping — ${gap.path} is a protected input with no scenario; add it to a scenario's affects`);
    const open = evaluation.verdicts.filter(row => row.required && !row.satisfied).length;
    const scope = evaluation.scope.requested === "subset" ? " (requested subset only; whole-project satisfaction is not claimed)" : "";
    lines.push(`e2e: ${evaluation.verdicts.length} scenario(s), ${open} required open, ${evaluation.mappingGaps.length} mapping gap(s)${scope}. exit ${evaluation.exitCode}`);
    return lines;
}
