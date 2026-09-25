// ===========================================
// Change reconciliation — observed paths → scenario obligations
// ===========================================
// Plan 31 §7. Input is a set of observed changed paths (from a PostToolUse
// changeset, a Bash effect, or "all" at startup/verification); output is the
// pending obligations opened at the current generation plus explicit mapping
// gaps. Tool names are irrelevant: an Edit, a patch and a formatter that
// touch the same file open the same obligation (PE-17). Pure docs edits
// outside every declared input open nothing (PE-16). A full reconciliation
// walks the whole protected inventory so a mapping gap reaches the verdict,
// not only the hook line that first noticed it (R10).

import { join } from "node:path";
import { matchesAnyGlob } from "../../lib/path-glob.js";
import { CONTRACT_MANIFEST } from "../contracts/paths.js";
import { collectProjectInputs, scenarioGeneration } from "./generation.js";
import { appendE2eTxn, readE2eTxns, reduceE2eLedger, scenarioKey, type E2eLedgerState } from "./ledger.js";
import { E2E_POLICY_PATH, loadE2ePolicy, type E2ePolicy, type E2eProject, type E2eScenario, type E2eScheduling } from "./policy.js";

export interface ReconcileInput { root: string; /** Where git refs resolve when `root` is an exported tree without `.git` (CI candidate export). */ gitRoot?: string; changedPaths: readonly string[] | "all"; sessionId?: string; atMs: number; dryRun?: boolean; }
export interface PendingScenario { key: string; projectId: string; scenarioId: string; generation: string; reason: string; }
export interface MappingGap { projectId: string; path: string; /** Present when the protected inventory itself could not be captured (F4). */ issue?: string; }
export interface ReconcileResult {
    status: "configured" | "unconfigured" | "invalid"; reason?: string;
    /** Obligations this reconciliation OPENED (a new generation): the messages name these. */ pending: PendingScenario[];
    /** Every affected scenario whose obligation is unresolved at the current generation — newly opened OR already pending (review C6): requests and scheduling key off these. */ affected: PendingScenario[];
    mappingGaps: MappingGap[];
    /** The policy's scheduling block, so the daemon can decide adopted automatic execution (C5). */ scheduling?: E2eScheduling;
}

const MAX_MESSAGES = 5;

function projectRelative(project: E2eProject, path: string): string | null {
    if (project.root === ".") return path;
    const prefix = `${project.root}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}
function isControlPath(project: E2eProject, path: string): boolean {
    return path === E2E_POLICY_PATH || path === (project.contractManifest ?? CONTRACT_MANIFEST);
}
interface ProjectChanges { control: boolean; shared: string[]; protectedPaths: string[]; }
function classify(policy: E2ePolicy, project: E2eProject, changed: readonly string[]): ProjectChanges {
    const result: ProjectChanges = { control: false, shared: [], protectedPaths: [] };
    for (const path of changed) {
        if (matchesAnyGlob(path, policy.sharedInputs ?? [])) { result.shared.push(path); continue; }
        const local = projectRelative(project, path);
        if (local === null) continue;
        if (isControlPath(project, local)) { result.control = true; continue; }
        if (matchesAnyGlob(local, project.sharedInputs ?? [])) result.shared.push(local);
        else if (matchesAnyGlob(local, project.protectedInputs)) result.protectedPaths.push(local);
    }
    return result;
}
function scenarioReason(scenario: E2eScenario, changes: ProjectChanges | "all"): string | null {
    if (changes === "all") return "reconciliation against the current working tree";
    if (changes.control) return "policy or contract manifest changed";
    if (changes.shared.length) return `shared input ${changes.shared[0]} changed`;
    const hit = changes.protectedPaths.find(path => matchesAnyGlob(path, scenario.affects));
    return hit ? `${hit} changed` : null;
}
function unmapped(project: E2eProject, paths: readonly string[]): MappingGap[] {
    return paths.filter(path => !project.scenarios.some(scenario => matchesAnyGlob(path, scenario.affects))).map(path => ({ projectId: project.id, path }));
}
/** Every file under the protected globs that no scenario maps, plus every protected path that could not be captured — the full inventory a completion boundary must see. */
export function projectMappingGaps(root: string, project: E2eProject): MappingGap[] {
    const projectRoot = project.root === "." ? root : join(root, project.root);
    const collected = collectProjectInputs(projectRoot, project.protectedInputs);
    const files = collected.files.map(file => file.path).filter(path => !matchesAnyGlob(path, project.sharedInputs ?? []));
    const incomplete = collected.gaps.map(issue => ({ projectId: project.id, path: issue.replace(/^input (.*?) not captured.*$/, "$1"), issue }));
    return [...unmapped(project, files), ...incomplete];
}
interface ProjectContext { root: string; policy: E2ePolicy; digest: string; ledger: E2eLedgerState; input: ReconcileInput; }
/** `opened`: a new generation's obligation was appended; `affected`: the obligation is unresolved at this generation whether this call opened it or an earlier session did. */
function openPending(ctx: ProjectContext, project: E2eProject, scenario: E2eScenario, reason: string): { row: PendingScenario; opened: boolean } | null {
    const key = scenarioKey(project.id, scenario.id);
    const { generation } = scenarioGeneration(ctx.root, ctx.policy, ctx.digest, project, scenario, ctx.input.gitRoot ?? ctx.root);
    const row = { key, projectId: project.id, scenarioId: scenario.id, generation, reason };
    const current = ctx.ledger.get(key);
    if (current && current.generation === generation) return current.status === "satisfied" ? null : { row, opened: false };
    if (!ctx.input.dryRun) appendE2eTxn(ctx.root, { op: "pending", key, generation, reason, atMs: ctx.input.atMs, ...(ctx.input.sessionId ? { sessionId: ctx.input.sessionId } : {}) });
    return { row, opened: true };
}
function reconcileProject(ctx: ProjectContext, project: E2eProject, result: ReconcileResult): void {
    const changes = ctx.input.changedPaths === "all" ? "all" : classify(ctx.policy, project, ctx.input.changedPaths);
    for (const scenario of project.scenarios) {
        const reason = scenarioReason(scenario, changes);
        if (reason === null) continue;
        const pending = openPending(ctx, project, scenario, reason);
        if (!pending) continue;
        result.affected.push(pending.row);
        if (pending.opened) result.pending.push(pending.row);
    }
    result.mappingGaps.push(...(changes === "all" ? projectMappingGaps(ctx.root, project) : unmapped(project, changes.protectedPaths)));
}
/** Opens pending obligations for every scenario whose declared inputs changed. Writes the ledger unless `dryRun`. */
export function reconcileChanges(input: ReconcileInput): ReconcileResult {
    const loaded = loadE2ePolicy(input.root);
    if (loaded.status !== "configured") return { status: loaded.status, ...(loaded.status === "invalid" ? { reason: loaded.reason } : {}), pending: [], affected: [], mappingGaps: [] };
    const result: ReconcileResult = { status: "configured", pending: [], affected: [], mappingGaps: [], ...(loaded.policy.scheduling ? { scheduling: loaded.policy.scheduling } : {}) };
    const ctx: ProjectContext = { root: input.root, policy: loaded.policy, digest: loaded.digest, ledger: reduceE2eLedger(readE2eTxns(input.root)), input };
    for (const project of loaded.policy.projects) reconcileProject(ctx, project, result);
    return result;
}
/** Bounded, actionable hook messages (plan §12.2): at most five scenarios, each with the exact command. */
export function formatReconcileMessages(result: ReconcileResult): string[] {
    const lines: string[] = [];
    if (result.status === "invalid") lines.push(`[interlinked:e2e] policy invalid: ${result.reason ?? "unknown"}; fix .interlinked/e2e-policy.json (no scenario is verified while it is invalid)`);
    for (const row of result.pending) lines.push(`[interlinked:e2e] ${row.projectId}: ${row.scenarioId} needs current e2e evidence after ${row.reason}. Run: interlinked tests e2e run --project ${row.projectId} --scenario ${row.scenarioId}`);
    for (const gap of result.mappingGaps) lines.push(gap.issue ? `[interlinked:e2e] ${gap.projectId}: protected inventory incomplete — ${gap.issue}` : `[interlinked:e2e] ${gap.projectId}: ${gap.path} is a protected input with no scenario mapping (needs-mapping). Add it to a scenario's affects in .interlinked/e2e-policy.json.`);
    if (lines.length <= MAX_MESSAGES) return lines;
    return [...lines.slice(0, MAX_MESSAGES), `[interlinked:e2e] ${lines.length - MAX_MESSAGES} more; see interlinked tests e2e status`];
}
