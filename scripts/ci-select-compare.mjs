// Unit 8 — selective CI in COMPARISON MODE (scratch/CAMPAIGN-verification-pipeline.md).
//
// `select`: plan the change against the CI event's base (`interlinked tests plan --base <sha> --json`) and write the
// selection: the tests that must run and the tests the plan OMITTED. The CI job then runs only `must_run`.
// `compare`: after the full lanes and the selected run finish, a SELECTION_MISS is a test file that failed in the
// full lanes but was in the omitted set. The row goes to the job summary and an artifact; nothing here fails the
// workflow on a miss — the selection decides nothing until it has a record (promotion: zero misses over ≥ 30
// SELECTIVE, complete runs; a widened plan cannot miss and so proves nothing).

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCiBase } from "./e2e-ci-base.mjs";

const REASON_KIND = /^([^:]+)(?::.*)?$/;

/** The distinct reason kinds (`Unknown or deleted input: x` and `…: y` are one kind), in first-seen order. */
function reasonKinds(reasons) {
    return [...new Set(reasons.map(reason => REASON_KIND.exec(reason)?.[1]?.trim() ?? reason))];
}

/**
 * The plan as the job's selection. `plan` is the parsed `tests plan --json` output (null when no base was resolved;
 * `{error}` when planning failed); either of those is UNAVAILABLE, never an empty selection.
 */
export function planSelection(plan, { head, base, issue = null }) {
    const unavailable = (why) => ({ version: 1, head, base, mode: "unavailable", selective: false, issue: why, must_run: [], omitted: [], universe: 0, reason_kinds: [] });
    if (plan === null) return unavailable(issue ?? "No comparison base");
    if (typeof plan.error === "string") return unavailable(plan.error);
    if (!Array.isArray(plan.tests) || !Array.isArray(plan.omitted) || (plan.mode !== "selected" && plan.mode !== "full")) return unavailable("Malformed test plan");
    const mustRun = plan.tests.map(test => test.path).sort(), omitted = [...plan.omitted].sort();
    return { version: 1, head, base, mode: plan.mode, selective: plan.mode === "selected" && omitted.length > 0, issue: null,
        must_run: mustRun, omitted, universe: mustRun.length + omitted.length, reason_kinds: reasonKinds(plan.reasons ?? []) };
}

/** Repo-relative paths of the test FILES a vitest JSON report marks failed; a file outside `root` keeps its absolute name. */
export function failingFiles(report, root) {
    if (!report || !Array.isArray(report.testResults)) throw new Error("Vitest JSON report has no testResults");
    const failed = [];
    for (const result of report.testResults) {
        if (typeof result?.name !== "string") throw new Error("Vitest JSON report entry has no file name");
        if (result.status !== "failed") continue;
        const path = relative(root, result.name);
        failed.push(path.startsWith("..") || isAbsolute(path) ? result.name : path.replaceAll("\\", "/"));
    }
    return [...new Set(failed)].sort();
}

/** Every `*.json` lane report in `directory`: the union of their failing files and how many lanes reported. */
export function readFullReports(directory, root) {
    const files = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".json")).sort() : [];
    const failed = new Set();
    for (const name of files) for (const path of failingFiles(JSON.parse(readFileSync(join(directory, name), "utf8")), root)) failed.add(path);
    return { lanesReported: files.length, fullFailed: [...failed].sort() };
}

/** A miss is evidence on its own: a missing lane or selected report never hides one. Only an absence of misses needs completeness. */
function rowStatus(selection, complete, misses) {
    if (misses.length) return "miss";
    if (selection.mode === "unavailable" || !complete) return "incomplete";
    return selection.selective ? "clean" : "widened";
}

/**
 * One comparison row. `fullFailed`: union of the full lanes' failing files. `selectedFailed`: the selected run's
 * failing files, or null when it did not run. A miss needs an OMITTED file; a failure outside the plan's universe
 * (another lane's config) and a failure only the selected run saw (order or isolation) are recorded apart.
 */
export function compareSelection(selection, { fullFailed, lanesReported, lanesExpected, selectedFailed }) {
    const omitted = new Set(selection.omitted), planned = new Set([...selection.must_run, ...selection.omitted]);
    const misses = fullFailed.filter(path => omitted.has(path));
    const complete = lanesReported >= lanesExpected && (!selection.selective || selectedFailed !== null);
    const status = rowStatus(selection, complete, misses);
    return { version: 1, head: selection.head, base: selection.base, mode: selection.mode, issue: selection.issue, status,
        counts_for_promotion: status === "clean", universe: selection.universe, must_run: selection.must_run.length, omitted: selection.omitted.length,
        lanes_reported: lanesReported, lanes_expected: lanesExpected, misses,
        outside_plan: fullFailed.filter(path => !planned.has(path)),
        selected_only: (selectedFailed ?? []).filter(path => !fullFailed.includes(path)),
        full_failed: fullFailed, reason_kinds: selection.reason_kinds };
}

const list = (paths) => paths.map(path => `- \`${path}\``).join("\n");

/** The job-summary block: status, counts, and every miss by name. */
export function summaryMarkdown(row) {
    const head = row.status === "miss" ? `### SELECTION_MISS (${row.misses.length})` : `### Selective CI comparison: ${row.status}`;
    const lines = [head, "", `${row.must_run} must-run / ${row.omitted} omitted of ${row.universe} test files; mode ${row.mode}; lanes ${row.lanes_reported}/${row.lanes_expected}; counts for promotion: ${row.counts_for_promotion ? "yes" : "no"}`];
    if (row.issue) lines.push("", `Issue: ${row.issue}`);
    if (row.reason_kinds.length) lines.push("", `Widening reasons: ${row.reason_kinds.join("; ")}`);
    if (row.misses.length) lines.push("", "Failed in the full lanes but omitted by the selection:", list(row.misses));
    if (row.selected_only.length) lines.push("", "Failed only in the selected run:", list(row.selected_only));
    if (row.outside_plan.length) lines.push("", "Failed outside the plan's universe:", list(row.outside_plan));
    return `${lines.join("\n")}\n`;
}

/** Tally of recorded rows against the promotion bar: selective clean runs, and any miss stops the count. */
export function promotionCounts(rows) {
    const count = (status) => rows.filter(row => row.status === status).length;
    return { rows: rows.length, selective_clean: rows.filter(row => row.counts_for_promotion).length, misses: count("miss"), widened: count("widened"), incomplete: count("incomplete") };
}

function argument(argv, name) {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
}

function resolvedBase(root) {
    try {
        const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
        return { base: resolveCiBase(root, process.env.GITHUB_EVENT_NAME, event), issue: null };
    } catch (error) { return { base: null, issue: error instanceof Error ? error.message : String(error) }; }
}

function runPlan(root, base, cli) {
    try {
        return JSON.parse(execFileSync(process.execPath, [cli, "tests", "plan", "--base", base, "--json", "--timeout", "600000"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
    } catch (error) {
        const stdout = typeof error?.stdout === "string" ? error.stdout : "";
        try { return JSON.parse(stdout); } catch { return { error: error instanceof Error ? error.message : String(error) }; }
    }
}

function selectCommand(argv, root) {
    const outDir = argument(argv, "--out-dir") ?? "select";
    mkdirSync(outDir, { recursive: true });
    const { base, issue } = resolvedBase(root);
    const plan = base === null ? null : runPlan(root, base, argument(argv, "--cli") ?? "dist/index.js");
    const selection = planSelection(plan, { head: process.env.GITHUB_SHA ?? null, base, issue });
    writeFileSync(join(outDir, "selection.json"), `${JSON.stringify(selection, null, 2)}\n`);
    writeFileSync(join(outDir, "files.txt"), selection.selective ? `${selection.must_run.join("\n")}\n` : "");
    const run = selection.selective && selection.must_run.length > 0;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
    process.stdout.write(`[select-compare] ${selection.mode}: ${selection.must_run.length} must-run / ${selection.omitted.length} omitted${selection.issue ? ` (${selection.issue})` : ""}; selected run: ${run}\n`);
}

/** The vitest argv for a selected run: one JSON report, the default reporter, and GitHub annotations in Actions. */
export function selectedRunArgs(files, reportPath, inActions) {
    if (files.length === 0) throw new Error("No selected test files: refusing to run vitest without filters (that would run the whole suite)");
    return ["vitest", "run", "--reporter=default", ...(inActions ? ["--reporter=github-actions"] : []), "--reporter=json", `--outputFile.json=${reportPath}`, ...files];
}

/**
 * Runs ONLY the selection's must-run files. An empty list is refused rather than passed through: `vitest run` with no
 * file filters runs everything, which a shell array that failed to fill (`mapfile` is absent from macOS bash 3.2,
 * found by the 2026-10-01 dry run) turned into a silent full run labelled "selected".
 */
function runSelectedCommand(argv, root) {
    const outDir = argument(argv, "--out-dir") ?? "select";
    const files = readFileSync(join(outDir, "files.txt"), "utf8").split("\n").map(line => line.trim()).filter(Boolean);
    if (files.length === 0) {
        process.stderr.write("[select-compare] No selected test files: refusing to run vitest without filters (that would run the whole suite)\n");
        process.exitCode = 2;
        return;
    }
    const result = spawnSync("npx", selectedRunArgs(files, join(outDir, "selected.json"), process.env.GITHUB_ACTIONS === "true"), { cwd: root, stdio: "inherit" });
    process.exitCode = result.status ?? 1;
}

function compareCommand(argv, root) {
    const selectionPath = argument(argv, "--selection");
    // The select job may have died before uploading: that is an unavailable selection, recorded, not a crash.
    const selection = selectionPath && existsSync(selectionPath) ? JSON.parse(readFileSync(selectionPath, "utf8"))
        : planSelection(null, { head: process.env.GITHUB_SHA ?? null, base: null, issue: "Selection artifact missing" });
    const selectedPath = argument(argv, "--selected-report");
    const selectedFailed = selectedPath && existsSync(selectedPath) ? failingFiles(JSON.parse(readFileSync(selectedPath, "utf8")), root) : null;
    const lanesExpected = Number(argument(argv, "--expected-lanes"));
    if (!Number.isSafeInteger(lanesExpected) || lanesExpected < 1) throw new Error("--expected-lanes must be a positive integer");
    const row = compareSelection(selection, { ...readFullReports(argument(argv, "--full-reports"), root), lanesExpected, selectedFailed });
    writeFileSync(argument(argv, "--out") ?? "select-compare-row.json", `${JSON.stringify(row)}\n`);
    const markdown = summaryMarkdown(row);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    process.stdout.write(markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [command, ...argv] = process.argv.slice(2);
    // The workspace the reports' absolute file names are relative to (every job checks out to the same path).
    const root = process.env.SELECT_COMPARE_ROOT ?? process.cwd();
    if (command === "select") selectCommand(argv, root);
    else if (command === "run-selected") runSelectedCommand(argv, root);
    else if (command === "compare") compareCommand(argv, root);
    else { process.stderr.write("Usage: ci-select-compare.mjs select [--out-dir d] [--cli dist/index.js] | run-selected [--out-dir d] | compare --selection f --full-reports d --expected-lanes n [--selected-report f] [--out f]\n"); process.exitCode = 2; }
}
