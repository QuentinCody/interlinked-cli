import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { gateProposedContent } from "../src/harness/content-gate.js";
import { clearOverlayServiceCache } from "../src/harness/check-engine/tool-runners/tsc-overlay-service.js";
import { runOverlayViaSidecarTyped } from "../src/harness/check-engine/tool-runners/tsc-overlay-sidecar-client.js";

// No guard bypass or test-only mode selector. All writes stay in this unique
// scratch tree; each fixture chooses in-process mode through its own config.
const root = mkdtempSync(join(import.meta.dirname, "../scratch/shadow-review-r9-"));
const ASSIGNMENT_ERROR = 2322;
const options = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, skipLibCheck: true, strict: true };
const numberDependency = "export const value: number = 1;\n";
const stringDependency = 'export const value: string = "new";\n';
function put(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}
function json(value: unknown): string { return `${JSON.stringify(value, null, "\t")}\n`; }
function report(name: string, result: unknown): void { console.log(name, JSON.stringify(result)); }
function project(name: string): string {
    const projectRoot = join(root, name);
    put(join(projectRoot, ".interlinked", "guard-rules.local.json"), json({ tsc_overlay: { mode: "in-process" } }));
    put(join(projectRoot, "tsconfig.json"), json({ compilerOptions: options, include: ["*.ts"] }));
    return projectRoot;
}
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
function consumerContent(module: string, assignment: string): string {
    return `import { value } from ${JSON.stringify(module)};\nexport const ${assignment} = value;\n`;
}
function warmConsumer(projectRoot: string, module: string): string {
    const filePath = join(projectRoot, "consumer.ts");
    put(filePath, consumerContent(module, "before"));
    assert.deepEqual(errors(projectRoot), []);
    assert.equal(gate(projectRoot, filePath, consumerContent(module, "warm")).ok, true);
    return filePath;
}
function controls(projectRoot: string, filePath: string, content: string, expectedValid: boolean) {
    const freshSidecar = runOverlayViaSidecarTyped({ projectRoot, filePath, content });
    assert.equal(freshSidecar.status, "ok");
    clearOverlayServiceCache(projectRoot);
    const clearedGate = gate(projectRoot, filePath, content);
    assert.equal(clearedGate.ok, expectedValid);
    put(filePath, content);
    const materialized = errors(projectRoot);
    if (expectedValid) assert.deepEqual(materialized, []);
    else assert(materialized.some(error => error.code === ASSIGNMENT_ERROR));
    return { freshSidecar, clearedGate, materialized };
}

function dependencyRewrite(timestamp: "same" | "backward" | "forward"): void {
    const projectRoot = project(`dependency-${timestamp}`);
    const dependencyPath = join(projectRoot, "dependency.ts");
    put(dependencyPath, numberDependency);
    const fixedTime = new Date("2025-01-01T00:00:00.000Z");
    utimesSync(dependencyPath, fixedTime, fixedTime);
    const filePath = warmConsumer(projectRoot, "./dependency.js");
    const beforeStat = statSync(dependencyPath);
    put(dependencyPath, stringDependency);
    const deltaMs = { same: 0, backward: -60_000, forward: 60_000 }[timestamp];
    utimesSync(dependencyPath, beforeStat.atime, new Date(beforeStat.mtimeMs + deltaMs));
    const afterStat = statSync(dependencyPath);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs + deltaMs);
    assert.deepEqual(errors(projectRoot), []);
    const content = consumerContent("./dependency.js", "mustBeNumber: number");
    const warmGate = gate(projectRoot, filePath, content);
    const checked = controls(projectRoot, filePath, content, false);
    report(`dependency_${timestamp}`, {
        mtimeBefore: beforeStat.mtimeMs, mtimeAfter: afterStat.mtimeMs,
        sizeBefore: beforeStat.size, sizeAfter: afterStat.size, warmGate, ...checked,
    });
}

function unlandedProposal(disposition: "accepted" | "rejected", direction: "number-to-string" | "string-to-number"): void {
    const projectRoot = project(`unlanded-${disposition}-${direction}`);
    const dependencyPath = join(projectRoot, "dependency.ts");
    const diskContent = direction === "number-to-string" ? numberDependency : stringDependency;
    const proposedContent = direction === "number-to-string" ? stringDependency : numberDependency;
    put(dependencyPath, diskContent);
    const filePath = warmConsumer(projectRoot, "./dependency.js");
    const proposal = proposedContent + (disposition === "rejected" ? "export const broken: = 1;\n" : "");
    const dependencyGate = gate(projectRoot, dependencyPath, proposal);
    assert.equal(dependencyGate.ok, disposition === "accepted");
    assert.equal(readFileSync(dependencyPath, "utf8"), diskContent);
    assert.deepEqual(errors(projectRoot), []);
    const content = consumerContent("./dependency.js", "mustBeNumber: number");
    const nextGate = gate(projectRoot, filePath, content);
    report(`unlanded_${disposition}_${direction}`, {
        dependencyGate, nextGate, ...controls(projectRoot, filePath, content, direction === "number-to-string"),
    });
}

function packageEntryRewrite(): void {
    const projectRoot = project("package-entry-rewrite");
    const packageRoot = join(projectRoot, "node_modules", "review-library");
    const packagePath = join(packageRoot, "package.json");
    put(join(packageRoot, "old.d.ts"), "export declare const value: number;\n");
    put(join(packageRoot, "new.d.ts"), "export declare const value: string;\n");
    put(packagePath, json({ name: "review-library", version: "1.0.0", types: "old.d.ts" }));
    const filePath = warmConsumer(projectRoot, "review-library");
    put(packagePath, json({ name: "review-library", version: "1.0.0", types: "new.d.ts" }));
    assert.deepEqual(errors(projectRoot), []);
    const content = consumerContent("review-library", "mustBeNumber: number");
    const warmGate = gate(projectRoot, filePath, content);
    report("package_entry_rewrite", { warmGate, ...controls(projectRoot, filePath, content, false) });
}

try {
    dependencyRewrite("same");
    dependencyRewrite("backward");
    dependencyRewrite("forward");
    unlandedProposal("accepted", "number-to-string");
    unlandedProposal("rejected", "number-to-string");
    unlandedProposal("accepted", "string-to-number");
    unlandedProposal("rejected", "string-to-number");
    packageEntryRewrite();
} finally {
    clearOverlayServiceCache();
    rmSync(root, { recursive: true, force: true });
}
