// Unit F5 (plan §12 CI row, §13 trust limits): `tests e2e ci` is a FRESH
// supervised run of the selected scenarios followed by the same check, with
// the trusted base taken from the CI event (or an explicit --base). A
// workstation receipt never satisfies CI: every satisfied required verdict
// must name a run id this invocation produced. No base and no event ⇒
// UNAVAILABLE, nothing runs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, injectPersistenceDefect, type FixtureProject } from "./__tests__/fixture-projects.js";
import { freshnessOf, resolveCiBase, runCi } from "./ci.js";
import type { ScenarioVerdict } from "./qualify.js";

const projects: FixtureProject[] = [];
const dirs: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const TIMEOUT = 180_000;
const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
function git(root: string, ...args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...ENV } }).trim(); }
function tracked(): FixtureProject {
    const project = fixtureProject("py", { accept: true });
    projects.push(project);
    git(project.root, "init", "--quiet", "-b", "main");
    git(project.root, "add", ".");
    git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "base");
    return project;
}
const ZERO = "0".repeat(40);
function eventFile(body: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "e2e-ci-event-")); dirs.push(dir);
    const path = join(dir, "event.json");
    writeFileSync(path, JSON.stringify(body));
    return path;
}
const AT_MS = 1_700_000_000_000;
const verdict = (runId: string | undefined, satisfied = true): ScenarioVerdict => ({ key: "p/s", projectId: "p", scenarioId: "s", required: true, satisfied, status: satisfied ? "satisfied" : "pending", generation: "g", reasons: [], advisories: [], dimensions: {} as ScenarioVerdict["dimensions"], ...(runId ? { runId } : {}) });

describe("ci — positive", () => {
    it("P1: the base comes from an explicit flag first, then the GitHub pull-request base ref, the push `before` sha, or the GitLab variables; a zero `before` is a bootstrap", () => {
        expect(resolveCiBase({ explicit: "abc", env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" } })).toEqual({ revision: "abc", source: "flag", bootstrap: false });
        expect(resolveCiBase({ env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" } })).toEqual({ revision: "refs/remotes/origin/main", source: "github-pull-request", bootstrap: false });
        const before = "b".repeat(40);
        expect(resolveCiBase({ env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventFile({ before }) } })).toEqual({ revision: before, source: "github-push", bootstrap: false });
        expect(resolveCiBase({ env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventFile({ before: ZERO }) } })).toEqual({ revision: null, source: "github-push", bootstrap: true });
        expect(resolveCiBase({ env: { GITLAB_CI: "true", CI_MERGE_REQUEST_DIFF_BASE_SHA: "c".repeat(40), CI_COMMIT_BEFORE_SHA: before } })).toEqual({ revision: "c".repeat(40), source: "gitlab-merge-request", bootstrap: false });
        expect(resolveCiBase({ env: { GITLAB_CI: "true", CI_COMMIT_BEFORE_SHA: ZERO } })).toEqual({ revision: null, source: "gitlab-push", bootstrap: true });
    });
    it("P2: a fresh supervised run followed by the check against the event base passes; every satisfied verdict names a run id this invocation produced, and the trust limits are printed", async () => {
        const project = tracked();
        const head = git(project.root, "rev-parse", "HEAD");
        const result = await runCi({ root: project.root, timeoutMs: TIMEOUT, atMs: AT_MS, base: { revision: head, source: "flag", bootstrap: false } });
        expect(result.exitCode, result.messages.join("\n")).toBe(0);
        expect(result.run.receipts.length).toBeGreaterThan(0);
        const freshIds = new Set(result.run.receipts.map(row => row.runId));
        for (const row of result.evaluation.verdicts) expect(freshIds.has(row.runId ?? "")).toBe(true);
        expect(result.evaluation.policy?.base.commit).toBe(head);
        expect(result.trust.join("\n")).toMatch(/receipts: this run only/);
        expect(result.trust.join("\n")).toMatch(/checker: /);
    }, TIMEOUT);
    it("P3: a bootstrap event (new branch, zero before-sha) runs and checks without a base comparison and says so", async () => {
        const project = tracked();
        const result = await runCi({ root: project.root, timeoutMs: TIMEOUT, atMs: AT_MS, base: { revision: null, source: "github-push", bootstrap: true } });
        expect(result.exitCode, result.messages.join("\n")).toBe(0);
        expect(result.evaluation.policy).toBeUndefined();
        expect(result.trust.join("\n")).toMatch(/bootstrap/);
    }, TIMEOUT);
});
describe("ci — negative (a workstation receipt is never CI evidence; no base is never HEAD)", () => {
    it("N1: a satisfied verdict whose run id is not from this invocation is NOT fresh — CI_RECEIPT_NOT_FRESH, exit 1; a fresh one and an unsatisfied one carry no freshness reason", () => {
        const fresh = new Set(["run-1"]);
        expect(freshnessOf(verdict("run-0"), fresh)).toEqual({ fresh: false, reason: "CI_RECEIPT_NOT_FRESH" });
        expect(freshnessOf(verdict(undefined), fresh)).toEqual({ fresh: false, reason: "CI_RECEIPT_NOT_FRESH" });
        expect(freshnessOf(verdict("run-1"), fresh)).toEqual({ fresh: true });
        expect(freshnessOf(verdict("run-0", false), fresh)).toEqual({ fresh: true }); // not satisfied: the verdict's own reasons already fail it
    });
    it("N2 (PE-37): no explicit base and no CI event ⇒ UNAVAILABLE (exit 2) and nothing runs — never a silent HEAD", async () => {
        const project = tracked();
        expect(resolveCiBase({ env: {} })).toEqual({ revision: null, source: "none", bootstrap: false });
        const result = await runCi({ root: project.root, timeoutMs: TIMEOUT, atMs: AT_MS, base: { revision: null, source: "none", bootstrap: false } });
        expect(result.exitCode).toBe(2);
        expect(result.run.receipts).toEqual([]);
        expect(result.messages.join("\n")).toMatch(/--base/);
    }, TIMEOUT);
    it("N3: a defect in the candidate fails the fresh run — exit 1 with a run id this invocation produced, whatever earlier receipts said", async () => {
        const project = tracked();
        const head = git(project.root, "rev-parse", "HEAD");
        const first = await runCi({ root: project.root, timeoutMs: TIMEOUT, atMs: AT_MS, base: { revision: head, source: "flag", bootstrap: false } });
        expect(first.exitCode).toBe(0);
        injectPersistenceDefect(project);
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-am", "regression"); // the candidate is the COMMIT (F-R3); an uncommitted defect is not judged
        const second = await runCi({ root: project.root, timeoutMs: TIMEOUT, atMs: AT_MS, base: { revision: head, source: "flag", bootstrap: false } });
        expect(second.exitCode).toBe(1);
        const freshIds = new Set(second.run.receipts.map(row => row.runId));
        expect(freshIds.size).toBeGreaterThan(0);
        expect(freshIds.has(first.run.receipts[0]!.runId)).toBe(false);
        expect(second.evaluation.verdicts.some(row => row.satisfied)).toBe(false);
    }, TIMEOUT);
});
