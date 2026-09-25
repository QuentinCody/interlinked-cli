// ===========================================
// Counterfactual and fault-sensitivity qualification — plan §9.4 (Unit D3)
// ===========================================
// A scenario may require more than "the candidate passes": old-new proves the
// FIXED test fails on a pinned old revision and passes on the candidate;
// controlled-fault proves one recorded behavior-breaking alternative makes the
// designated expectation fail while the unmodified candidate passes;
// characterization proves the observations hold on both the baseline and the
// candidate. The supervisor builds the comparison side as a second immutable
// disposable snapshot (a git export of the pinned revision, or the candidate
// with exactly one recorded fault applied) with its own build, data, ports
// and lifecycle; the classifier below is pure over the two sides' outcomes.
// Both sides passing is NOT_DEMONSTRATED for old-new — not a defective test
// and not evidence of gaming; a comparison that cannot be built exactly is
// INCONCLUSIVE with the incompatible input named. The live tree is only read.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ContractState } from "../contracts/types.js";
import type { E2eDesignated, E2eFault, ProofMode } from "./policy.js";
import type { ServiceRecord } from "./services.js";
import { materializeTree } from "./target.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;

/**
 * One case's outcome on one side, with the phase evidence a comparison needs (review D1/round 2): which DECLARED observables held
 * (`matched`) or differed (`mismatched`). Only those decide; output presence and how the invocation ended are recorded evidence.
 */
export interface SideOutcome { id: string; state: ContractState; matched?: string[]; mismatched?: string[]; primaryOutput?: boolean; exitCode?: number | null; status?: number; }
export type SensitivityVerdict = "demonstrated" | "preserved" | "not-demonstrated" | "inconclusive";
export type SensitivityCategory =
    | "designated-expectation-mismatch" | "setup-build-dependency-failure" | "unrelated-assertion-failure" | "generic-runner-timeout-crash"
    | "comparison-passes" | "candidate-not-passing" | "comparison-unavailable" | "comparison-lifecycle-failure" | "action-evidence-undeclared";
export interface SensitivityClassification { verdict: SensitivityVerdict; category: SensitivityCategory; reasons: string[]; }
export interface SensitivityInput {
    mode: Exclude<ProofMode, "execution">; designated: E2eDesignated[]; candidate: SideOutcome[]; compared: SideOutcome[];
    /** The comparison reached case execution (build, export and services ready). */ comparisonPrepared: boolean;
    /** The comparison's whole lifecycle completed cleanly — services stopped, port silent, contracts not interrupted (review D2). */ comparisonComplete: boolean;
    comparisonReasons?: string[];
}
/** What the receipt records per scenario (§11 sensitivity group): both sides, the comparator identity, the comparison lifecycle and the classified verdict. */
export interface SensitivityRecord extends SensitivityClassification {
    mode: Exclude<ProofMode, "execution">; comparison: { kind: "revision" | "fault"; identity: string; description: string };
    designated: E2eDesignated[]; candidate: SideOutcome[]; compared: SideOutcome[];
    lifecycle?: { complete: boolean; reasons: string[]; services?: ServiceRecord[] };
}
export type BuildResult = { ok: true; identity: string; description: string } | { ok: false; reason: string };

const INTERRUPTED: ReadonlySet<ContractState> = new Set(["unavailable", "stale", "not-run"]);
function stateOf(side: SideOutcome[], id: string): ContractState { return side.find(row => row.id === id)?.state ?? "not-run"; }
/** Every case a proof reads on both sides: the designated cases and the action cases that establish them. */
export function proofCaseIds(designated: readonly E2eDesignated[]): string[] {
    return [...new Set(designated.flatMap(entry => [entry.id, ...(entry.action ?? [])]))];
}
function describeEnd(outcome: SideOutcome): string {
    if (outcome.exitCode !== undefined && outcome.exitCode !== null) return `exit ${outcome.exitCode}`;
    if (outcome.status !== undefined) return `HTTP ${outcome.status}`;
    return "no completion";
}
interface Unestablished { category: SensitivityCategory; reason: string; }
/**
 * Review round 3: an action case establishes a designated observation only if it EXECUTED before it. Sides are recorded in
 * execution order, so the action's index must precede the designated case's; an action observed later (or not at all)
 * cannot retroactively certify an observation made before any order existed.
 */
function misordered(entry: E2eDesignated, side: readonly SideOutcome[]): string[] {
    const own = side.findIndex(row => row.id === entry.id);
    return (entry.action ?? []).filter(id => { const at = side.findIndex(row => row.id === id); return at < 0 || own < 0 || at >= own; });
}
/**
 * §9.4 step 4 (review round 2): the comparison ESTABLISHED THE ACTION of a designated case only through DECLARED evidence —
 * every observable the case declares outside its `outcome` held on the comparison side, and every `action` case passed there.
 * Output presence, exit codes and status classes never decide: a startup banner before a crash and a 500 "dependency
 * unavailable" body both look like output. Returns why the action was NOT established, or null when it was.
 */
function unestablished(entry: E2eDesignated, compared: SideOutcome[]): Unestablished | null {
    const row = compared.find(item => item.id === entry.id);
    if (!row) return { category: "generic-runner-timeout-crash", reason: `designated ${entry.id} has no observation on the comparison` };
    const matched = row.matched ?? [], declared = [...matched, ...(row.mismatched ?? [])];
    const outcome = entry.outcome ?? declared;
    const undeclared = outcome.filter(key => !declared.includes(key));
    if (undeclared.length) return { category: "action-evidence-undeclared", reason: `designated ${entry.id} names outcome ${undeclared.join(", ")} that the case does not declare; the proof cannot be read` };
    const evidence = declared.filter(key => !outcome.includes(key)), actions = entry.action ?? [];
    if (!evidence.length && !actions.length) return { category: "action-evidence-undeclared", reason: `designated ${entry.id} declares no action evidence (every declared observable is its outcome and no action case is named): a failure's cause is unknown` };
    const differed = evidence.filter(key => !matched.includes(key));
    if (differed.length) return { category: "setup-build-dependency-failure", reason: `designated ${entry.id} did not establish its action on the comparison: ${differed.join(", ")} differed (${describeEnd(row)}); a dependency, setup or crash failure, not a behavioral outcome` };
    const failedActions = actions.filter(id => stateOf(compared, id) !== "passed");
    if (failedActions.length) return { category: "setup-build-dependency-failure", reason: `action case ${failedActions.join(", ")} did not pass on the comparison, so the action behind ${entry.id} was not established` };
    const late = misordered(entry, compared);
    if (late.length) return { category: "action-evidence-undeclared", reason: `action case ${late.join(", ")} executed AFTER ${entry.id} on the comparison; a prerequisite observed later cannot establish the earlier observation` };
    return null;
}
/** Inconclusive before any outcome is read: the candidate must pass, the comparison must be built, prepared and cleanly completed. */
function preconditions(input: SensitivityInput): SensitivityClassification | null {
    const candidateRed = proofCaseIds(input.designated).filter(id => stateOf(input.candidate, id) !== "passed");
    if (candidateRed.length) return { verdict: "inconclusive", category: "candidate-not-passing", reasons: [`the candidate itself does not pass ${candidateRed.join(", ")}; a comparison proves nothing until it does`] };
    const late = input.designated.flatMap(entry => misordered(entry, input.candidate).map(id => `action case ${id} executed after ${entry.id} on the candidate; a prerequisite must run before the designated observation`));
    if (late.length) return { verdict: "inconclusive", category: "action-evidence-undeclared", reasons: late };
    if (!input.comparisonPrepared) return { verdict: "inconclusive", category: "setup-build-dependency-failure", reasons: ["the comparison side could not reach its action (build, service or export failure)"] };
    if (!input.comparisonComplete) return { verdict: "inconclusive", category: "comparison-lifecycle-failure", reasons: [`the comparison side did not complete cleanly (${(input.comparisonReasons ?? []).join("; ") || "teardown or execution failure"}); its observations cannot be trusted`] };
    return null;
}
function characterized(failed: string[]): SensitivityClassification {
    if (failed.length) return { verdict: "not-demonstrated", category: "designated-expectation-mismatch", reasons: [`behavior differs on the baseline: ${failed.join(", ")} failed`] };
    return { verdict: "preserved", category: "comparison-passes", reasons: ["observations hold on the baseline and the candidate"] };
}
function outcomeOf(entry: E2eDesignated, compared: SideOutcome[]): string { return (compared.find(row => row.id === entry.id)?.mismatched ?? []).join(", ") || "outcome"; }
/** The §9.4 failure-category table over the designated set. Pure. */
export function classifySensitivity(input: SensitivityInput): SensitivityClassification {
    const { designated, compared } = input, ids = designated.map(entry => entry.id);
    const blocked = preconditions(input);
    if (blocked) return blocked;
    const interrupted = proofCaseIds(designated).filter(id => INTERRUPTED.has(stateOf(compared, id)));
    if (interrupted.length) return { verdict: "inconclusive", category: "generic-runner-timeout-crash", reasons: [`${interrupted.join(", ")} was ${interrupted.map(id => stateOf(compared, id)).join("/")} on the comparison: cause or completed observations unknown`] };
    const failed = ids.filter(id => stateOf(compared, id) === "failed");
    if (input.mode === "characterization") return characterized(failed);
    if (failed.length < ids.length) {
        const passing = ids.filter(id => !failed.includes(id));
        return { verdict: "not-demonstrated", category: "comparison-passes", reasons: [`the comparison did not distinguish the snapshots for ${passing.join(", ")}: both sides pass (not by itself a defective test)`] };
    }
    const unreached = designated.map(entry => unestablished(entry, compared)).filter((row): row is Unestablished => row !== null);
    if (unreached.length) return { verdict: "inconclusive", category: unreached[0]!.category, reasons: unreached.map(row => row.reason) };
    const actionIds = new Set(designated.flatMap(entry => entry.action ?? []));
    const firstDesignated = compared.findIndex(row => ids.includes(row.id));
    const unrelated = compared.slice(0, Math.max(0, firstDesignated)).filter(row => row.state === "failed" && !ids.includes(row.id) && !actionIds.has(row.id));
    if (unrelated.length) return { verdict: "not-demonstrated", category: "unrelated-assertion-failure", reasons: [`${unrelated.map(row => row.id).join(", ")} failed before the designated expectation; another condition failed first`] };
    return { verdict: "demonstrated", category: "designated-expectation-mismatch", reasons: designated.map(entry => `${entry.id} failed on the comparison at its designated outcome (${outcomeOf(entry, compared)}) with its action evidence established, and passed on the candidate`) };
}

async function git(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
    try {
        const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_EXPORT_BYTES });
        return { ok: true, stdout: stdout.trim() };
    } catch (error) { return { ok: false, reason: error instanceof Error ? error.message.split("\n").slice(0, 2).join(" ") : String(error) }; }
}
/**
 * Export the pinned revision's tree for THIS project (its subdirectory when nested) into `target`, byte-exact from the
 * repository object store (`materializeTree`: never archive, never checkout conversions) — never a checkout, stash, reset
 * or anything that touches the user's working tree. `repoProjectRoot` is the project's directory in the REAL repository
 * (review F2-3: in CI the run's project root is a disposable export without `.git`).
 */
export async function exportRevision(repoProjectRoot: string, revision: string, target: string): Promise<BuildResult> {
    const sha = await git(repoProjectRoot, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
    if (!sha.ok || !/^[a-f0-9]{40}$/.test(sha.stdout)) return { ok: false, reason: `revision "${revision}" cannot be resolved to a commit in this repository: ${sha.ok ? "no commit" : sha.reason}` };
    const prefix = await git(repoProjectRoot, ["rev-parse", "--show-prefix"]);
    if (!prefix.ok) return { ok: false, reason: prefix.reason };
    const subtree = await git(repoProjectRoot, ["rev-parse", "--verify", "--quiet", prefix.stdout ? `${sha.stdout}:${prefix.stdout.replace(/\/$/, "")}` : `${sha.stdout}^{tree}`]);
    if (!subtree.ok) return { ok: false, reason: `revision ${sha.stdout.slice(0, 12)} carries no ${prefix.stdout || "root"} tree: ${subtree.reason}` };
    try { materializeTree(repoProjectRoot, subtree.stdout, target); }
    catch (error) { return { ok: false, reason: `materializing ${sha.stdout.slice(0, 12)} failed: ${error instanceof Error ? error.message : String(error)}` }; }
    return { ok: true, identity: sha.stdout, description: `git revision ${revision} (${sha.stdout.slice(0, 12)})${prefix.stdout ? ` subtree ${prefix.stdout}` : ""}` };
}
/** Apply exactly one recorded fault to the comparison snapshot; the identity binds the fault id to the exact changed bytes. */
export function applyFault(snapshot: string, fault: E2eFault): BuildResult {
    const path = join(snapshot, fault.path);
    let content: string;
    try { content = readFileSync(path, "utf8"); }
    catch (error) { return { ok: false, reason: `fault ${fault.id}: ${fault.path} cannot be read in the comparison snapshot (${error instanceof Error ? error.message : String(error)})` }; }
    const occurrences = content.split(fault.find).length - 1;
    if (occurrences !== 1) return { ok: false, reason: `fault ${fault.id}: anchor occurs ${occurrences} times in ${fault.path}; exactly one occurrence is required for a recorded isolation recipe` };
    const changed = content.replace(fault.find, fault.replace);
    writeFileSync(path, changed);
    const digest = createHash("sha256").update(`${fault.path}\0${fault.find}\0${fault.replace}\0${changed}`).digest("hex");
    return { ok: true, identity: `${fault.id}@${digest}`, description: `fault ${fault.id} on ${fault.path}: ${fault.rationale}` };
}
