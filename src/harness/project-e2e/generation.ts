// ===========================================
// Scenario input generation — the identity a receipt is scoped to
// ===========================================
// Plan 31 §7–8, decision 8: a later write cannot be certified by an older
// run. A scenario's generation is the digest of every declared input it
// depends on — files matching `affects`, project and repository shared
// inputs, the contract manifest, the contract acceptance file, the cited
// requirement documents of cases AND bound expectations, the referenced
// cases' own inputs, and every file a prepare step or a case argv names —
// each identified by content AND mode (an executable that lost its x bit is
// a different input) — plus the policy digest. Collection is bounded, and
// every omission is a GAP the verdict sees (R2/F2): an input that cannot be
// captured, including a symlink standing where a declared input should be,
// makes the scope incomplete.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { matchesAnyGlob, matchesGlob } from "../../lib/path-glob.js";
import { CONTRACT_MANIFEST, CONTRACT_POLICY, contractDigest, contractPath, readContractFile } from "../contracts/paths.js";
import { parseContractManifest } from "../contracts/schema.js";
import type { ContractCase } from "../contracts/types.js";
import { digestOf, type E2ePolicy, type E2eProject, type E2eScenario } from "./policy.js";

export interface InputFile { path: string; sha256: string; /** POSIX mode bits (0o777 mask); absent only on legacy receipts. */ mode?: number; }
export interface CollectedInputs { files: InputFile[]; gaps: string[]; }
export interface ScenarioInputs {
    files: InputFile[]; contractCaseDigests: string[]; /** Expected digest per selected case id — what an executed case must match (F1). */ caseDigests: Record<string, string>; gaps: string[];
    /** Paths in `files` that an artifact glob covers: they ARE inputs (an edit moves the generation) but preparation may legitimately rewrite them, so the post-prepare drift check skips them. */ regenerated: string[];
}
export interface ScenarioGeneration {
    generation: string; inputs: ScenarioInputs; gaps: string[];
    /** The commit the scenario's proof revision resolves to NOW (review D3): part of the generation, so a moved ref is a new generation, and what qualification compares a receipt's comparison identity against. */ comparison?: string;
}

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".interlinked", "target", "__pycache__", ".venv"]);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MODE_MASK = 0o777;

function identify(absolute: string, path: string): InputFile {
    return { path, sha256: digestOf(readFileSync(absolute)), mode: lstatSync(absolute).mode & MODE_MASK };
}
function skipDirectory(name: string, path: string, globs: string[]): boolean {
    if (!SKIPPED_DIRECTORIES.has(name)) return false;
    return !globs.some(glob => glob === path || glob.startsWith(`${path}/`)); // a declared glob rooted in the directory keeps it
}
/** Could a file under directory `path` match `glob`? Segment-wise: `**` descends anywhere; a literal or wildcard segment must match the directory segment (round 3, G2). */
function globCouldDescend(path: string, glob: string): boolean {
    const dirs = path.split("/"), parts = glob.split("/");
    for (let index = 0; index < dirs.length; index += 1) {
        const part = parts[index];
        if (part === undefined) return false;
        if (part === "**") return true;
        if (!matchesGlob(dirs[index]!, part)) return false;
    }
    return parts.length > dirs.length;
}
/** A declared input sits at or under this path, so a link here hides declared inputs behind a live reference (F2). */
function coversDeclaredInputs(path: string, globs: string[]): boolean {
    return matchesAnyGlob(path, globs) || globs.some(glob => globCouldDescend(path, glob));
}
/** Why a matching entry cannot be captured, or null when it can. */
function captureGap(entry: Dirent, absolute: string, path: string, count: number): string | null {
    if (count >= MAX_FILES) return `input ${path} not captured: more than ${MAX_FILES} declared inputs`;
    if (!entry.isFile()) return `input ${path} not captured: not a regular file`;
    if (lstatSync(absolute).size > MAX_FILE_BYTES) return `input ${path} not captured: larger than ${MAX_FILE_BYTES} bytes`;
    return null;
}
function visit(root: string, absolute: string, entry: Dirent, globs: string[], out: CollectedInputs): void {
    const path = relative(root, absolute).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) { if (coversDeclaredInputs(path, globs)) out.gaps.push(`input ${path} not captured: symbolic link`); return; }
    if (entry.isDirectory()) { if (!skipDirectory(entry.name, path, globs)) walk(root, absolute, globs, out); return; }
    if (!matchesAnyGlob(path, globs)) return;
    const gap = captureGap(entry, absolute, path, out.files.length);
    if (gap) out.gaps.push(gap); else out.files.push(identify(absolute, path));
}
function walk(root: string, directory: string, globs: string[], out: CollectedInputs): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) visit(root, join(directory, entry.name), entry, globs, out);
}
/** Files under `projectRoot` matching `globs`, sorted, with every omission reported. `.git`/`node_modules`/`.interlinked` are skipped unless a glob names them. */
export function collectProjectInputs(projectRoot: string, globs: string[]): CollectedInputs {
    const out: CollectedInputs = { files: [], gaps: [] };
    if (globs.length && existsSync(projectRoot)) walk(projectRoot, projectRoot, globs, out);
    out.files.sort((a, b) => a.path.localeCompare(b.path));
    return out;
}
function addFile(projectRoot: string, path: string, inputs: ScenarioInputs, required: boolean): void {
    try { inputs.files.push(identify(contractPath(projectRoot, path), path)); }
    catch { if (required) inputs.gaps.push(`contract input ${path} is absent`); }
}
/** Review round 3: a proof's action cases must EXECUTE before their designated observation; the runner follows manifest order, so a reversed manifest is a gap before anything runs. */
function actionOrderGaps(cases: readonly ContractCase[], scenario: E2eScenario, manifestPath: string, inputs: ScenarioInputs): void {
    const position = new Map(cases.map((row, index) => [row.id, index]));
    for (const entry of scenario.proof?.designated ?? []) {
        const own = position.get(entry.id);
        for (const action of entry.action ?? []) {
            const at = position.get(action);
            if (own !== undefined && at !== undefined && at >= own) inputs.gaps.push(`proof designated ${entry.id} names action ${action}, but ${manifestPath} executes ${action} after it; a prerequisite must run before the designated observation`);
        }
    }
}
function manifestCases(projectRoot: string, manifestPath: string, scenario: E2eScenario, inputs: ScenarioInputs): ContractCase[] {
    let content: string;
    try { content = readContractFile(projectRoot, manifestPath); }
    catch { inputs.gaps.push(`contract manifest ${manifestPath} is absent or unreadable`); return []; }
    inputs.files.push({ path: manifestPath, sha256: digestOf(content) });
    let cases: ContractCase[];
    try { cases = parseContractManifest(content).cases; }
    catch (error) { inputs.gaps.push(`contract manifest ${manifestPath} is invalid: ${error instanceof Error ? error.message : String(error)}`); return []; }
    actionOrderGaps(cases, scenario, manifestPath, inputs);
    const selected: ContractCase[] = [];
    for (const id of scenario.contractIds) {
        const row = cases.find(item => item.id === id);
        if (row) selected.push(row); else inputs.gaps.push(`contract case ${id} is not declared in ${manifestPath}`);
    }
    return selected;
}
/** Any argv token that resolves to a regular file (absolute, or relative to the project) is a direct executable/script input (R9, F3). Returns the project-relative paths it captured. */
function argvFileIdentity(projectRoot: string, argv: readonly string[], skip: (token: string) => boolean, inputs: ScenarioInputs): string[] {
    const captured: string[] = [];
    for (const token of argv) {
        if (skip(token)) continue;
        const absolute = isAbsolute(token) ? token : join(projectRoot, token);
        if (!existsSync(absolute) || !lstatSync(absolute).isFile()) continue;
        const path = isAbsolute(token) ? token : token.replace(/^\.\//, "");
        try { inputs.files.push(identify(absolute, path)); captured.push(path); }
        catch { inputs.gaps.push(`executable ${token} not captured`); }
    }
    return captured;
}
/**
 * One declared case input. Not artifact-covered: a required input. Artifact-covered and absent: preparation produces it (bound at
 * run time via receipt.artifacts). Artifact-covered and EXISTING (round-5 F1): still an input — its bytes join the generation so an
 * edit goes stale no matter how the glob was inferred (textual write evidence is never load-bearing for freshness) — and marked
 * `regenerated` so the post-preparation drift check tolerates the build rewriting it.
 */
function addDeclaredInput(projectRoot: string, path: string, artifacts: string[], inputs: ScenarioInputs): void {
    if (!matchesAnyGlob(path, artifacts)) { addFile(projectRoot, path, inputs, true); return; }
    if (!existsSync(contractPath(projectRoot, path))) return;
    addFile(projectRoot, path, inputs, false);
    inputs.regenerated.push(path);
}
function addCaseInputs(projectRoot: string, row: ContractCase, artifacts: string[], inputs: ScenarioInputs): void {
    inputs.contractCaseDigests.push(contractDigest(row));
    inputs.caseDigests[row.id] = contractDigest(row);
    addFile(projectRoot, row.source.path, inputs, true); // the cited requirement (R1): a changed citation is a changed input
    for (const path of row.inputs) addDeclaredInput(projectRoot, path, artifacts, inputs);
    if (row.runner.kind !== "process") return;
    const captured = argvFileIdentity(projectRoot, row.runner.argv, token => row.inputs.includes(token), inputs);
    inputs.regenerated.push(...captured.filter(path => matchesAnyGlob(path, artifacts)));
}
function dedupe(files: InputFile[]): InputFile[] {
    const byPath = new Map<string, InputFile>();
    for (const file of files) byPath.set(file.path, file);
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
function repositoryShared(root: string, project: E2eProject, globs: string[], inputs: ScenarioInputs): void {
    const collected = collectProjectInputs(root, globs);
    const prefix = project.root === "." ? "" : `${project.root}/`;
    for (const file of collected.files) inputs.files.push({ ...file, path: file.path.startsWith(prefix) ? file.path.slice(prefix.length) : `../${file.path}` });
    inputs.gaps.push(...collected.gaps);
}
/** Cited sources of expectations bound to the scenario (F3): a rewritten citation invalidates current evidence. */
function boundExpectationSources(projectRoot: string, policy: E2ePolicy, scenario: E2eScenario, inputs: ScenarioInputs): void {
    for (const id of scenario.expectationIds ?? []) {
        const row = policy.expectations.find(item => item.id === id);
        for (const source of row?.sources ?? []) addFile(projectRoot, source.path, inputs, false);
    }
}
/** Every declared input the scenario depends on. Gaps are reported, never guessed around. */
export function scenarioInputs(root: string, policy: E2ePolicy, project: E2eProject, scenario: E2eScenario): ScenarioInputs {
    const projectRoot = project.root === "." ? root : join(root, project.root);
    const inputs: ScenarioInputs = { files: [], contractCaseDigests: [], caseDigests: {}, gaps: [], regenerated: [] };
    const local = collectProjectInputs(projectRoot, [...scenario.affects, ...(project.sharedInputs ?? [])]);
    inputs.files.push(...local.files);
    inputs.gaps.push(...local.gaps);
    if (policy.sharedInputs?.length) repositoryShared(root, project, policy.sharedInputs, inputs);
    addFile(projectRoot, CONTRACT_POLICY, inputs, false); // acceptance is an input (R1): revoking it moves the generation
    boundExpectationSources(projectRoot, policy, scenario, inputs);
    const suite = project.suites.find(item => item.id === scenario.suite);
    const artifacts = suite?.artifacts ?? [];
    // Build scripts and the structured test command (C2) are inputs (F3) and hold a SOURCE role whatever artifact glob covers them (round-7 H2); only existing files are captured, so a not-yet-built token is harmless.
    for (const step of [...(suite?.prepare ?? []), ...(suite?.run ? [suite.run] : [])]) argvFileIdentity(projectRoot, step.argv, () => false, inputs);
    // Everything collected so far holds a SOURCE role (affects, shared inputs, acceptance, citations, build scripts). Round-6 G1: an
    // artifact glob may add a "regenerated" role to a case input, but it never removes a source role — a source keeps its drift check.
    const sourceRoles = new Set(inputs.files.map(file => file.path));
    // An owned service's executable (D1) is an input like a case executable (review D4): its current bytes join the generation, and an
    // artifact-covered one is `regenerated` — the declared build may rewrite it — unless a declaration above already gave it a source role.
    for (const service of suite?.services ?? []) inputs.regenerated.push(...argvFileIdentity(projectRoot, service.argv, () => false, inputs).filter(path => matchesAnyGlob(path, artifacts)));
    for (const row of manifestCases(projectRoot, project.contractManifest ?? CONTRACT_MANIFEST, scenario, inputs)) addCaseInputs(projectRoot, row, artifacts, inputs);
    inputs.files = dedupe(inputs.files);
    inputs.contractCaseDigests.sort();
    inputs.regenerated = [...new Set(inputs.regenerated)].filter(path => !sourceRoles.has(path)).sort();
    return inputs;
}
/** The commit a proof revision resolves to NOW in the project's repository (review D3): the comparison's immutable identity, or null when the ref does not resolve. */
export function resolveProofRevision(projectRoot: string, revision: string): string | null {
    try {
        const sha = execFileSync("git", ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
    } catch { return null; }
}
/** A revision-based proof's comparator, resolved BEFORE admission; an unresolvable ref is a gap — the comparison it would select is unknown. */
function comparisonIdentity(projectRoot: string, scenario: E2eScenario, inputs: ScenarioInputs): string | undefined {
    const revision = scenario.proof?.revision;
    if (revision === undefined) return undefined;
    const sha = resolveProofRevision(projectRoot, revision);
    if (sha === null) { inputs.gaps.push(`proof revision "${revision}" does not resolve to a commit in the project repository`); return undefined; }
    return sha;
}
/** The generation string a receipt must match exactly to satisfy this scenario. */
export function scenarioGeneration(root: string, policy: E2ePolicy, policyDigest: string, project: E2eProject, scenario: E2eScenario, gitRoot: string = root): ScenarioGeneration {
    const inputs = scenarioInputs(root, policy, project, scenario);
    // F1: inputs come from `root` (which may be a disposable export of the index or a revision); refs resolve in the real repository.
    const comparison = comparisonIdentity(project.root === "." ? gitRoot : join(gitRoot, project.root), scenario, inputs);
    const payload: Record<string, unknown> = { policyDigest, projectId: project.id, scenarioId: scenario.id, files: inputs.files.map(file => [file.path, file.sha256, file.mode ?? null]), contractCaseDigests: inputs.contractCaseDigests };
    if (comparison !== undefined) payload.comparison = comparison; // D3: a ref that moved selects a different comparison — a different generation
    const result: ScenarioGeneration = { generation: digestOf(payload), inputs, gaps: inputs.gaps };
    if (comparison !== undefined) result.comparison = comparison;
    return result;
}
