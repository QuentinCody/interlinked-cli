import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

interface Mutant { id: string; operator: string; start: number; end: number; before: string; after: string; source: string }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function enumerateMutants(source: string): Mutant[] {
    const file = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true);
    const mutants: Mutant[] = [];
    const add = (node: ts.Node, after: string, operator: string) => {
        const start = node.getStart(file); const end = node.getEnd(); const before = source.slice(start, end);
        if (before === after) return;
        mutants.push({ id: hash(`${hash(source)}:${start}:${end}:${after}`).slice(0, 16), operator, start, end, before, after,
            source: source.slice(0, start) + after + source.slice(end) });
    };
    const walk = (node: ts.Node) => {
        if (ts.isNumericLiteral(node)) {
            const value = Number(node.text);
            if (Number.isSafeInteger(value)) {
                add(node, String(value + 1), "numeric_plus_one"); add(node, String(value - 1), "numeric_minus_one"); add(node, "0", "zero_literal");
            }
        }
        if (ts.isReturnStatement(node) && node.expression) add(node.expression, "undefined", "return_undefined");
        ts.forEachChild(node, walk);
    };
    walk(file);
    return [...new Map(mutants.map(m => [m.id, m])).values()];
}

export function rankMutants(pool: Mutant[], arm: "random" | "heuristic", seed: string): Mutant[] {
    const priority: Record<string, number> = { return_undefined: 0, zero_literal: 1, numeric_plus_one: 2, numeric_minus_one: 3 };
    return [...pool].sort((a, b) => arm === "random" ? hash(`${seed}:${a.id}`).localeCompare(hash(`${seed}:${b.id}`))
        : (priority[a.operator] ?? 9) - (priority[b.operator] ?? 9) || a.start - b.start || a.id.localeCompare(b.id));
}

function execute(root: string, source: string, reportName: string, timeoutMs: number) {
    writeFileSync(resolve(root, "src/hook-timeouts.ts"), source);
    const reportPath = resolve(root, reportName); const started = performance.now();
    const command = ["run", "--root", root, "--config", resolve(root, "vitest.config.mts"), "--reporter=json", `--outputFile=${reportPath}`];
    const run = spawnSync(resolve("node_modules/.bin/vitest"), command, { cwd: process.cwd(), encoding: "utf8", timeout: Math.max(1, Math.floor(timeoutMs)) });
    let report: { numTotalTests: number; numPassedTests: number; numFailedTests: number; success: boolean } | null = null;
    try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { /* A killed runner may not write a report. */ }
    return { command, elapsedMs: performance.now() - started, exitCode: run.status, signal: run.signal,
        error: run.error?.message ?? null, stdout: run.stdout, stderr: run.stderr, report };
}

interface ArmSetup {
    output: string; source: string; tests: string; pool: Mutant[]; seed: string; executionBudgetMs: number;
    save: (name: string, value: unknown) => void;
}

function executeArm(arm: "random" | "heuristic", setup: ArmSetup) {
    const { output, source, tests, pool, seed, executionBudgetMs, save } = setup;
    const root = resolve(output, arm); mkdirSync(resolve(root, "src"), { recursive: true });
    writeFileSync(resolve(root, "src/hook-timeouts.test.ts"), tests);
    writeFileSync(resolve(root, "vitest.config.mts"), 'export default { test: { environment: "node", include: ["src/**/*.test.ts"], maxWorkers: 1 } };\n');
    const baseline = execute(root, source, "baseline.json", 30_000); save(`${arm}-baseline.json`, baseline);
    if (!baseline.report?.success || baseline.report.numTotalTests !== 6) throw new Error("Original isolated test suite did not pass its six tests");
    let elapsed = 0; const outcomes = [];
    for (const mutant of rankMutants(pool, arm, seed)) {
        if (elapsed >= executionBudgetMs) break;
        const result = execute(root, mutant.source, `${mutant.id}.json`, executionBudgetMs - elapsed); elapsed += result.elapsedMs;
        const status = result.error || result.signal ? "budget_or_runner_timeout" : result.report?.numFailedTests ? "killed"
            : result.report?.success && result.report.numTotalTests === 6 ? "survived" : "invalid_or_runner_failure";
        outcomes.push({ id: mutant.id, operator: mutant.operator, status, cumulativeMs: elapsed, result });
    }
    const summary = { arm, candidateIds: pool.map(m => m.id), ordering: rankMutants(pool, arm, seed).map(m => m.id),
        executionBudgetMs, elapsedMs: elapsed, outcomes, unexecuted: pool.length - outcomes.length };
    save(`${arm}.json`, summary);
    console.log(JSON.stringify({ arm, candidates: pool.length, executed: outcomes.length, killed: outcomes.filter(o => o.status === "killed").length,
        survived: outcomes.filter(o => o.status === "survived").length, elapsedMs: elapsed }));
    return summary;
}

async function main(): Promise<void> {
    const output = process.argv[2]; if (!output) throw new Error("Usage: mutation-setup.mts NEW_OUTPUT");
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const sourcePath = "src/lib/hook-timeouts.ts"; const testPath = "src/lib/hook-timeouts.test.ts";
    const source = readFileSync(sourcePath, "utf8"); const tests = readFileSync(testPath, "utf8"); const pool = enumerateMutants(source);
    const seed = "claim-protocol-2026-10-19"; const executionBudgetMs = 5_000;
    save("pool.json", { createdAt: new Date().toISOString(), sourcePath, testPath, sourceSha256: hash(source), testSha256: hash(tests),
        source, tests, mutants: pool, seed, executionBudgetMs,
        limitations: ["Setup on one small policy module, not a population ranking experiment.", "Heuristic is a fixed operator priority, not a history-trained Google-style incumbent.", "Uses the exact existing tests in an isolated workspace; no production source is mutated."] });
    const results = [];
    for (const arm of ["random", "heuristic"] as const) {
        results.push(executeArm(arm, { output, source, tests, pool, seed, executionBudgetMs, save }));
    }
    save("summary.json", { createdAt: new Date().toISOString(), pool: pool.length, sourceUnchanged: hash(readFileSync(sourcePath, "utf8")) === hash(source),
        testsUnchanged: hash(readFileSync(testPath, "utf8")) === hash(tests), results, modelCalls: 0 });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
