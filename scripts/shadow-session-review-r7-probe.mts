import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import ts from "typescript";
import { gateProposedContent } from "../src/harness/content-gate.js";
import { clearOverlayServiceCache, runOverlayCheckInProcessTyped } from "../src/harness/check-engine/tool-runners/tsc-overlay-service.js";
import { _setTscOverlayModeOverrideForTest } from "../src/harness/check-engine/tool-runners/tsc-overlay.js";
import { runOverlayViaSidecarTyped } from "../src/harness/check-engine/tool-runners/tsc-overlay-sidecar-client.js";

// Only reviewer-owned scratch fixtures. The mode override is process-local and
// selects the supported in-process checker; it does not disable a check.
const root = mkdtempSync(join(import.meta.dirname, "../scratch/shadow-review-r7-"));
const ASSIGNMENT_ERROR = 2322;
const options = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, skipLibCheck: true };
function put(path: string, value: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
}
function json(value: unknown): string { return `${JSON.stringify(value, null, "\t")}\n`; }
function report(name: string, value: unknown): void { console.log(name, JSON.stringify(value)); }
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

function firstSource(): void {
    const projectRoot = join(root, "first-source");
    put(join(projectRoot, "tsconfig.json"), json({ compilerOptions: options, include: ["*.ts"] }));
    const filePath = join(projectRoot, "widget.ts");
    const content = 'export const count: number = "wrong";\n';
    const input = { projectRoot, filePath, content };
    const coldSidecar = runOverlayViaSidecarTyped(input);
    const coldGate = gateProposedContent([{ path: filePath, content }], { projectRoot, tscUnavailableSeverity: "error" });
    // An unrelated existing source is the only difference in the control.
    put(join(projectRoot, "seed.ts"), "export const seed = 1;\n");
    const seededGate = gateProposedContent([{ path: filePath, content }], { projectRoot, tscUnavailableSeverity: "error" });
    put(filePath, content);
    const materialized = errors(projectRoot);
    assert(materialized.some(error => error.code === ASSIGNMENT_ERROR));
    report("first_source", { coldSidecar, coldGate, seededGate, materialized });
}

function changedConfiguration(): void {
    const projectRoot = join(root, "changed-configuration");
    const base = join(projectRoot, "base.json");
    const filePath = join(projectRoot, "widget.ts");
    put(base, json({ compilerOptions: { ...options, strictNullChecks: false } }));
    put(join(projectRoot, "tsconfig.json"), json({ extends: "./base.json", include: ["*.ts"] }));
    put(filePath, "export const before = 1;\n");
    _setTscOverlayModeOverrideForTest("in-process");
    try {
        const warm = gateProposedContent([{ path: filePath, content: "export const before = 2;\n" }], { projectRoot, tscUnavailableSeverity: "error" });
        assert.equal(warm.ok, true);
        put(base, json({ compilerOptions: { ...options, strictNullChecks: true } }));
        assert.deepEqual(errors(projectRoot), []);
        const content = "export const value: string = null;\n";
        const staleGate = gateProposedContent([{ path: filePath, content }], { projectRoot, tscUnavailableSeverity: "error" });
        const freshSidecar = runOverlayViaSidecarTyped({ projectRoot, filePath, content });
        clearOverlayServiceCache(projectRoot);
        const clearedGate = gateProposedContent([{ path: filePath, content }], { projectRoot, tscUnavailableSeverity: "error" });
        put(filePath, content);
        const materialized = errors(projectRoot);
        assert(materialized.some(error => error.code === ASSIGNMENT_ERROR));
        report("changed_configuration", { warm, staleGate, freshSidecar, clearedGate, materialized });
    } finally {
        _setTscOverlayModeOverrideForTest(null);
        clearOverlayServiceCache(projectRoot);
    }
}

function notMeasuredRoundTrip(): void {
    const projectRoot = join(root, "orphan-round-trip");
    put(join(projectRoot, "tsconfig.json"), json({ compilerOptions: options, include: ["modules/*.ts"] }));
    const claimedPath = join(projectRoot, "modules/widget.ts");
    put(claimedPath, "export const value = 1;\n");
    const input = { projectRoot, filePath: join(projectRoot, "loose.ts"), content: "export const value = 1;\n" };
    const inProcess = runOverlayCheckInProcessTyped(input);
    assert.equal(inProcess.status, "not_measured");
    const nodeRequire = createRequire(import.meta.url);
    const tsxCli = join(dirname(nodeRequire.resolve("tsx/package.json")), "dist/cli.mjs");
    const main = join(import.meta.dirname, "../src/harness/check-engine/tool-runners/tsc-overlay-sidecar-main.ts");
    const child = spawnSync(process.execPath, [tsxCli, main], {
        input: json({ id: 17, method: "overlayCheck", protocolVersion: 1, params: input }),
        encoding: "utf8", timeout: 30_000,
    });
    assert.equal(child.status, 0);
    const reply = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}");
    assert.equal(reply.id, 17);
    assert.deepEqual(reply.result, []);
    assert.match(reply.notMeasured, /^project_orphan:/);
    const clientRuns = Array.from({ length: 4 }, () => runOverlayViaSidecarTyped(input));
    for (const result of clientRuns) {
        assert.equal(result.status, "unavailable");
        if (result.status === "unavailable") assert.match(result.reason, /^project_orphan:/);
    }
    const healthyAfter = runOverlayViaSidecarTyped({ projectRoot, filePath: claimedPath, content: "export const value = 2;\n" });
    assert.deepEqual(healthyAfter, { status: "ok", findings: [] });
    report("not_measured_round_trip", { inProcess, reply, clientRuns, healthyAfter });
}

try {
    firstSource();
    changedConfiguration();
    notMeasuredRoundTrip();
} finally {
    rmSync(root, { recursive: true, force: true });
}
