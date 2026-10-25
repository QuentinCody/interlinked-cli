// ===========================================
// fail-before-fix — does each test a session wrote fail on the code from before that session?
// ===========================================
// 1. The session's applied edits come from the harness log (`edit-log.ts`); its files split into product and test.
// 2. Each file is replayed from `git show HEAD:<file>` through EVERY logged edit since HEAD's commit (any session);
//    the replay must reproduce the current bytes, and the state before the session's first edit is its
//    pre-session code (`replay.ts`). A product file that does not replay makes the whole run unavailable.
// 3. The session's test files run against the live tree and against a git-visible copy whose product files hold
//    the pre-session code (`snapshot.ts`); each test gets a verdict (`classify.ts`).
// Advisory evidence: it never blocks, and it says "unavailable" instead of guessing. Plan 32 build item 6.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { isTestSourcePath } from "../checks/shared-test-classification.js";
import { runArgvInOverlay } from "../overlay-command-runner.js";
import { parseImports } from "../project-graph/parser-imports.js";
import { resolveImportPath } from "../project-graph/resolve.js";
import { classifyTest, isNewTest, parseVitestReport, type TestVerdict, type VitestCase } from "./classify.js";
import { readEditEvents } from "./edit-log.js";
import { replayFile, type FileReplay, type FileState } from "./replay.js";
import { createProjectCopy, gitVisibleFiles } from "./snapshot.js";

export interface FailBeforeFixOptions { root: string; session: string; budgetMs: number; }
export interface FileReport { path: string; role: FileRole; state: "reverted" | "unavailable"; reason?: string; }
/** test = a test source; product = code a test can import; other = docs, data and the root `scratch/` probe dir. */
export type FileRole = "test" | "product" | "other";
const CODE = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|rb|php|swift)$/;
export function fileRole(path: string): FileRole {
    if (isTestSourcePath(path)) return "test";
    return CODE.test(path) && !path.startsWith("scratch/") ? "product" : "other";
}
/** `subjectChanged`: the session edited the code this test file covers (its companion module, or code beside it) —
 *  a new test that passes on the pre-session code is a concern only then; otherwise it strengthens old behavior. */
export interface TestReport { file: string; name: string; isNew: boolean; subjectChanged: boolean; verdict: TestVerdict; before?: string; }
export interface FailBeforeFixReport {
    status: "ok" | "unavailable" | "no-session" | "no-tests"; session: string; base: string | null;
    files: FileReport[]; tests: TestReport[]; reasons: string[]; copyDir?: string;
    /** Replayed edits taken from the transcript timeline because the collection log has no row for them. */
    recovered?: number;
}

function git(root: string, args: string[]): string | null {
    try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }); } catch { return null; }
}
function current(root: string, path: string): FileState {
    return existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
}

async function replays(root: string, session: string, paths: Set<string>): Promise<{ base: string | null; rows: FileReplay[]; recovered: number; reason?: string }> {
    const head = git(root, ["rev-parse", "--verify", "HEAD"])?.trim() ?? null, when = git(root, ["log", "-1", "--format=%cI", "HEAD"])?.trim();
    if (!head || !when) return { base: null, rows: [], recovered: 0, reason: "fail-before-fix needs a git HEAD to start each replay from" };
    const since = new Date(when).toISOString();
    let events = await readEditEvents({ root, paths, since, archives: false });
    const replayAll = () => [...paths].sort().map(path => replayFile(path, git(root, ["show", `HEAD:${path}`]), events.filter(event => event.path === path), session, current(root, path)));
    let rows = replayAll();
    if (rows.some(row => !row.ok)) { // HEAD may predate the live log: read the rotated segments too
        events = await readEditEvents({ root, paths, since, archives: true });
        rows = replayAll();
    }
    return { base: head, rows, recovered: events.filter(event => event.source === "timeline").length };
}

/** Runs `files` with vitest's JSON reporter in `dir` (a project root or a copy); no report = no rows, never a pass. */
export async function runVitest(dir: string, files: readonly string[], budgetMs: number): Promise<VitestCase[]> {
    if (!files.length || files.some(file => !existsSync(join(dir, file)))) return [];
    const reports = mkdtempSync(join(tmpdir(), "interlinked-fbf-report-")), report = join(reports, "report.json");
    try {
        const env = Object.fromEntries(Object.entries({ ...process.env, CI: "1", NO_COLOR: "1" }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        const result = await runArgvInOverlay(["vitest", "run", ...files, "--reporter=json", `--outputFile=${report}`], dir, budgetMs, undefined, env);
        if (result.timedOut || result.error || result.exitCode === null) return [];
        return existsSync(report) ? parseVitestReport(readFileSync(report, "utf8"), dir) : [];
    } finally { rmSync(reports, { recursive: true, force: true }); }
}

function fileReports(rows: readonly FileReplay[]): FileReport[] {
    return rows.filter(row => !row.ok || row.touched).map(row => {
        const role = fileRole(row.path);
        return row.ok ? { path: row.path, role, state: "reverted" as const } : { path: row.path, role, state: "unavailable" as const, reason: row.reason };
    });
}

/** The pre-session version of a test file runs beside it in the copy under this name, so "existing" means "the old
 *  file reported this test name" — generated titles (loops, it.each) are not literal in the source. */
function baselinePath(path: string): string | null {
    const named = path.replace(/(\.(?:test|spec)\.[cm]?[jt]sx?)$/, ".fbf-baseline$1");
    return named === path ? null : named;
}

/** The session changed what the test reaches: its companion module, or a module it imports at runtime (type-only
 *  imports excluded). A changed sibling the test never imports is not its subject (2026-10-22 dogfood: the old
 *  same-directory rule made 14 of 16 "concerns" in a 200-file directory). A black-box test imports no subject. */
export function subjectChanged(root: string, testFile: string, product: ReadonlySet<string>): boolean {
    const companion = testFile.replace(/\.(?:test|spec)(\.[cm]?[jt]sx?)$/, "$1");
    if (product.has(companion)) return true;
    const content = current(root, testFile), from = join(root, testFile);
    if (content === null) return false;
    return parseImports(content, from).some(edge => {
        const target = edge.isTypeOnly ? null : resolveImportPath(from, edge.specifier);
        return target !== null && product.has(relative(root, target));
    });
}

interface TestContext { root: string; post: readonly VitestCase[]; pre: readonly VitestCase[]; rows: readonly FileReplay[]; product: ReadonlySet<string>; }
function testReports(ctx: TestContext): TestReport[] {
    const before = new Map(ctx.pre.map(row => [`${row.file}\0${row.name}`, row]));
    const preSession = new Map(ctx.rows.flatMap(row => (row.ok && row.touched ? [[row.path, row.preSession] as const] : [])));
    const existing = (file: string): Set<string> | null => {
        const baseline = baselinePath(file);
        const names = ctx.pre.filter(row => row.file === baseline).map(row => row.name);
        return baseline && names.length ? new Set(names) : null;
    };
    return ctx.post.map(row => {
        const old = before.get(`${row.file}\0${row.name}`), names = existing(row.file);
        const isNew = names ? !names.has(row.name) : isNewTest(preSession.get(row.file) ?? null, row.title);
        const report: TestReport = { file: row.file, name: row.name, isNew, subjectChanged: subjectChanged(ctx.root, row.file, ctx.product), verdict: classifyTest(row, old) };
        if (old?.message) report.before = old.message;
        return report;
    });
}

/** Product + other files go back to their pre-session bytes; each changed test keeps its current bytes and gains a baseline twin. */
function preOverrides(rows: readonly FileReplay[], tests: readonly string[]): Map<string, FileState> {
    const overrides = new Map<string, FileState>();
    for (const row of rows) {
        if (!row.ok || !row.touched) continue;
        if (fileRole(row.path) !== "test") overrides.set(row.path, row.preSession);
        else if (tests.includes(row.path) && row.preSession !== null && baselinePath(row.path)) overrides.set(baselinePath(row.path) ?? "", row.preSession);
    }
    return overrides;
}

export async function failBeforeFix(options: FailBeforeFixOptions): Promise<FailBeforeFixReport> {
    const { root, session } = options;
    const own = await readEditEvents({ root, session, archives: false });
    const report: FailBeforeFixReport = { status: "ok", session, base: null, files: [], tests: [], reasons: [] };
    if (!own.length) return { ...report, status: "no-session", reasons: [`no applied edits for session ${session} in the live harness log`] };
    const replayed = await replays(root, session, new Set(own.map(event => event.path)));
    report.base = replayed.base;
    report.files = fileReports(replayed.rows);
    if (replayed.recovered) report.recovered = replayed.recovered;
    if (replayed.reason) return { ...report, status: "unavailable", reasons: [replayed.reason] };
    const tests = report.files.filter(row => row.role === "test" && current(root, row.path) !== null).map(row => row.path);
    if (!tests.length) return { ...report, status: "no-tests", reasons: ["the session changed no test file; there is nothing to judge"] };
    const blocked = report.files.filter(row => row.role === "product" && row.state === "unavailable");
    if (blocked.length) return { ...report, status: "unavailable", reasons: blocked.map(row => `${row.path}: ${row.reason}`) };
    report.reasons = report.files.filter(row => row.role === "other" && row.state === "unavailable").map(row => `${row.path} (not code, kept as is): ${row.reason}`);
    await judge(report, replayed.rows, tests, options);
    return report;
}

/** Live run, then the pre-session copy (with each changed test's baseline twin); the copy is always removed. */
async function judge(report: FailBeforeFixReport, rows: readonly FileReplay[], tests: readonly string[], options: FailBeforeFixOptions): Promise<void> {
    const overrides = preOverrides(rows, tests);
    const baselines = tests.map(baselinePath).filter((path): path is string => path !== null && overrides.has(path));
    const copy = createProjectCopy(options.root, gitVisibleFiles(options.root) ?? [], overrides);
    report.copyDir = copy.dir;
    try {
        const post = await runVitest(options.root, tests, options.budgetMs), pre = await runVitest(copy.dir, [...tests, ...baselines], options.budgetMs);
        const product = new Set(report.files.filter(row => row.role === "product").map(row => row.path));
        report.tests = testReports({ root: options.root, post, pre, rows, product });
        for (const [side, cases] of [["current", post], ["pre-session", pre]] as const) {
            const missing = tests.filter(file => !cases.some(row => row.file === file && ["passed", "failed"].includes(row.status)));
            if (missing.length) {
                report.status = "unavailable";
                report.reasons.push(`${side} run produced no executed test evidence for: ${missing.join(", ")}`);
            }
        }
    } finally { copy.cleanup(); }
}
