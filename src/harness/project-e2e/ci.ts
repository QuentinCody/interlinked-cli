// ===========================================
// CI lane — the CANDIDATE COMMIT, exported and run in isolation (Unit F5, plan §12 / §13)
// ===========================================
// `tests e2e ci` judges an exact revision, never the job's working tree
// (review F-R3): the candidate commit (`--revision`, else the CI event's sha,
// else HEAD) is exported as its exact tree into a disposable directory with a
// FRESH `.interlinked` state, every supervised run — single runs and the
// stability cohorts the policy adopts (F-R7) — executes there, and the same
// export is checked. Nothing from the workstation can reach it: no receipt,
// no cohort, no untracked fix, no local replacement record. The trusted base
// comes from the CI event (GitHub pull-request base ref / push `before`,
// GitLab merge-request diff base / `CI_COMMIT_BEFORE_SHA`) or `--base`; a zero
// before-sha is a bootstrap (PE-38); no base at all is UNAVAILABLE and nothing
// runs (PE-37). The evidence is copied under
// `.interlinked/test-runs/e2e/ci/<commit>/` for the job's artifacts, and the
// §13 trust limits are printed with every result.

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { qualifyStability } from "./cohort.js";
import { evaluateE2e, selectScenarios, type E2eEvaluation } from "./evaluate.js";
import { E2E_LEDGER_PATH } from "./ledger.js";
import { loadE2ePolicy } from "./policy.js";
import type { ScenarioVerdict } from "./qualify.js";
import { E2E_RUNS_DIRECTORY } from "./receipt.js";
import { E2E_REQUESTS_PATH } from "./requests.js";
import { runProjectE2e, type RunE2eResult } from "./run.js";
import { resolveCliEntry } from "./scheduler.js";
import { E2E_QUARANTINE_PATH } from "./stability.js";
import { exportTarget, type TargetIdentity } from "./target.js";

const ZERO_SHA = "0".repeat(40);
const CI_EVIDENCE_DIRECTORY = ".interlinked/test-runs/e2e/ci";
const STATE_DIRECTORY = ".interlinked";
export type CiBaseSource = "flag" | "github-pull-request" | "github-push" | "gitlab-merge-request" | "gitlab-push" | "none";
export interface CiBase { revision: string | null; source: CiBaseSource; /** A new ref: no trusted base exists, the policy comparison is a bootstrap. */ bootstrap: boolean; }
export interface CiOptions { root: string; projectId?: string; scenarioIds?: string[]; timeoutMs: number; atMs: number; base: CiBase; /** The candidate revision; `resolveCiCandidate` picks it from the event when absent. */ candidate?: string; }
export interface CiCandidate { revision: string; source: "flag" | "github" | "gitlab" | "head"; }
export interface CiResult {
    exitCode: 0 | 1 | 2; run: Pick<RunE2eResult, "receipts" | "messages">; evaluation: E2eEvaluation;
    /** Verdicts CI refused because their receipt was not produced here. */ notFresh: string[]; trust: string[]; messages: string[];
    /** The exact candidate that was exported and run (absent when nothing ran). */ candidate?: TargetIdentity & { evidence: string };
}
type Env = Record<string, string | undefined>;

function readBeforeSha(path: string | undefined): string | null {
    if (!path) return null;
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (typeof parsed !== "object" || parsed === null || !("before" in parsed)) return null;
        const { before } = parsed; // narrowed by the `in` check: an object with a `before` member
        return typeof before === "string" ? before : null;
    } catch {
        return null; // an unreadable event is "no base", reported by the caller
    }
}
function shaBase(sha: string | null, source: CiBaseSource): CiBase {
    if (sha === null || sha === "") return { revision: null, source, bootstrap: false };
    return sha === ZERO_SHA ? { revision: null, source, bootstrap: true } : { revision: sha, source, bootstrap: false };
}
/** Precedence: explicit flag, GitHub event, GitLab variables; anything else is `none` (the caller refuses). */
export function resolveCiBase(input: { explicit?: string; env: Env }): CiBase {
    const { env } = input;
    if (input.explicit) return { revision: input.explicit, source: "flag", bootstrap: false };
    if (env.GITHUB_ACTIONS) {
        const event = env.GITHUB_EVENT_NAME ?? "";
        if ((event === "pull_request" || event === "pull_request_target") && env.GITHUB_BASE_REF) return { revision: `refs/remotes/origin/${env.GITHUB_BASE_REF}`, source: "github-pull-request", bootstrap: false };
        if (event === "push") return shaBase(readBeforeSha(env.GITHUB_EVENT_PATH), "github-push");
    }
    if (env.GITLAB_CI) {
        if (env.CI_MERGE_REQUEST_DIFF_BASE_SHA) return { revision: env.CI_MERGE_REQUEST_DIFF_BASE_SHA, source: "gitlab-merge-request", bootstrap: false };
        return shaBase(env.CI_COMMIT_BEFORE_SHA ?? null, "gitlab-push");
    }
    return { revision: null, source: "none", bootstrap: false };
}
/** The candidate revision: explicit flag, the CI event's commit sha, else HEAD of the checkout. Always a commit, never the working tree. */
export function resolveCiCandidate(input: { explicit?: string; env: Env }): CiCandidate {
    if (input.explicit) return { revision: input.explicit, source: "flag" };
    if (input.env.GITHUB_ACTIONS && input.env.GITHUB_SHA) return { revision: input.env.GITHUB_SHA, source: "github" };
    if (input.env.GITLAB_CI && input.env.CI_COMMIT_SHA) return { revision: input.env.CI_COMMIT_SHA, source: "gitlab" };
    return { revision: "HEAD", source: "head" };
}
/** A satisfied verdict is CI evidence only when its receipt was produced by this invocation. */
export function freshnessOf(verdict: ScenarioVerdict, freshRunIds: ReadonlySet<string>): { fresh: true } | { fresh: false; reason: "CI_RECEIPT_NOT_FRESH" } {
    if (!verdict.satisfied) return { fresh: true };
    return verdict.runId !== undefined && freshRunIds.has(verdict.runId) ? { fresh: true } : { fresh: false, reason: "CI_RECEIPT_NOT_FRESH" };
}
function baseLine(options: CiOptions, evaluation: E2eEvaluation): string {
    if (options.base.bootstrap) return `base: bootstrap (${options.base.source}: new ref, no trusted base) — no policy comparison`;
    const resolved = evaluation.policy ? ` = ${evaluation.policy.base.commit}` : "";
    return `base: ${options.base.revision} (${options.base.source})${resolved}`;
}
function trustLines(options: CiOptions, evaluation: E2eEvaluation, runIds: string[], candidate: TargetIdentity): string[] {
    const entry = resolveCliEntry();
    const ids = runIds.length ? runIds.join(", ") : "none";
    return [
        `trust (§13): receipts: this run only (ids ${ids}) in a fresh state directory; workstation receipts, cohorts and replacement records are never CI evidence`,
        baseLine(options, evaluation),
        `checker: ${entry?.file ?? "unknown CLI entry"} — pin the Interlinked version in CI so the candidate change cannot supply its own checker`,
        `candidate: exact tree of commit ${candidate.commit ?? "?"} (tree ${candidate.tree ?? "?"}); the working tree and untracked files are never part of it — preparation provisions dependencies`,
    ];
}
function selection(options: CiOptions): { projectId?: string; scenarioIds?: string[] } {
    return { ...(options.projectId ? { projectId: options.projectId } : {}), ...(options.scenarioIds?.length ? { scenarioIds: options.scenarioIds } : {}) };
}
function noBase(options: CiOptions): CiResult {
    const evaluation = evaluateE2e({ root: options.root, atMs: options.atMs, ...selection(options) });
    return { exitCode: 2, run: { receipts: [], messages: [] }, evaluation: { ...evaluation, status: "unavailable", exitCode: 2, verdicts: [] }, notFresh: [], trust: [], messages: [`UNAVAILABLE: no trusted base (source: ${options.base.source}); pass --base <rev> or run under a recognized CI event. Nothing was run.`] };
}
function cannotExport(options: CiOptions, reason: string): CiResult {
    const evaluation = evaluateE2e({ root: options.root, atMs: options.atMs, ...selection(options) });
    return { exitCode: 2, run: { receipts: [], messages: [] }, evaluation: { ...evaluation, status: "unavailable", reason, exitCode: 2, verdicts: [] }, notFresh: [], trust: [], messages: [`UNAVAILABLE: ${reason}. Nothing was run.`] };
}
/**
 * The CI trust contract (review F2-2): the export keeps the candidate's committed policy, contracts, acceptance and
 * reviewed replacement records, but NO execution state — a committed ledger, request, quarantine row, cohort or receipt
 * would otherwise be resumed and counted as this invocation's evidence. Everything below is removed before anything runs.
 */
const EXECUTION_STATE = [E2E_LEDGER_PATH, E2E_REQUESTS_PATH, E2E_QUARANTINE_PATH, E2E_RUNS_DIRECTORY] as const;
/**
 * The first symlinked segment on `relativePath` under `base` (including the final one), or null. A committed link at
 * `.interlinked` or `.interlinked/test-runs` would otherwise let cleanup, state writes and evidence retention resolve
 * OUTSIDE the export (review F4-1: an external sentinel was deleted); the final path alone is not enough to check.
 */
function symlinkOnPath(base: string, relativePath: string): string | null {
    let current = base;
    for (const segment of relativePath.split("/").filter(Boolean)) {
        current = join(current, segment);
        if (!existsSync(current) && !isSymlink(current)) return null;
        if (isSymlink(current)) return relative(base, current);
    }
    return null;
}
function isSymlink(path: string): boolean {
    try { return lstatSync(path).isSymbolicLink(); }
    catch { return false; }
}
/** Refuses a candidate whose state ancestors are links; only then removes the execution state. */
function emptyExecutionState(exportRoot: string): { ok: true } | { ok: false; reason: string } {
    for (const path of [STATE_DIRECTORY, ...EXECUTION_STATE]) {
        const link = symlinkOnPath(exportRoot, path);
        if (link !== null) return { ok: false, reason: `candidate places a symlink at ${link}; execution state must live in real directories of the export (the candidate cannot redirect CI state)` };
    }
    for (const path of EXECUTION_STATE) rmSync(join(exportRoot, path), { recursive: true, force: true });
    return { ok: true };
}
/** Run ids of the receipts written under the export's run directory — the executions THIS invocation started, whatever a cohort reports. */
function startedRunIds(exportRoot: string): string[] {
    const directory = join(exportRoot, E2E_RUNS_DIRECTORY);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => existsSync(join(directory, name, "receipt.json")));
}
/** Every supervised execution the candidate's policy adopts: one run for the plain scenarios, a cohort per scenario declaring stability (F-R7). */
async function executeInExport(options: CiOptions, exportRoot: string): Promise<{ run: Pick<RunE2eResult, "receipts" | "messages">; runIds: string[] }> {
    const loaded = loadE2ePolicy(exportRoot);
    const stable = loaded.status === "configured" ? selectScenarios(loaded.policy, selection(options)).filter(row => row.scenario.stability) : [];
    const plain = loaded.status === "configured" ? selectScenarios(loaded.policy, selection(options)).filter(row => !row.scenario.stability).map(row => row.scenario.id) : [];
    const runIds: string[] = [], messages: string[] = [];
    let receipts: RunE2eResult["receipts"] = [];
    if (loaded.status !== "configured" || plain.length || !stable.length) {
        const run = await runProjectE2e({ root: exportRoot, gitRoot: options.root, timeoutMs: options.timeoutMs, ...selection(options), ...(plain.length && stable.length ? { scenarioIds: plain } : {}) });
        receipts = run.receipts; messages.push(...run.messages); runIds.push(...run.receipts.map(row => row.runId));
    }
    for (const row of stable) {
        const cohort = await qualifyStability({ root: exportRoot, gitRoot: options.root, projectId: row.project.id, scenarioId: row.scenario.id, timeoutMs: options.timeoutMs });
        messages.push(...cohort.messages);
        for (const attempt of cohort.cohort.attempts) { runIds.push(attempt.runId); receipts.push({ path: attempt.receipt, runId: attempt.runId, scenarioIds: [row.scenario.id] }); }
    }
    // Freshness is what was STARTED here (receipts under the emptied run directory), never what a cohort reports it holds.
    const started = new Set(startedRunIds(exportRoot));
    return { run: { receipts: receipts.filter(row => started.has(row.runId)), messages }, runIds: runIds.filter(id => started.has(id)) };
}
/** The export's evidence (receipts, ledger, cohorts) copied beside the job's other artifacts; the export itself is disposable. The destination's ancestors under the checkout must be real directories too. */
function retainEvidence(options: CiOptions, exportRoot: string, commit: string): { ok: true; path: string } | { ok: false; reason: string } {
    const link = symlinkOnPath(options.root, `${CI_EVIDENCE_DIRECTORY}/${commit}`);
    if (link !== null) return { ok: false, reason: `evidence not retained: ${link} under the checkout is a symlink` };
    const destination = join(options.root, CI_EVIDENCE_DIRECTORY, commit);
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    const state = join(exportRoot, STATE_DIRECTORY);
    if (existsSync(state)) cpSync(state, destination, { recursive: true, dereference: false });
    return { ok: true, path: destination };
}
/**
 * Export the candidate → run everything the policy adopts there → check the same export with the event base → freshness.
 * Exit 0 only when every required verdict is satisfied by evidence THIS invocation produced inside the export.
 */
export async function runCi(options: CiOptions): Promise<CiResult> {
    if (options.base.revision === null && !options.base.bootstrap) return noBase(options);
    const exported = exportTarget(options.root, { mode: "revision", revision: options.candidate ?? "HEAD" });
    if (!exported.ok) return cannotExport(options, `candidate ${options.candidate ?? "HEAD"} cannot be exported: ${exported.reason}`);
    try {
        const emptied = emptyExecutionState(exported.directory);
        if (!emptied.ok) return cannotExport(options, emptied.reason);
        const { run, runIds } = await executeInExport(options, exported.directory);
        const base = options.base.revision !== null ? { base: options.base.revision } : {};
        const judged = evaluateE2e({ root: exported.directory, gitRoot: options.root, atMs: options.atMs, ...selection(options), ...base });
        const evaluation: E2eEvaluation = { ...judged, root: options.root, target: exported.identity };
        const fresh = new Set(runIds);
        const notFresh = evaluation.verdicts.filter(row => !freshnessOf(row, fresh).fresh).map(row => row.key);
        const requiredNotFresh = evaluation.verdicts.some(row => row.required && notFresh.includes(row.key));
        let exitCode: 0 | 1 | 2 = evaluation.exitCode;
        if (exitCode === 0 && requiredNotFresh) exitCode = 1;
        const retained = retainEvidence(options, exported.directory, exported.identity.commit ?? "unknown");
        const evidence = retained.ok ? retained.path : "";
        const messages = [...run.messages, ...notFresh.map(key => `${key}: CI_RECEIPT_NOT_FRESH — satisfied by a receipt this invocation did not produce; not CI evidence`), retained.ok ? `evidence retained under ${retained.path}` : retained.reason];
        return { exitCode, run, evaluation, notFresh, trust: trustLines(options, evaluation, runIds, exported.identity), messages, candidate: { ...exported.identity, evidence } };
    } finally { exported.cleanup(); }
}
