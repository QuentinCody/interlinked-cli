import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { gateProposedContent } from "../src/harness/content-gate.js";
import { clearOverlayServiceCache } from "../src/harness/check-engine/tool-runners/tsc-overlay-service.js";
import { runOverlayViaSidecarTyped } from "../src/harness/check-engine/tool-runners/tsc-overlay-sidecar-client.js";

// Reviewer fixtures and the deliberately mutated COPY of the service stay under
// this unique scratch tree. The cloned Vitest cases retain their original temp
// fixture helpers and cleanup. The real service is only read/imported.
// No guard bypass or test-only mode selector is used.
const root = mkdtempSync(join(import.meta.dirname, "../scratch/shadow-review-r10-"));
const options = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true, skipLibCheck: true };
const numberExport = "export const value: number = 1;\n";
const stringExport = 'export const value: string = "new";\n';
const ASSIGNMENT_ERROR = 2322;
function put(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}
function json(value: unknown): string { return `${JSON.stringify(value)}\n`; }
function project(name: string): string {
    const dir = join(root, name);
    put(join(dir, "tsconfig.json"), json({ compilerOptions: options, include: ["*.ts"] }));
    put(join(dir, ".interlinked", "guard-rules.local.json"), json({ tsc_overlay: { mode: "in-process" } }));
    return dir;
}
function gate(projectRoot: string, filePath: string, content: string) {
    return gateProposedContent([{ path: filePath, content }], { projectRoot, tscUnavailableSeverity: "error" });
}
function errors(projectRoot: string) {
    const configPath = join(projectRoot, "tsconfig.json");
    const raw = ts.readConfigFile(configPath, ts.sys.readFile);
    assert.equal(raw.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, projectRoot, undefined, configPath);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    return [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map(error => ({
        code: error.code, message: ts.flattenDiagnosticMessageText(error.messageText, "\n"),
    }));
}
function stamp(path: string) {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, ino: stat.ino };
}

// MAP_SHARED writes are visible through ordinary file reads while the mapping
// remains open. The protocol serializes writes and checks; they never overlap.
const mappedWriter = `
import json, mmap, sys
with open(sys.argv[1], "r+b") as f:
    with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_WRITE) as mapping:
        print(json.dumps({"ready": True}), flush=True)
        for line in sys.stdin:
            req = json.loads(line)
            if req["command"] == "close":
                break
            if req["command"] == "write":
                data = req["content"].encode("utf-8")
                assert len(data) == len(mapping)
                mapping[:] = data
            elif req["command"] == "flush":
                mapping.flush()
            print(json.dumps({"ok": True}), flush=True)
`;

async function mappedDependency(direction: "number-to-string" | "string-to-number"): Promise<void> {
    const projectRoot = project(`mapped-dependency-${direction}`);
    const dependencyPath = join(projectRoot, "dependency.ts");
    const filePath = join(projectRoot, "consumer.ts");
    const original = (direction === "number-to-string" ? numberExport : stringExport).padEnd(stringExport.length, " ");
    const changed = (direction === "number-to-string" ? stringExport : numberExport).padEnd(stringExport.length, " ");
    put(dependencyPath, original);
    const importer = 'import { value } from "./dependency.js";\n';
    put(filePath, `${importer}export const before = value;\n`);
    const child = spawn("python3", ["-u", "-c", mappedWriter, dependencyPath], { stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: child.stdout });
    const replies = lines[Symbol.asyncIterator]();
    async function request(command: string, content?: string): Promise<void> {
        child.stdin.write(json({ command, content }));
        const reply = await replies.next();
        assert.equal(reply.done, false);
        assert.deepEqual(JSON.parse(reply.value), { ok: true });
    }
    try {
        const ready = await replies.next();
        assert.equal(ready.done, false);
        assert.deepEqual(JSON.parse(ready.value), { ready: true });
        await request("write", original);
        assert.equal(gate(projectRoot, filePath, `${importer}export const warm = value;\n`).ok, true);
        const before = stamp(dependencyPath);
        await request("write", changed);
        assert.equal(readFileSync(dependencyPath, "utf8"), changed);
        const after = stamp(dependencyPath);
        const content = `${importer}export const count: number = value;\n`;
        const warmGate = gate(projectRoot, filePath, content);
        const controls = await mappedControls({ projectRoot, filePath, dependencyPath, content, expectedValid: direction === "string-to-number", flush: () => request("flush") });
        console.log(`mapped_dependency_${direction}`, json({ platform: process.platform, before, after, warmGate, ...controls }).trim());
    } finally {
        await closeMappedWriter(child);
        lines.close();
    }
}

async function closeMappedWriter(child: ReturnType<typeof spawn>): Promise<void> {
    if (child.exitCode !== null) {
        assert.equal(child.exitCode, 0);
        return;
    }
    const exited = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => code === 0 ? resolve() : reject(new Error(`mapped writer exited ${code}`)));
    });
    child.stdin?.end(json({ command: "close" }));
    await exited;
}

async function mappedControls(input: { projectRoot: string; filePath: string; dependencyPath: string; content: string; expectedValid: boolean; flush: () => Promise<void> }) {
    const { projectRoot, filePath, dependencyPath, content, expectedValid, flush } = input;
    const freshSidecar = runOverlayViaSidecarTyped({ projectRoot, filePath, content });
    await flush();
    const flushedStamp = stamp(dependencyPath);
    const flushedGate = gate(projectRoot, filePath, content);
    clearOverlayServiceCache(projectRoot);
    const clearedGate = gate(projectRoot, filePath, content);
    assert.equal(clearedGate.ok, expectedValid);
    put(filePath, content);
    const materialized = errors(projectRoot);
    if (expectedValid) assert.deepEqual(materialized, []);
    else assert(materialized.some(error => error.code === ASSIGNMENT_ERROR));
    return { freshSidecar, flushedStamp, flushedGate, clearedGate, materialized };
}

async function cleanupRegressionSensitivity(): Promise<void> {
    const servicePath = join(import.meta.dirname, "../src/harness/check-engine/tool-runners/tsc-overlay-service.ts");
    const graphPath = pathToFileURL(join(import.meta.dirname, "../src/harness/config-graph.ts")).href;
    const typesPath = pathToFileURL(join(import.meta.dirname, "../src/harness/check-engine/types.ts")).href;
    const identityPath = pathToFileURL(join(import.meta.dirname, "../src/harness/check-engine/tool-runners/tsc-overlay-identity.ts")).href;
    const source = readFileSync(servicePath, "utf8");
    const fixedLine = 'ctx.versions.set(absFilePath, (ctx.overlay as NonNullable<ServiceContext["overlay"]>).version + 1);';
    assert.equal(source.split(fixedLine).length, 2);
    const mutant = source.replace(fixedLine, fixedLine.replace(".version + 1", ".version"))
        .replace('"../../config-graph.js"', JSON.stringify(graphPath))
        .replace('"../types.js"', JSON.stringify(typesPath))
        .replace('"./tsc-overlay-identity.js"', JSON.stringify(identityPath));
    const mutantPath = join(root, "service-cleanup-mutant.mts");
    put(mutantPath, mutant);
    // This dynamically imports only the generated reviewer-owned mutant copy.
    const mod = await import(pathToFileURL(mutantPath).href);
    const consumer = 'import { value } from "./value.js";\nexport const count: number = value;\n';
    const outcomes = [];
    for (const direction of ["P15", "P16"]) {
        const dir = project(`mutant-${direction}`);
        const exporterPath = join(dir, "value.ts");
        const consumerPath = join(dir, "consumer.ts");
        const numericDisk = direction === "P15";
        put(exporterPath, numericDisk ? "export const value = 1;\n" : 'export const value = "changed";\n');
        put(consumerPath, consumer);
        // Exact operation/assertion sequence of the new P15/P16 tests: no
        // preceding consumer warmup; the exporter proposal is valid and unwritten.
        const first = mod.runOverlayCheckInProcessTyped({ projectRoot: dir, filePath: exporterPath, content: numericDisk ? 'export const value = "changed";\n' : "export const value = 1;\n" });
        assert.deepEqual(first, { status: "ok", findings: [] });
        const second = mod.runOverlayCheckInProcessTyped({ projectRoot: dir, filePath: consumerPath, content: consumer });
        const passesCurrentAssertion = second.status === "ok" && (numericDisk ? second.findings.length === 0 : second.findings.some((finding: { ruleId: string }) => finding.ruleId === "TS2322"));
        outcomes.push({ test: direction, first, second, passesCurrentAssertion });
    }
    mod.clearOverlayServiceCache();
    console.log("cleanup_mutant", json({ mutation: "remove the primary-overlay cleanup version increment", outcomes, actualTests: runActualCleanupTests() }).trim());
}

function runActualCleanupTests() {
    const sourceTest = join(import.meta.dirname, "../src/harness/check-engine/tool-runners/tsc-overlay-service.test.ts");
    const copy = readFileSync(sourceTest, "utf8").replace('"./tsc-overlay-service.js"', '"./service-cleanup-mutant.mts"');
    const testPath = join(root, "service-cleanup-mutant.test.ts");
    const configPath = join(root, "vitest-review.config.mts");
    put(testPath, copy);
    put(configPath, `export default ${JSON.stringify({ test: { include: [testPath], environment: "node", maxWorkers: 1, testTimeout: 20_000 } })};\n`);
    const nodeRequire = createRequire(import.meta.url);
    const vitestCli = join(dirname(nodeRequire.resolve("vitest/package.json")), "vitest.mjs");
    const result = spawnSync(process.execPath, [vitestCli, "run", "--config", configPath, "-t", "P15:|P16:"], { encoding: "utf8", timeout: 45_000 });
    return { exitCode: result.status, output: result.stdout.trim(), stderr: result.stderr.trim() };
}

try {
    await mappedDependency("number-to-string");
    await mappedDependency("string-to-number");
    await cleanupRegressionSensitivity();
} finally {
    clearOverlayServiceCache();
    rmSync(root, { recursive: true, force: true });
}
