import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { gateProposedContent } from "../src/harness/content-gate.js";
import { configFingerprintOf } from "../src/harness/config-graph.js";
import { clearOverlayServiceCache } from "../src/harness/check-engine/tool-runners/tsc-overlay-service.js";
import { runOverlayViaSidecarTyped } from "../src/harness/check-engine/tool-runners/tsc-overlay-sidecar-client.js";

// Each fixture selects the supported in-process checker through its own config.
// No guard is disabled. Every write is inside this unique scratch fixture tree.
const root = mkdtempSync(join(import.meta.dirname, "../scratch/shadow-review-r8-"));
const options = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, skipLibCheck: true };
function put(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}
function json(value: unknown): string { return `${JSON.stringify(value, null, "\t")}\n`; }
function report(name: string, result: unknown): void { console.log(name, JSON.stringify(result)); }
function errors(projectRoot: string) {
    const configPath = join(projectRoot, "tsconfig.json");
    const raw = ts.readConfigFile(configPath, ts.sys.readFile);
    assert.equal(raw.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, projectRoot, undefined, configPath);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    return [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map(error => ({
        code: error.code, file: error.file?.fileName,
        message: ts.flattenDiagnosticMessageText(error.messageText, "\n"),
    }));
}
function gate(projectRoot: string, filePath: string, content: string) {
    return gateProposedContent([{ path: filePath, content }], { projectRoot, tscUnavailableSeverity: "error" });
}

function preservedConfigMetadata(): void {
    const projectRoot = join(root, "preserved-config-metadata");
    put(join(projectRoot, ".interlinked", "guard-rules.local.json"), json({ tsc_overlay: { mode: "in-process" } }));
    const configPath = join(projectRoot, "tsconfig.json");
    const basePath = join(projectRoot, "base.json");
    const filePath = join(projectRoot, "widget.ts");
    const oldConfig = json({ compilerOptions: { ...options, strictNullChecks: false } });
    const strictConfig = json({ compilerOptions: { ...options, strictNullChecks: true } });
    const newConfig = strictConfig.padEnd(oldConfig.length, " ");
    assert.notEqual(oldConfig, newConfig);
    assert.equal(Buffer.byteLength(oldConfig), Buffer.byteLength(newConfig));
    put(basePath, oldConfig);
    const fixedTime = new Date("2025-01-01T00:00:00.000Z");
    utimesSync(basePath, fixedTime, fixedTime);
    put(configPath, json({ extends: "./base.json", include: ["*.ts"] }));
    put(filePath, "export const before = 1;\n");
    const beforeStat = statSync(basePath);
    const beforeFingerprint = configFingerprintOf(ts, configPath);
    const warm = gate(projectRoot, filePath, "export const before = 2;\n");
    assert.equal(warm.ok, true);
    put(basePath, newConfig);
    utimesSync(basePath, beforeStat.atime, beforeStat.mtime);
    const afterStat = statSync(basePath);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStat.size, beforeStat.size);
    assert.equal(readFileSync(basePath, "utf8"), newConfig);
    const afterFingerprint = configFingerprintOf(ts, configPath);
    assert.deepEqual(errors(projectRoot), []);
    const content = "export const value: string = null;\n";
    const warmGate = gate(projectRoot, filePath, content);
    const freshSidecar = runOverlayViaSidecarTyped({ projectRoot, filePath, content });
    clearOverlayServiceCache(projectRoot);
    const clearedGate = gate(projectRoot, filePath, content);
    assert.equal(clearedGate.ok, false);
    put(filePath, content);
    const materialized = errors(projectRoot);
    assert(materialized.some(error => error.code === 2322));
    report("preserved_config_metadata", {
        metadata: { sizeBefore: beforeStat.size, sizeAfter: afterStat.size, mtimeBefore: beforeStat.mtimeMs, mtimeAfter: afterStat.mtimeMs },
        sameFingerprint: beforeFingerprint === afterFingerprint, warm, warmGate, freshSidecar, clearedGate, materialized,
    });
}

function changedProgramRoots(change: "add" | "remove"): void {
    const projectRoot = join(root, `${change}-program-root`);
    put(join(projectRoot, ".interlinked", "guard-rules.local.json"), json({ tsc_overlay: { mode: "in-process" } }));
    const configPath = join(projectRoot, "tsconfig.json");
    const filePath = join(projectRoot, "widget.ts");
    const ambientPath = join(projectRoot, "env.d.ts");
    const ambientContent = "interface ImportMeta { readonly env: { readonly MODE: string }; }\n";
    put(configPath, json({ compilerOptions: { ...options, strict: true }, include: ["*.ts"] }));
    put(filePath, "export const before = 1;\n");
    if (change === "remove") put(ambientPath, ambientContent);
    const beforeFingerprint = configFingerprintOf(ts, configPath);
    const warm = gate(projectRoot, filePath, "export const before = 2;\n");
    assert.equal(warm.ok, true);
    if (change === "add") put(ambientPath, ambientContent);
    else rmSync(ambientPath);
    const sameFingerprint = beforeFingerprint === configFingerprintOf(ts, configPath);
    assert.deepEqual(errors(projectRoot), []);
    const content = "export const mode = import.meta.env.MODE;\n";
    const warmGate = gate(projectRoot, filePath, content);
    const freshSidecar = runOverlayViaSidecarTyped({ projectRoot, filePath, content });
    clearOverlayServiceCache(projectRoot);
    const clearedGate = gate(projectRoot, filePath, content);
    assert.equal(clearedGate.ok, change === "add");
    put(filePath, content);
    const materialized = errors(projectRoot);
    if (change === "add") assert.deepEqual(materialized, []);
    else assert(materialized.some(error => error.code === 2339));
    report(`${change}_program_root`, { sameFingerprint, warm, warmGate, freshSidecar, clearedGate, materialized });
}

try {
    preservedConfigMetadata();
    changedProgramRoots("add");
    changedProgramRoots("remove");
} finally {
    clearOverlayServiceCache();
    rmSync(root, { recursive: true, force: true });
}
