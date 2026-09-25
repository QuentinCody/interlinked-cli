// ===========================================
// `tests e2e scaffold <name>` — a proposed scenario with explicit assumptions (Unit E3, plan §14)
// ===========================================
// Proposes ONE scenario for a declared suite plus the skeleton its adapter
// needs: a Playwright spec whose only assertion fails deliberately, or a
// proposed contract case whose expectation is a placeholder that cannot
// match. Every assumption is written where the author must replace it; a
// deliberate failure earns no pass, and the policy itself is never edited —
// the proposed scenario is printed for review, never adopted.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONTRACT_MANIFEST } from "../contracts/paths.js";
import { loadE2ePolicy, type E2eProject, type E2eSuite } from "./policy.js";

export interface ScaffoldOptions { root: string; name: string; projectId?: string; suiteId?: string; }
export interface ScaffoldFile { path: string; content: string; }
export interface ScaffoldResult { project: E2eProject; suite: E2eSuite; scenario: Record<string, unknown>; files: ScaffoldFile[]; notes: string[]; }

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SCAFFOLD_DIRECTORY = ".interlinked/e2e-scaffold";
const SPEC_TITLE = "REPLACE: the user-observable outcome";
const CONTRACT_PLACEHOLDER = "REPLACE-with-a-declared-contract-case-id";

function pick<T extends { id: string }>(rows: readonly T[], id: string | undefined, kind: string): T {
    if (id !== undefined) { const row = rows.find(item => item.id === id); if (!row) throw new Error(`unknown ${kind} ${id}; declared: ${rows.map(item => item.id).join(", ") || "none"}`); return row; }
    if (rows.length !== 1) throw new Error(`${rows.length} ${kind}s declared; pass --${kind} <id> (${rows.map(item => item.id).join(", ") || "none"})`);
    return rows[0]!;
}
function playwrightSpec(name: string, projectName: string): string {
    return [
        `// Scaffolded by \`interlinked tests e2e scaffold ${name}\`. Every ASSUMPTION below is yours to replace;`,
        "// the deliberate failure at the end earns no pass until it becomes the observed outcome.",
        'import { expect, test } from "@playwright/test";',
        "",
        `test.describe("${name}", () => {`,
        `    test("${SPEC_TITLE}", async ({ page }) => {`,
        "        // ASSUMPTION: the entry page and the action a user takes.",
        '        await page.goto("/");',
        "        // ASSUMPTION: the user-observable outcome (text, URL, a row that appears), not an internal state.",
        '        await expect(page.locator("body"), "deliberate failure: replace with the observed outcome").toHaveText("REPLACE: the exact outcome the user sees");',
        "    });",
        "});",
        "",
        `// Playwright project: ${projectName}. The case id the scenario binds is the reporter's title path, so keep the describe/test titles in step with caseIds.`,
        "",
    ].join("\n");
}
function contractSkeleton(name: string, executable: string): string {
    return `${JSON.stringify({
        id: name, description: "ASSUMPTION: what this case proves, in the requirement's words",
        source: { kind: "requirement", path: "REQUIREMENTS.md", sha256: "REPLACE: contractDigest of the cited document", quote: "REPLACE: the exact sentence this case cites" },
        inputs: [], runner: { kind: "process", argv: [executable, "REPLACE: the arguments a user would pass"] },
        expect: { exitCode: 0, stdout: "REPLACE: the exact output; a placeholder can never match, so this case fails until it is real" },
    }, null, 2)}\n`;
}
function forSuite(name: string, project: E2eProject, suite: E2eSuite): { files: ScaffoldFile[]; scenario: Record<string, unknown>; notes: string[] } {
    const base = { id: name, suite: suite.id, description: "ASSUMPTION: the behavior a user relies on", affects: [], required: false };
    if (suite.adapter === "playwright") {
        const path = `tests/${name}.spec.mjs`, projectName = "chromium";
        const caseId = `${path.replace(/^tests\//, "")} › ${name} › ${SPEC_TITLE} [${projectName}]`; // the reporter names files relative to testDir
        return { files: [{ path, content: playwrightSpec(name, projectName) }], scenario: { ...base, contractIds: [CONTRACT_PLACEHOLDER], caseIds: [caseId], boundary: { entry: "browser", service: suite.services?.[0]?.id ?? "REPLACE", real: ["application"], requests: [{ method: "POST", path: "/REPLACE-the-operation-under-test" }] } }, notes: ["boundary.requests names the API operation the page must drive through the owned app; a page load alone earns no boundary",`caseIds names the Playwright project "${projectName}" and a file relative to the playwright testDir; change both to match your config`, `contractIds must bind at least one portable contract case: replace ${CONTRACT_PLACEHOLDER} with a declared case id (the parser refuses an empty list, and an undeclared id is a SCOPE gap)`] };
    }
    if (suite.adapter === "structured-runner") return { files: [], scenario: { ...base, contractIds: [CONTRACT_PLACEHOLDER], caseIds: [`REPLACE: a case id from ${suite.report?.path ?? "the report"}`] }, notes: ["a structured-runner scenario binds native case ids from the suite's report and at least one portable contract case (contractIds)"] };
    const executable = suite.artifacts?.[0]?.replace(/\*.*$/, "") ?? "REPLACE: the public executable";
    return { files: [{ path: `${SCAFFOLD_DIRECTORY}/${name}.contract.json`, content: contractSkeleton(name, executable) }], scenario: { ...base, contractIds: [name], boundary: { entry: "process", real: ["application"] } }, notes: [`add the proposed case to ${project.contractManifest ?? CONTRACT_MANIFEST}, propose a linked expectation with interlinked tests e2e expectations propose --from draft.json, review it, then record the exact revision decision with interlinked tests e2e expectations accept --from decision.json`] };
}
/** The proposal: scenario JSON to paste into the policy, skeleton files, and the assumptions the author owns. Nothing is written. */
export function scaffoldScenario(options: ScaffoldOptions): ScaffoldResult {
    if (!NAME.test(options.name)) throw new Error("scaffold name must match [a-z0-9][a-z0-9._-]{0,63}");
    const loaded = loadE2ePolicy(options.root);
    if (loaded.status === "unconfigured") throw new Error("no .interlinked/e2e-policy.json; run interlinked tests e2e discover --out report.json, review it, then tests e2e adopt --from report.json");
    if (loaded.status === "invalid") throw new Error(`policy invalid: ${loaded.reason}`);
    const project = pick(loaded.policy.projects, options.projectId, "project");
    const suite = pick(project.suites, options.suiteId, "suite");
    if (project.scenarios.some(row => row.id === options.name)) throw new Error(`project ${project.id} already declares scenario ${options.name}`);
    const proposal = forSuite(options.name, project, suite);
    const notes = [...proposal.notes, "the scenario is proposed with required: false and an empty affects list; add the globs the behavior depends on and flip required only after the case passes for a real reason", "a deliberate failure is never a pass: tests e2e run reports it CASE_FAILED until the assumption is replaced by the observed outcome"];
    return { project, suite, scenario: proposal.scenario, files: proposal.files, notes };
}
/** Writes the skeleton files (never the policy); refuses to overwrite anything. Returns the absolute paths written. */
export function writeScaffold(root: string, result: ScaffoldResult): string[] {
    const projectRoot = result.project.root === "." ? root : join(root, result.project.root);
    const targets = result.files.map(file => ({ ...file, absolute: join(projectRoot, file.path) }));
    for (const target of targets) if (existsSync(target.absolute)) throw new Error(`${target.path} already exists; the scaffold never overwrites`);
    for (const target of targets) { mkdirSync(dirname(target.absolute), { recursive: true }); writeFileSync(target.absolute, target.content); }
    return targets.map(target => target.absolute);
}
