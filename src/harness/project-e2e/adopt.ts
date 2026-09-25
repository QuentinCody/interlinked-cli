// ===========================================
// Adoption — write EXPLICITLY selected configuration
// ===========================================
// Plan 31 §5.1 step 3. Adoption takes a reviewed proposal (a discovery
// report or a policy document), narrows it to the selected projects and
// scenarios, forces advisory mode unless required mode was explicitly
// requested, strips every expectation record (inferred behavior is never
// adopted), validates the result with the strict parser, and only then
// writes `.interlinked/e2e-policy.json`. An existing policy is never
// overwritten without `replace`. It installs nothing.

import { existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONTRACT_MANIFEST, readContractFile } from "../contracts/paths.js";
import { parseContractManifest } from "../contracts/schema.js";
import { artifactConflictsOf, contractPaths, type DiscoveryReport } from "./discover.js";
import { matchesAnyGlob } from "../../lib/path-glob.js";
import { collectProjectInputs } from "./generation.js";
import { E2E_POLICY_PATH, parseE2ePolicy, type E2ePolicy, type E2eProject, type E2eSuite } from "./policy.js";

export interface AdoptOptions {
    root: string; proposal: DiscoveryReport | E2ePolicy; projectIds?: string[]; scenarioIds?: string[];
    /** Only an explicit "required" produces a required-mode project; a proposal's own mode is ignored. */ mode?: "advisory" | "required";
    replace?: boolean; atMs: number;
}
export interface AdoptResult { path: string; policy: E2ePolicy; written: boolean; notes: string[]; }

function fail(message: string): never { throw new Error(`e2e adopt: ${message}`); }
function policyOf(proposal: DiscoveryReport | E2ePolicy): E2ePolicy {
    // SAFETY: a deep JSON copy so adoption never mutates the caller's report; the strict parser validates the result before any write.
    return JSON.parse(JSON.stringify("proposal" in proposal ? proposal.proposal : proposal)) as E2ePolicy;
}
function selectProjects(policy: E2ePolicy, ids: readonly string[] | undefined): E2eProject[] {
    if (!ids?.length) return policy.projects;
    for (const id of ids) if (!policy.projects.some(project => project.id === id)) fail(`unknown project ${id}; discovered: ${policy.projects.map(project => project.id).join(", ") || "none"}`);
    return policy.projects.filter(project => ids.includes(project.id));
}
function selectScenarios(projects: E2eProject[], ids: readonly string[] | undefined): E2eProject[] {
    if (!ids?.length) return projects;
    for (const id of ids) if (!projects.some(project => project.scenarios.some(scenario => scenario.id === id))) fail(`unknown scenario ${id}; proposed: ${projects.flatMap(project => project.scenarios.map(scenario => scenario.id)).join(", ") || "none"}`);
    return projects.map(project => ({ ...project, scenarios: project.scenarios.filter(scenario => ids.includes(scenario.id)) }));
}
function applyMode(projects: E2eProject[], mode: AdoptOptions["mode"], notes: string[]): E2eProject[] {
    const required = mode === "required";
    if (required) notes.push("required mode adopted explicitly (--mode required): every selected scenario gates completion");
    else if (projects.some(project => project.mode === "required" || project.scenarios.some(scenario => scenario.required))) notes.push("proposal asked for required mode; adoption keeps advisory until --mode required is passed explicitly");
    return projects.map(project => ({
        ...project, mode: required ? "required" : "advisory",
        scenarios: project.scenarios.map(scenario => { const { expectationIds: _dropped, ...rest } = scenario; return { ...rest, required }; }),
    }));
}
/** Paths the cases bound to THIS suite's scenarios declare (inputs + path-shaped argv); an unreadable manifest yields none here — doctor reports that separately. */
function suiteContractPaths(projectRoot: string, project: E2eProject, suiteId: string): string[] {
    const bound = new Set(project.scenarios.filter(scenario => scenario.suite === suiteId).flatMap(scenario => scenario.contractIds));
    try { return contractPaths(parseContractManifest(readContractFile(projectRoot, project.contractManifest ?? CONTRACT_MANIFEST)).cases.filter(row => bound.has(row.id))); }
    catch { return []; }
}
/** The refusal text for one suite's conflicts, or null when its artifact globs are consistent with its OWN preparation (round-5 F2: another suite's writer proves nothing). */
function suiteArtifactRefusal(projectRoot: string, project: E2eProject, suite: E2eSuite): string | null {
    const conflicts = artifactConflictsOf(projectRoot, suite.artifacts ?? [], suiteContractPaths(projectRoot, project, suite.id), suite.prepare ?? []);
    if (!conflicts.length) return null;
    const detail = conflicts.map(row => `${row.glob} covers ${row.inputs.join(", ")}`).join("; ");
    return `project ${project.id}, suite ${suite.id}: ${detail} — existing declared input(s) this suite's preparation gives no sign of writing; the artifact glob claims they are generated. Narrow suites[].artifacts, or remove the input from the case`;
}
/**
 * D1/F2: judged per SELECTED suite (one with a scenario). Freshness itself never depends on this: generation.ts keeps every
 * existing artifact-covered input in the generation. This check is about an honest configuration, not the invariant.
 */
function requireArtifactsSound(projectRoot: string, project: E2eProject): void {
    for (const suite of project.suites.filter(suite => project.scenarios.some(scenario => scenario.suite === suite.id))) {
        const refusal = suiteArtifactRefusal(projectRoot, project, suite);
        if (refusal) fail(refusal);
        requireArtifactsNotSource(projectRoot, project, suite);
    }
}
/** Round-6 G1: an artifact glob that covers a PROTECTED source (protectedInputs, a scenario's affects, sharedInputs) would let preparation replace the code under test; the roles are incompatible. */
function requireArtifactsNotSource(projectRoot: string, project: E2eProject, suite: E2eSuite): void {
    const artifacts = suite.artifacts ?? [];
    if (!artifacts.length) return;
    const sourceGlobs = [...project.protectedInputs, ...(project.sharedInputs ?? []), ...project.scenarios.filter(scenario => scenario.suite === suite.id).flatMap(scenario => scenario.affects)];
    const prepareScripts = [...(suite.prepare ?? []), ...(suite.run ? [suite.run] : [])].flatMap(step => step.argv.map(token => token.replace(/^\.\//, ""))).filter(token => existsSync(join(projectRoot, token)) && lstatSync(join(projectRoot, token)).isFile()); // round-7 H2; C2 run argv
    const covered = [...collectProjectInputs(projectRoot, sourceGlobs).files.map(file => file.path), ...prepareScripts].filter(path => matchesAnyGlob(path, artifacts));
    if (covered.length) fail(`project ${project.id}, suite ${suite.id}: artifacts ${artifacts.join(", ")} cover protected source ${covered.join(", ")}; a build output cannot also be the code under test — preparation would replace it before the cases run. Remove the glob or the source declaration`);
}
/** Required mode certifies completion, so it must have something to certify (B1): scenarios to run, protected inputs that exist, artifacts that hide no input. */
function requireCertifiable(root: string, projects: readonly E2eProject[]): void {
    for (const project of projects) {
        if (!project.scenarios.length) fail(`project ${project.id} has no scenarios; required mode with no scenarios certifies nothing — declare contract cases (interlinked tests contracts import <doc>) and re-run discover, or adopt advisory`);
        const projectRoot = project.root === "." ? root : join(root, project.root);
        if (!collectProjectInputs(projectRoot, project.protectedInputs).files.length) fail(`project ${project.id}: protectedInputs ${JSON.stringify(project.protectedInputs)} match no file under ${project.root}; a required project with nothing protected would pass on any edit — declare the real source scope`);
        requireArtifactsSound(projectRoot, project);
    }
}
/** Discovery's structured conflicts travel into the adoption notes instead of dying with the report (D1). */
function conflictNotes(proposal: DiscoveryReport | E2ePolicy, projects: readonly E2eProject[]): string[] {
    if (!("projects" in proposal) || !("proposal" in proposal)) return [];
    const selected = new Set(projects.map(project => project.id));
    return proposal.projects.filter(found => selected.has(found.id)).flatMap(found => (found.build?.conflicts ?? []).map(row =>
        `${found.id}: ${row.inputs.join(", ")} kept in freshness tracking — ${row.glob} looked like build output but the build does not provably write the file(s), so the glob was not adopted; declare it in suites[].artifacts yourself if it really is generated`));
}
function writeAtomically(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, content, { mode: 0o644 });
    renameSync(temp, path);
}
/** Validates the selection fully before touching the filesystem; a refusal leaves no partial file. */
export function adoptPolicy(options: AdoptOptions): AdoptResult {
    const notes: string[] = [];
    const source = policyOf(options.proposal);
    if (Array.isArray(source.expectations) && source.expectations.length) notes.push(`${source.expectations.length} expectation record(s) dropped: expectations are never adopted from a proposal — propose them with tests e2e expectations propose`);
    const projects = applyMode(selectScenarios(selectProjects(source, options.projectIds), options.scenarioIds), options.mode, notes);
    const candidate = { ...source, projects, expectations: [] };
    const policy = parseE2ePolicy(JSON.stringify(candidate));
    if (options.mode === "required") requireCertifiable(options.root, policy.projects);
    notes.push(...conflictNotes(options.proposal, policy.projects));
    const path = join(options.root, E2E_POLICY_PATH);
    if (existsSync(path) && !options.replace) fail(`${E2E_POLICY_PATH} already exists; pass --replace to overwrite the reviewed policy (the previous file is discarded, not merged)`);
    writeAtomically(path, `${JSON.stringify(policy, null, 2)}\n`);
    notes.push(`wrote ${E2E_POLICY_PATH}: ${policy.projects.length} project(s), ${policy.projects.reduce((sum, project) => sum + project.scenarios.length, 0)} scenario(s); configuration alone produces no pass — run interlinked tests e2e run`);
    return { path: E2E_POLICY_PATH, policy, written: true, notes };
}
