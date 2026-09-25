// ===========================================
// Project e2e release matrix (plan 31 §16 Unit G, PE-51 / PE-54 / PE-57)
// ===========================================
// Runs every language fixture through the COMMON route with the installed
// toolchain and records, per row: toolchain present, a valid run accepted,
// an injected behavior-breaking fault rejected, a stale input rejected. A
// missing toolchain is an explicit GAP row — never a skipped, silently green
// row. Output: docs/e2e-release-matrix.md (committed snapshot with the host)
// and .interlinked/test-runs/e2e/release-matrix.json. Exit 1 when any row
// CONTRADICTS the contract (a fault or a stale input accepted); gaps exit 0
// but are listed, so CI can require zero gaps separately.
//
//   node --import tsx scripts/e2e-release-matrix.mts [--out docs/e2e-release-matrix.md]

import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { browserFixtureProject, repoHasPlaywright } from "../src/harness/project-e2e/__tests__/fixture-browser.js";
import { httpFixtureProject, injectHttpPersistenceDefect } from "../src/harness/project-e2e/__tests__/fixture-http.js";
import { fixtureProject, injectPersistenceDefect, touchSource, type FixtureProject } from "../src/harness/project-e2e/__tests__/fixture-projects.js";
import { evaluateE2e } from "../src/harness/project-e2e/evaluate.js";
import { runProjectE2e } from "../src/harness/project-e2e/run.js";

type Outcome = "yes" | "no" | "gap";
interface Row { route: string; language: string; toolchain: string; toolchainPresent: Outcome; validAccepted: Outcome; faultRejected: Outcome; staleRejected: Outcome; note: string; }
interface Lane { route: string; language: string; toolchain: string[]; make(): FixtureProject; fault(project: FixtureProject): void; }

const TIMEOUT_MS = 240_000;
const LANES: Lane[] = [
    { route: "TypeScript CLI (managed-contracts, build step)", language: "TypeScript", toolchain: ["node", "--version"], make: () => fixtureProject("ts", { accept: true }), fault: injectPersistenceDefect },
    { route: "Python CLI (managed-contracts, interpreted)", language: "Python", toolchain: ["python3", "--version"], make: () => fixtureProject("py", { accept: true }), fault: injectPersistenceDefect },
    { route: "Rust CLI (managed-contracts, compiled)", language: "Rust", toolchain: ["cargo", "--version"], make: () => fixtureProject("rust", { accept: true }), fault: injectPersistenceDefect },
    { route: "TypeScript HTTP service (owned service, http boundary)", language: "TypeScript", toolchain: ["node", "--version"], make: () => httpFixtureProject({ accept: true }), fault: injectHttpPersistenceDefect },
    { route: "TypeScript browser app (playwright suite, browser boundary)", language: "TypeScript + Chromium", toolchain: ["node", "--version"], make: () => browserFixtureProject({ accept: true, withPlaywright: true }), fault: injectHttpPersistenceDefect },
];

function toolchainPresent(lane: Lane): boolean {
    if (lane.route.includes("playwright") && !repoHasPlaywright()) return false;
    return spawnSync(lane.toolchain[0]!, lane.toolchain.slice(1), { stdio: "ignore" }).status === 0;
}
async function exitOf(project: FixtureProject): Promise<0 | 1 | 2> {
    const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT_MS });
    return result.exitCode;
}
async function runLane(lane: Lane): Promise<Row> {
    const row: Row = { route: lane.route, language: lane.language, toolchain: lane.toolchain.join(" "), toolchainPresent: "gap", validAccepted: "gap", faultRejected: "gap", staleRejected: "gap", note: "" };
    if (!toolchainPresent(lane)) { row.note = `toolchain \`${lane.toolchain[0]}\` (or @playwright/test) is not installed on this host: GAP, not a pass`; return row; }
    row.toolchainPresent = "yes";
    const project = lane.make();
    try {
        const valid = await exitOf(project);
        row.validAccepted = valid === 0 ? "yes" : "no";
        if (valid !== 0) { row.note = `valid run exited ${valid}`; return row; }
        touchSource(project);
        const stale = evaluateE2e({ root: project.root, atMs: Date.now(), reconcile: true });
        row.staleRejected = stale.exitCode === 1 && stale.verdicts.some(verdict => verdict.reasons.some(reason => reason.code === "STALE_GENERATION")) ? "yes" : "no";
        try { lane.fault(project); }
        catch (error) { row.note = `fault not exercised: ${error instanceof Error ? error.message : String(error)}`; return row; }
        const faulted = await exitOf(project);
        row.faultRejected = faulted === 1 ? "yes" : "no";
        if (faulted !== 1) row.note = `faulted run exited ${faulted}`;
    } finally { rmSync(project.root, { recursive: true, force: true }); }
    return row;
}
function markdown(rows: Row[], generatedAt: string): string {
    const cell = (value: Outcome): string => ({ yes: "✅ yes", no: "❌ NO", gap: "⚠️ gap" })[value];
    const lines = [
        "# Project e2e release matrix", "",
        `Generated ${generatedAt} on ${hostname()} (${process.platform} ${process.arch}, node ${process.version}) by \`scripts/e2e-release-matrix.mts\`.`,
        "Every row runs the fixture through the COMMON route (policy + receipt + qualification engine) with the installed toolchain.",
        "A `gap` is an explicit missing prerequisite on this host, never a pass; a `NO` in a rejection column is a contract violation and fails the script.", "",
        "| Route | Language | Toolchain probe | Present | Valid run accepted | Injected fault rejected | Stale input rejected | Note |",
        "|---|---|---|---|---|---|---|---|",
        ...rows.map(row => `| ${row.route} | ${row.language} | \`${row.toolchain}\` | ${cell(row.toolchainPresent)} | ${cell(row.validAccepted)} | ${cell(row.faultRejected)} | ${cell(row.staleRejected)} | ${row.note} |`),
        "",
        "Fixtures: `src/harness/project-e2e/__fixtures__/{ts-cli,py-cli,rust-cli,ts-http,ts-browser}`. Faults: the \"return success without saving\" persistence defect. Stale: a comment appended to the source file.",
        "Not in this matrix: the MCP/Worker profile (plan 31 §10.3) — an explicit release gap until an owned local MCP runtime is driven by a real client call.", "",
    ];
    return lines.join("\n");
}
async function main(): Promise<void> {
    const outIndex = process.argv.indexOf("--out");
    const out = outIndex === -1 ? "docs/e2e-release-matrix.md" : process.argv[outIndex + 1]!;
    const rows: Row[] = [];
    for (const lane of LANES) { process.stderr.write(`matrix: ${lane.route}\n`); rows.push(await runLane(lane)); }
    const generatedAt = new Date().toISOString();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, markdown(rows, generatedAt));
    mkdirSync(".interlinked/test-runs/e2e", { recursive: true });
    writeFileSync(".interlinked/test-runs/e2e/release-matrix.json", `${JSON.stringify({ version: 1, generatedAt, host: hostname(), rows }, null, 2)}\n`);
    const contradictions = rows.filter(row => row.validAccepted === "no" || row.faultRejected === "no" || row.staleRejected === "no");
    const gaps = rows.filter(row => row.toolchainPresent === "gap");
    process.stdout.write(`${rows.length} route(s): ${rows.length - gaps.length - contradictions.length} qualified, ${gaps.length} gap(s), ${contradictions.length} contradiction(s) → ${out}\n`);
    for (const row of gaps) process.stdout.write(`  gap: ${row.route} — ${row.note}\n`);
    for (const row of contradictions) process.stdout.write(`  CONTRADICTION: ${row.route} — valid ${row.validAccepted}, fault ${row.faultRejected}, stale ${row.staleRejected} ${row.note}\n`);
    process.exitCode = contradictions.length ? 1 : 0;
}
await main();
