import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export interface PoolMutant { id: string; operator: string; start: number; end: number; before: string; after: string; source: string }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function enumeratePool(source: string): PoolMutant[] {
    const file = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true); const mutants: PoolMutant[] = [];
    const add = (node: ts.Node, after: string, operator: string) => {
        const start = node.getStart(file), end = node.getEnd(), before = source.slice(start, end);
        if (before !== after) mutants.push({ id: hash(`${hash(source)}:${start}:${end}:${after}`).slice(0, 20), operator, start, end, before, after,
            source: source.slice(0, start) + after + source.slice(end) });
    };
    const walk = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) return;
        if (ts.isNumericLiteral(node) && Number.isSafeInteger(Number(node.text))) {
            const n = Number(node.text); add(node, String(n + 1), "numeric_plus_one"); add(node, String(n - 1), "numeric_minus_one"); add(node, "0", "zero_literal");
        }
        if (ts.isStringLiteral(node) && !ts.isPropertyAssignment(node.parent) && !ts.isElementAccessExpression(node.parent)) add(node, '""', "empty_string");
        if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) add(node, node.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true", "boolean_flip");
        if (ts.isReturnStatement(node) && node.expression) add(node.expression, "undefined", "return_undefined");
        if (ts.isBinaryExpression(node)) {
            const replacements: Record<string, string> = { "<=": "<", "<": "<=", ">=": ">", ">": ">=", "===": "!==", "!==": "===", "&&": "||", "||": "&&" };
            const next = replacements[node.operatorToken.getText(file)]; if (next) add(node.operatorToken, next, "binary_operator");
        }
        ts.forEachChild(node, walk);
    };
    walk(file); return [...new Map(mutants.map(m => [m.id, m])).values()];
}

export function copyClosure(path: string, root: string, seen = new Set<string>()): void {
    const absolute = resolve(path); if (seen.has(absolute)) return; seen.add(absolute);
    const rel = relative(process.cwd(), absolute); if (rel.startsWith("..")) throw new Error("Dependency escaped repository");
    const text = readFileSync(absolute, "utf8"); const destination = resolve(root, rel);
    mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, text);
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    for (const statement of file.statements) {
        if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue;
        if (ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly : statement.isTypeOnly) continue;
        if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const spec = statement.moduleSpecifier.text; if (!spec.startsWith(".")) continue;
        const base = resolve(dirname(absolute), spec); const target = [base.replace(/\.js$/, ".ts"), base, base + ".ts"].find(existsSync);
        if (!target) throw new Error(`Missing dependency ${spec}`); copyClosure(target, root, seen);
    }
}

export function runBoundedProcess(command: string, args: string[], timeoutMs: number): Promise<{
    exitCode: number | null; signal: string | null; error: string | null; timedOut: boolean; stdout: string; stderr: string;
}> {
    return new Promise(resolveResult => {
        const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "", error: string | null = null, timedOut = false;
        child.stdout.on("data", data => { stdout = (stdout + data).slice(-4_000_000); });
        child.stderr.on("data", data => { stderr = (stderr + data).slice(-4_000_000); });
        child.on("error", value => { error = value.message; });
        const timer = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
                try { process.kill(-child.pid, "SIGKILL"); }
                catch (value) { error = String(value); }
            }
        }, Math.max(1, Math.floor(timeoutMs)));
        child.on("close", (exitCode, signal) => {
            clearTimeout(timer);
            resolveResult({ exitCode, signal, error, timedOut, stdout, stderr });
        });
    });
}

export async function executePoolTest(root: string, sourcePath: string, testPath: string, source: string, name: string, timeoutMs: number) {
    writeFileSync(resolve(root, sourcePath), source);
    const reportPath = resolve(root, `${name}.json`); const started = performance.now();
    const command = ["run", testPath, "--root", root, "--config", resolve(root, "vitest.config.mts"), "--reporter=json", `--outputFile=${reportPath}`];
    const run = await runBoundedProcess(resolve("node_modules/.bin/vitest"), command, timeoutMs);
    let report: { success: boolean; numTotalTests: number; numFailedTests: number } | null = null;
    try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { report = null; }
    return { command, elapsedMs: performance.now() - started, report, ...run };
}

function prepareModule(sourcePath: string, output: string) {
        const name = sourcePath.split("/").at(-1)!.replace(/\.ts$/, ""); const dir = resolve(output, name); mkdirSync(dir);
        const testPath = sourcePath.replace(/\.ts$/, ".test.ts"); const source = readFileSync(sourcePath, "utf8"); const tests = readFileSync(testPath, "utf8");
        const root = resolve(dir, "workspace"); copyClosure(sourcePath, root); copyClosure(testPath, root);
        writeFileSync(resolve(root, "vitest.config.mts"), 'export default {test:{environment:"node",maxWorkers:1}};\n');
        const pool = enumeratePool(source);
        const save = (file: string, data: unknown) => writeFileSync(resolve(dir, file), JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
        save("pool.json", { createdAt: new Date().toISOString(), sourcePath, testPath, sourceSha256: hash(source), testSha256: hash(tests), source, tests, pool });
        return { name, root, sourcePath, testPath, source, tests, pool, save };
}

async function screenModule(module: ReturnType<typeof prepareModule>) {
        const { name, root, sourcePath, testPath, source, tests, pool, save } = module;
        const baseline = await executePoolTest(root, sourcePath, testPath, source, "baseline", 60_000); save("baseline.json", baseline);
        if (!baseline.report?.success || !baseline.report.numTotalTests) throw new Error(`Original tests failed for ${name}`);
        const results = [];
        for (const [index, mutant] of pool.entries()) {
            const run = await executePoolTest(root, sourcePath, testPath, mutant.source, mutant.id, 5_000);
            const status = run.timedOut ? "timeout" : run.error || run.signal ? "invalid_or_runner_failure" : run.report?.numFailedTests ? "killed" : run.report?.success && run.report.numTotalTests === baseline.report.numTotalTests ? "survived" : "invalid_or_runner_failure";
            save(`${mutant.id}.json`, { id: mutant.id, status, ...run }); results.push({ id: mutant.id, operator: mutant.operator, status, elapsedMs: run.elapsedMs });
            if (index % 25 === 0) console.log(JSON.stringify({ name, completed: index + 1, pool: pool.length }));
        }
        save("summary.json", { createdAt: new Date().toISOString(), sourcePath, pool: pool.length, results,
            sourceUnchanged: hash(readFileSync(sourcePath, "utf8")) === hash(source), testsUnchanged: hash(readFileSync(testPath, "utf8")) === hash(tests) });
        console.log(JSON.stringify({ name, pool: pool.length, survived: results.filter(r => r.status === "survived").length, killed: results.filter(r => r.status === "killed").length }));
}

async function main(): Promise<void> {
    const [output, ...modules] = process.argv.slice(2);
    if (!output || !modules.length) throw new Error("Usage: mutation-pool.mts NEW_OUTPUT MODULE...");
    mkdirSync(output, { recursive: true, mode: 0o700 });
    for (const sourcePath of modules) await screenModule(prepareModule(sourcePath, output));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
