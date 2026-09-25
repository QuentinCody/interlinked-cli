// `interlinked tests e2e …` — plan 31 §14. Inspection (status/plan) exits 0;
// verification (check/run) uses the shared exit contract (0 / 1 / 2).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { evaluateE2e, formatEvaluation, type E2eEvaluation } from "../harness/project-e2e/evaluate.js";
import { resolveCiBase, resolveCiCandidate, runCi } from "../harness/project-e2e/ci.js";
import { gateDecision, gateHookStatus, installGateHooks, uninstallGateHooks, type GateProject } from "../harness/project-e2e/gate.js";
import type { E2eTarget } from "../harness/project-e2e/target.js";
import type { ExpectationDraft, ExpectationDecision, ReplacementDecision } from "../harness/project-e2e/expectations.js";
import { runProjectE2e } from "../harness/project-e2e/run.js";
import { acceptExpectationInStore, disputeExpectationInStore, proposeExpectationInStore, replaceExpectationInStore, reviewExpectations, type ReviewRow, type StoredExpectation } from "../harness/project-e2e/store.js";
import { getOutputMode, output, outputError, type OutputMode } from "../lib/output.js";

export interface E2eOptions { cwd?: string; project?: string; scenario?: string[]; timeout?: string; json?: boolean; from?: string; runs?: string; suite?: string; write?: boolean; /** F1: judge the staged bytes (`check --staged`). */ staged?: boolean; /** F1: judge an exact revision (`check --revision <rev>`). */ revision?: string; /** F3: the trusted base whose policy the judged policy is compared with. */ base?: string; rationale?: string; /** F4: honour the project's `gates.<name>` — warn/off report without failing. */ gate?: string; commit?: boolean; push?: boolean; }
export type E2eAction = "status" | "plan" | "run" | "check" | "qualify";
export type ExpectationAction = "propose" | "review" | "accept" | "replace" | "dispute";
const MAX_TIMEOUT_MS = 600_000;

function selection(options: E2eOptions): { root: string; projectId?: string; scenarioIds?: string[] } {
    const root = realpathSync(options.cwd ?? process.cwd());
    return { root, ...(options.project ? { projectId: options.project } : {}), ...(options.scenario?.length ? { scenarioIds: options.scenario } : {}) };
}
function timeoutOf(options: E2eOptions): number {
    const timeoutMs = Number(options.timeout ?? "120000");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new Error(`Timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} ms`);
    return timeoutMs;
}
/** F1: `check --staged` judges the index, `check --revision <rev>` an exact commit; both refuse each other and any other action. */
function targetOf(action: E2eAction, options: E2eOptions): E2eTarget {
    if (!options.staged && options.revision === undefined) return { mode: "working-tree" };
    if (action !== "check") throw new Error("--staged and --revision apply to `tests e2e check` only (status/plan describe the working tree)");
    if (options.staged && options.revision !== undefined) throw new Error("pass --staged or --revision <rev>, not both");
    return options.staged ? { mode: "index" } : { mode: "revision", revision: options.revision! };
}
/**
 * F4: under `--gate commit|ci`, a FAILING project whose gate (from the judged target's own policy, review F-R2) is warn/off, or
 * which is advisory, reports without failing; a required gate keeps the exit. `POLICY_WEAKENED` is never overridden by the
 * candidate's gate setting — the candidate cannot switch off the gate that would judge that switch.
 */
function gateOutcome(action: E2eAction, options: E2eOptions, evaluation: E2eEvaluation): { exitCode: 0 | 1 | 2; lines: string[] } {
    if (options.gate === undefined) return { exitCode: evaluation.exitCode, lines: [] };
    if (action !== "check" || (options.gate !== "commit" && options.gate !== "ci")) throw new Error("--gate commit|ci applies to `tests e2e check` only");
    if (evaluation.exitCode === 0 || evaluation.status !== "configured") return { exitCode: evaluation.exitCode, lines: [] };
    if (evaluation.policy?.weakening.length) return { exitCode: evaluation.exitCode, lines: [`gate ${options.gate}: POLICY_WEAKENED is never waived by the candidate's own gate setting; record the reviewed replacement.`] };
    const decision = gateDecision({ projects: failingProjects(evaluation) }, options.gate);
    if (decision.enforced) return { exitCode: evaluation.exitCode, lines: [`gate ${options.gate} is required by project(s) ${decision.projects.join(", ")}: exit ${evaluation.exitCode}. Recover: interlinked tests e2e run, then retry.`] };
    return { exitCode: 0, lines: [`gate ${options.gate} is warn/off (or the project is advisory) for every failing project: reported only, exit 0 — the obligation stays open.`] };
}
/** The judged policy's projects that carry an open required verdict or a mapping gap — the only ones a gate decision is about. */
function failingProjects(evaluation: E2eEvaluation): GateProject[] {
    const failing = new Set([...evaluation.verdicts.filter(row => row.required && !row.satisfied).map(row => row.projectId), ...evaluation.mappingGaps.map(gap => gap.projectId)]);
    return evaluation.projects.filter(project => failing.has(project.id));
}
function render(mode: OutputMode, evaluation: E2eEvaluation, extra: string[] = []): void {
    output(mode, evaluation, { normal: () => [...formatEvaluation(evaluation), ...extra].join("\n") });
}
function planLines(evaluation: E2eEvaluation): string[] {
    return evaluation.verdicts.map(row => `${row.key}: ${row.required ? "required" : "advisory"}; generation ${row.generation.slice(0, 12)}; next: ${row.satisfied ? "nothing (satisfied)" : `interlinked tests e2e run --project ${row.projectId} --scenario ${row.scenarioId}`}`);
}
/** status/plan inspect (exit 0); check/run verify (exit 0/1/2). */
export async function testsE2eCommand(action: E2eAction, options: E2eOptions): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const selected = selection(options);
        if (action === "run") {
            // A detached automatic launch (C4) re-validates authorization against the CURRENT policy; a queued job never outlives a disable.
            const result = await runProjectE2e({ ...selected, timeoutMs: timeoutOf(options), ...(process.env.INTERLINKED_AUTO_RUN === "1" ? { automatic: true } : {}) });
            render(mode, result, [...result.messages, ...result.receipts.map(row => `receipt ${row.path} (${row.scenarioIds.join(", ")})`)]);
            if (result.exitCode !== 0) process.exitCode = result.exitCode;
            return;
        }
        if (action === "qualify") { await qualifyAction(mode, selected, options); return; }
        if (options.base !== undefined && action !== "check") throw new Error("--base applies to `tests e2e check` only");
        const evaluation = evaluateE2e({ ...selected, atMs: Date.now(), target: targetOf(action, options), ...(options.base !== undefined ? { base: options.base } : {}) });
        const gated = gateOutcome(action, options, evaluation);
        render(mode, evaluation, action === "plan" ? planLines(evaluation) : gated.lines);
        if (action === "check" && gated.exitCode !== 0) process.exitCode = gated.exitCode;
    } catch (error) {
        outputError(mode, error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}
/** §12 `gate install|status|uninstall`: the explicitly installed git hooks that CHECK the exact target (exit 0; 2 refused). */
export async function testsE2eGateCommand(action: "install" | "status" | "uninstall", options: E2eOptions): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const root = realpathSync(options.cwd ?? process.cwd());
        if (!existsSync(join(root, ".git"))) throw new Error(`${root} is not a git repository root; run from the repository root`);
        if (action === "install") {
            const which = { commit: options.commit !== false, push: options.push !== false };
            const result = installGateHooks(root, which);
            output(mode, result, { normal: () => [`pre-commit: ${result.preCommit.installed ? "installed" : which.commit ? "already installed" : "skipped"}${result.preCommit.backedUp ? ` (original chained from ${result.preCommit.backedUp})` : ""}`, `pre-push: ${result.prePush.installed ? "installed" : which.push ? "already installed" : "skipped"}${result.prePush.backedUp ? ` (original chained from ${result.prePush.backedUp})` : ""}`, "hooks CHECK the exact staged bytes / pushed revisions; supervised runs stay explicit (interlinked tests e2e run)."].join("\n") });
            return;
        }
        if (action === "uninstall") { const result = uninstallGateHooks(root); output(mode, result, { normal: () => `pre-commit: ${result.preCommit.removed ? "removed" : "not ours"}${result.preCommit.restored ? " (original restored)" : ""}\npre-push: ${result.prePush.removed ? "removed" : "not ours"}${result.prePush.restored ? " (original restored)" : ""}` }); return; }
        const status = gateHookStatus(root);
        output(mode, status, { normal: () => `pre-commit: ${status.preCommit ? "installed" : "absent"}\npre-push: ${status.prePush ? "installed" : "absent"}` });
    } catch (error) {
        outputError(mode, error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}
/** §12 CI lane (Unit F5): fresh supervised run, then the check against the event base; receipts this invocation did not produce are never evidence (exit 0/1/2). */
export async function testsE2eCiCommand(options: E2eOptions): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const selected = selection(options);
        const base = resolveCiBase({ ...(options.base !== undefined ? { explicit: options.base } : {}), env: process.env });
        const candidate = resolveCiCandidate({ ...(options.revision !== undefined ? { explicit: options.revision } : {}), env: process.env });
        const result = await runCi({ ...selected, timeoutMs: timeoutOf(options), atMs: Date.now(), base, candidate: candidate.revision });
        output(mode, result, { normal: () => [...formatEvaluation(result.evaluation), ...result.messages, ...result.trust].join("\n") });
        if (result.exitCode !== 0) process.exitCode = result.exitCode;
    } catch (error) {
        outputError(mode, error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}
/** §13 `policy replace`: record the reviewed requirement change that discharges a weakening between `--base` and the current policy (exit 0; 2 refused). */
export async function testsE2ePolicyCommand(action: "replace", options: E2eOptions): Promise<void> {
    const mode = getOutputMode(options);
    try {
        if (action !== "replace") throw new Error(`unknown policy action ${String(action)}`);
        if (!options.base || !options.project || !options.rationale) throw new Error("policy replace needs --base <rev>, --project <id> and --rationale <text> (optionally --scenario <id>)");
        if ((options.scenario?.length ?? 0) > 1) throw new Error("policy replace covers one scenario (or the whole project when --scenario is absent)");
        const { recordPolicyReplacement } = await import("../harness/project-e2e/policy-base.js");
        const record = recordPolicyReplacement({ root: realpathSync(options.cwd ?? process.cwd()), base: options.base, projectId: options.project, ...(options.scenario?.[0] ? { scenarioId: options.scenario[0] } : {}), rationale: options.rationale, atMs: Date.now() });
        output(mode, record, { normal: () => [`recorded reviewed replacement for ${record.projectId}${record.scenarioId ? `/${record.scenarioId}` : ""}: base ${record.baseDigest.slice(0, 12)} → head ${record.headDigest.slice(0, 12)}`, "the record binds exactly these two policy digests; another edit to the policy needs a new review. Local configuration is not authenticated human approval (plan §13)."].join("\n") });
    } catch (error) {
        outputError(mode, error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}
/** §14 `scaffold <name>`: a proposed scenario + skeleton with explicit assumptions; files are written only with --write, the policy never (exit 0; 2 refused). */
export async function testsE2eScaffoldCommand(name: string, options: E2eOptions): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const { scaffoldScenario, writeScaffold } = await import("../harness/project-e2e/scaffold.js");
        const root = realpathSync(options.cwd ?? process.cwd());
        const result = scaffoldScenario({ root, name, ...(options.project ? { projectId: options.project } : {}), ...(options.suite ? { suiteId: options.suite } : {}) });
        const written = options.write ? writeScaffold(root, result) : [];
        const lines = [
            `scenario to add under projects[${result.project.id}].scenarios in .interlinked/e2e-policy.json (never written by this command):`, JSON.stringify(result.scenario, null, 2),
            ...result.files.flatMap(file => [`--- ${file.path}${written.length ? " (written)" : " (pass --write to create)"}`, file.content]),
            ...result.notes.map(note => `note: ${note}`),
        ];
        output(mode, { project: result.project.id, suite: result.suite.id, scenario: result.scenario, files: result.files, written, notes: result.notes }, { normal: () => lines.join("\n") });
    } catch (error) {
        outputError(mode, error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}
/** §9.5 / §14 `qualify`: ONE scenario's stability cohort (independent attempts, every one published); exit follows the cohort verdict. */
async function qualifyAction(mode: OutputMode, selected: ReturnType<typeof selection>, options: E2eOptions): Promise<void> {
    if (selected.scenarioIds?.length !== 1) throw new Error("qualify runs one scenario's cohort: pass exactly one --scenario <id>");
    const runs = options.runs === undefined ? undefined : Number(options.runs);
    if (runs !== undefined && (!Number.isInteger(runs) || runs < 1 || runs > 5)) throw new Error("--runs must be an integer from 1 to 5");
    const { qualifyStability } = await import("../harness/project-e2e/cohort.js");
    const result = await qualifyStability({ root: selected.root, scenarioId: selected.scenarioIds[0]!, timeoutMs: timeoutOf(options), ...(selected.projectId ? { projectId: selected.projectId } : {}), ...(runs !== undefined ? { runs } : {}) });
    output(mode, result, { normal: () => [...formatEvaluation(result.evaluation), ...result.messages].join("\n") });
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
}
function readInterchange<T>(options: E2eOptions, what: string): T {
    if (!options.from) throw new Error(`--from <file> is required: a validated ${what} interchange record`);
    const content = readFileSync(options.from, "utf8");
    // SAFETY: the store validates every field before writing; this is only the JSON envelope.
    return JSON.parse(content) as T;
}
function reviewLines(rows: ReviewRow[]): string {
    if (!rows.length) return "no live expectations";
    return rows.map(row => {
        const head = `${row.expectation.id}: ${row.expectation.lifecycle} [${row.expectation.origin}] rev ${row.expectation.revision.slice(0, 12)} — ${row.expectation.statement}`;
        const sources = row.sources.map(source => `  source ${source.path}: ${source.provenance}`);
        const questions = row.expectation.questions.map(question => `  question: ${question}`);
        const diff = (row.diff ?? []).map(change => `  changed ${change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`);
        return [head, ...sources, ...questions, ...diff].join("\n");
    }).join("\n");
}
function storedLines(row: StoredExpectation): string {
    return `${row.expectation.id}: ${row.expectation.lifecycle} rev ${row.expectation.revision}\n${row.sources.map(source => `  source ${source.path}: ${source.provenance}`).join("\n")}`;
}
function applyDecision(action: ExpectationAction, root: string, options: E2eOptions): StoredExpectation {
    const atMs = Date.now();
    if (action === "propose") return proposeExpectationInStore(root, readInterchange<ExpectationDraft>(options, "proposal"), atMs);
    if (action === "accept") return acceptExpectationInStore(root, readInterchange<ExpectationDecision>(options, "decision"), atMs);
    if (action === "replace") return replaceExpectationInStore(root, readInterchange<ReplacementDecision>(options, "replacement decision"), atMs);
    return disputeExpectationInStore(root, readInterchange<ExpectationDecision>(options, "decision"), atMs);
}
/** Local decisions are configured records, never authenticated human approval (plan §13). */
export async function testsE2eExpectationsCommand(action: ExpectationAction, options: E2eOptions): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const root = realpathSync(options.cwd ?? process.cwd());
        if (action === "review") {
            const rows = reviewExpectations(root);
            output(mode, rows, { normal: () => reviewLines(rows) });
            return;
        }
        const result = applyDecision(action, root, options);
        output(mode, result, { normal: () => storedLines(result) });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputError(mode, message);
        process.exitCode = /--from|UNCONFIGURED|policy invalid|ENOENT|JSON/.test(message) ? 2 : 1;
    }
}
