// ===========================================
// Requirement faults — apply each recorded fault to a disposable copy and run the tests that must notice it
// ===========================================
// One git-visible copy for the whole run (`fail-before-fix/snapshot.ts`); each fault rewrites one file there
// (its anchor must occur exactly once, the plan 31 rule), its test files run with vitest's JSON reporter, and the
// original bytes come back before the next fault. A kill is a test that passes on the live tree and fails BY ITS
// OWN CHECK under the fault (an assertion, or a plain error thrown from the test file: `failedByOwnCheck`); a crash,
// an error from product code or a file that no longer loads is inconclusive, never a kill (E66: partial code
// crashes for reasons unrelated to the requirement), and the report keeps each such test's first failure line.
// The live tree is only read.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { failedByOwnCheck, type VitestCase } from "../fail-before-fix/classify.js";
import { runVitest } from "../fail-before-fix/index.js";
import { copyWriteTarget, createProjectCopy, gitVisibleFiles } from "../fail-before-fix/snapshot.js";
import { summarizeKills, type FaultOutcome, type RequirementFault, type RequirementKills } from "./corpus.js";

export interface FaultRunOptions { root: string; faults: readonly RequirementFault[]; budgetMs: number; }
export interface FaultRunReport { faults: FaultOutcome[]; requirements: RequirementKills[]; copyDir?: string; }

const key = (row: Pick<VitestCase, "file" | "name">) => `${row.file} › ${row.name}`;

function judge(fault: RequirementFault, passing: ReadonlySet<string>, under: readonly VitestCase[]): FaultOutcome {
    const seen = new Map(under.map(row => [key(row), row]));
    const killedBy: string[] = [], inconclusive: string[] = [], reasons: Record<string, string> = {};
    for (const test of passing) {
        if (!fault.tests.some(file => test.startsWith(`${file} › `))) continue;
        const row = seen.get(test);
        if (row?.status === "passed") continue;
        if (row !== undefined && failedByOwnCheck(row)) { killedBy.push(test); continue; }
        inconclusive.push(test);
        reasons[test] = row?.message ?? (row ? row.status : "no result");
    }
    const status = killedBy.length ? "killed" : inconclusive.length ? "inconclusive" : "survived";
    const outcome: FaultOutcome = { fault: fault.id, requirement: fault.requirement.id, status, killedBy, inconclusive };
    if (inconclusive.length) outcome.inconclusiveReasons = reasons;
    return outcome;
}

async function underFault(dir: string, fault: RequirementFault, budgetMs: number): Promise<VitestCase[] | string> {
    let target: string;
    try { target = copyWriteTarget(dir, fault.path); }
    catch (error) { return error instanceof Error ? error.message : "fault target is not confined to the copy"; }
    if (!existsSync(target)) return `${fault.path} does not exist`;
    const original = readFileSync(target, "utf8"), occurrences = original.split(fault.find).length - 1;
    if (occurrences !== 1) return `anchor occurs ${occurrences} times in ${fault.path} (exactly one is required)`;
    writeFileSync(target, original.replace(fault.find, () => fault.replace));
    try { return await runVitest(dir, fault.tests, budgetMs); } finally { writeFileSync(target, original); }
}

export async function runFaults(options: FaultRunOptions): Promise<FaultRunReport> {
    if (!options.faults.length) return { faults: [], requirements: [] };
    const files = [...new Set(options.faults.flatMap(row => row.tests))];
    const passing = new Set((await runVitest(options.root, files, options.budgetMs)).filter(row => row.status === "passed").map(key));
    const copy = createProjectCopy(options.root, gitVisibleFiles(options.root) ?? [], new Map());
    const outcomes: FaultOutcome[] = [];
    try {
        for (const fault of options.faults) {
            const missing = fault.tests.filter(file => ![...passing].some(test => test.startsWith(`${file} › `)));
            if (missing.length) {
                outcomes.push({ fault: fault.id, requirement: fault.requirement.id, status: "inconclusive", killedBy: [], inconclusive: missing,
                    inconclusiveReasons: Object.fromEntries(missing.map(file => [file, "no passing baseline test reported"])) });
                continue;
            }
            const under = await underFault(copy.dir, fault, options.budgetMs);
            outcomes.push(typeof under === "string"
                ? { fault: fault.id, requirement: fault.requirement.id, status: "invalid", killedBy: [], inconclusive: [], reason: under }
                : judge(fault, passing, under));
        }
    } finally { copy.cleanup(); }
    return { faults: outcomes, requirements: summarizeKills(outcomes), copyDir: copy.dir };
}
