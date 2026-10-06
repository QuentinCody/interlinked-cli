// Opt-in terminal qualification; never a hook or merge gate.
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { runProcessAsync, type RunProcessResult } from "../src/harness/check-engine/spawn-async.js";

const BOMBAdIL_SHA256 = "6dc6db82fa550a7311c2eacea6a4d654c4e9b5c33656e359c2d00dceec3d6c07";
const MAX_BYTES = 100 * 1024 * 1024;
const digest = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
interface TraceSummary { states: number; actions: number; violations: string[]; violation_outcomes: string[]; exited: boolean; invalid: number; }
export function summarizeTrace(text: string): TraceSummary {
    const summary: TraceSummary = { states: 0, actions: 0, violations: [], violation_outcomes: [], exited: false, invalid: 0 };
    for (const line of text.split("\n").filter(Boolean)) {
        try {
            const row = JSON.parse(line);
            if (!Array.isArray(row.violations) || !row.state) { summary.invalid++; continue; }
            summary.states++;
            summary.actions += Number(row.action !== null && row.action !== undefined);
            summary.exited ||= row.state.exit_status !== null && row.state.exit_status !== undefined;
            for (const violation of row.violations) {
                summary.violations.push(String(violation.name));
                // Outcome identity excludes timing, but includes the designated property and its observed violation kind.
                summary.violation_outcomes.push(digest(JSON.stringify(violation, (key, value) => key === "time" || key === "start" ? undefined : value)));
            }
        } catch { summary.invalid++; }
    }
    summary.violations = [...new Set(summary.violations)].sort();
    summary.violation_outcomes = [...new Set(summary.violation_outcomes)].sort();
    return summary;
}
function files(root: string): string[] {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
        const path = join(root, entry.name);
        return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
    });
}
export function runtimeImports(content: string): string[] {
    const imports: string[] = [];
    const source = ts.createSourceFile("runtime.js", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node: ts.Node): void {
        const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
            : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
        if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".") && specifier.text.endsWith(".js")) imports.push(specifier.text);
        ts.forEachChild(node, visit);
    }
    visit(source);
    return imports;
}
function copyRuntime(root: string, target: string): void {
    const queue = ["index.js"], seen = new Set<string>();
    for (const name of queue) {
        if (seen.has(name)) continue;
        seen.add(name);
        const source = join(root, name), destination = join(target, name);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(source, destination);
        for (const specifier of runtimeImports(readFileSync(source, "utf8"))) queue.push(join(dirname(name), specifier));
    }
}
function processCompleted(result: RunProcessResult): boolean {
    const completed = result.code === 0 || result.code === 1 && result.stderr.includes("terminal test failed:");
    return completed && !result.killed && !result.stdoutTruncated && !result.stderrTruncated;
}
async function attempt(input: { binary: string; sut: string; spec: string; out: string; name: string; replay?: string }) {
    const directory = join(input.out, input.name);
    const cwd = join(directory, "project"), home = join(directory, "home");
    mkdirSync(cwd, { recursive: true }); mkdirSync(home, { recursive: true });
    writeFileSync(join(cwd, "package.json"), '{"name":"wizard-pilot","private":true}');
    const abort = new AbortController();
    const watcher = setInterval(() => {
        try { if (files(input.out).reduce((size, path) => size + statSync(path).size, 0) > MAX_BYTES) abort.abort(); }
        catch { abort.abort(); }
    }, 100);
    const env = { HOME: home, PATH: dirname(process.execPath) + ":/usr/bin:/bin", TERM: "xterm-256color", LANG: "C.UTF-8" };
    const args = ["terminal", "test", "--specification", input.spec, "--time-limit", "15s", "--columns", "100",
        "--rows", "24", "--scrollback-lines-max", "5", "--quiescence-timeout-ms", "100", "--output-path", join(directory, "output")];
    if (input.replay) args.push("--reproduce", input.replay);
    args.push("--", process.execPath, input.sut);
    const started = performance.now();
    try {
        const result = await runProcessAsync(input.binary, args, { cwd, exactEnv: env, timeout: 20000, signal: abort.signal });
        const trace = files(directory).find(path => path.endsWith("/trace.jsonl")) ?? null;
        const evidence = trace ? summarizeTrace(readFileSync(trace, "utf8")) : null;
        const row = { name: input.name, elapsed_ms: performance.now() - started, process: result, trace,
            trace_sha256: trace ? digest(readFileSync(trace)) : null, evidence,
            valid: processCompleted(result)
                && evidence !== null && evidence.invalid === 0 && evidence.states > 0,
            environment: env, geometry: { columns: 100, rows: 24, scrollback: 5 }, command: args };
        writeFileSync(join(directory, "run.json"), JSON.stringify(row, null, 2));
        return row;
    } finally { clearInterval(watcher); }
}
/** Fault reintroduces the historical wrapped-row redraw defect in an isolated build copy. */
export async function terminalPilot(binary: string, root: string, outputRoot: string): Promise<unknown> {
    if (digest(readFileSync(binary)) !== BOMBAdIL_SHA256) throw new Error("Bombadil binary does not match pinned v0.7.8 arm64 Darwin asset");
    const out = join(outputRoot, randomUUID()); mkdirSync(out, { recursive: true });
    const spec = join(root, "scripts/fixtures/wizard-evidence.spec.ts");
    const sut = join(out, "sut");
    copyRuntime(join(root, "dist"), sut);
    cpSync(join(root, "package.json"), join(out, "package.json"));
    const entry = join(sut, "index.js");
    const original = readFileSync(entry, "utf8");
    const before = "paintedLines = lines + renderedLineCount(hint, columns);";
    if (!original.includes(before)) throw new Error("historical defect anchor missing; pilot refused");
    const binding = files(sut).map(path => [path.slice(sut.length), digest(readFileSync(path))]);
    const healthy = await attempt({ binary, sut: entry, spec, out, name: "healthy" });
    writeFileSync(entry, original.replace(before, "paintedLines = labels.length + 1;"));
    const faulty = await attempt({ binary, sut: entry, spec, out, name: "planted-fault" });
    const replay = faulty.trace ? await attempt({ binary, sut: entry, spec, out, name: "replay", replay: faulty.trace }) : null;
    const reproduced = !!faulty.evidence?.violations.includes("oneSelectionMarker")
        && JSON.stringify(faulty.evidence.violation_outcomes) === JSON.stringify(replay?.evidence?.violation_outcomes);
    const report = { schema: "terminal-pilot.v1", owner: "QuentinCody (repository maintainer)", required: false,
        binary_sha256: BOMBAdIL_SHA256, spec_sha256: digest(readFileSync(spec)), build_manifest: binding,
        fault: { anchor: before, replacement: "paintedLines = labels.length + 1;", sha256: digest(readFileSync(entry)) },
        caps: { runs: 3, run_seconds: 15, supervisor_seconds: 20, storage_abort_threshold_bytes: MAX_BYTES, sample_ms: 100 },
        healthy, faulty, replay, reproduced,
        qualified: healthy.valid && healthy.evidence?.violations.length === 0 && faulty.valid && replay?.valid === true && reproduced,
        unique_new_confirmed_defects: 0, planted_defects: 1, triage: "owner reviews artifacts; no automatic bug-yield claim",
        browser: "not qualified; not scheduled", output: out };
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
    return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [binary, root = process.cwd(), out = ".interlinked/agent-output/terminal-pilot"] = process.argv.slice(2);
    if (!binary) throw new Error("usage: tsx scripts/antithesis-terminal-pilot.mts <pinned-binary> [repo] [artifact-root]");
    const report = await terminalPilot(resolve(binary), resolve(root), resolve(out));
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
