import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { clearOverlayServiceCache, runOverlayCheckInProcessTyped, type RunTscOverlayInput } from "../src/harness/check-engine/tool-runners/tsc-overlay-service.js";
import { runOverlayViaSidecarTyped } from "../src/harness/check-engine/tool-runners/tsc-overlay-sidecar-client.js";
import { gateProposedContent } from "../src/harness/content-gate.js";

// Controlled filesystem interleaving through the production service and gate.
// The read wrapper delegates to the real TypeScript disk reader and performs
// one real write after its read, before returning the actual bytes it read.
// It never fabricates compiler answers or file contents. The wrapper is removed
// before all subsequent checks. Every write stays inside this owned scratch tree.
const root = mkdtempSync(join(import.meta.dirname, "../scratch/shadow-review-r11-"));
const numberDependency = "export const value: number = 1;\n";
const stringDependency = 'export const value: string = "changed";\n';
const consumerContent = 'import { value } from "./dependency.js";\nexport const result: number = value;\n';
const baselineContent = 'import { value } from "./dependency.js";\nexport const result = value;\n';
const ASSIGNMENT_ERROR = 2322;
type Timing = "interleaved" | "between-runs";
const options: ts.CompilerOptions = {
    strict: true, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
};

function project(name: string): string {
    const dir = join(root, name);
    mkdirSync(join(dir, ".interlinked"), { recursive: true });
    writeFileSync(join(dir, ".interlinked", "guard-rules.local.json"), JSON.stringify({ tsc_overlay: { mode: "in-process" } }));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true,
        target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
    }, include: ["*.ts"] }));
    return dir;
}

function seedInterleaving(input: RunTscOverlayInput, dependency: string, before: string, after: string, timing: Timing) {
    const originalRead = ts.sys.readFile;
    let writes = 0;
    ts.sys.readFile = (fileName, encoding) => {
        const content = originalRead(fileName, encoding);
        if (timing === "interleaved" && fileName === dependency && writes === 0) {
            assert.equal(content, before);
            writeFileSync(dependency, after);
            writes += 1;
        }
        return content;
    };
    try {
        const duringWrite = runOverlayCheckInProcessTyped(input);
        if (timing === "between-runs") {
            writeFileSync(dependency, after);
            writes += 1;
        }
        assert.equal(writes, 1);
        assert.equal(readFileSync(dependency, "utf8"), after);
        return { writes, duringWrite };
    } finally {
        ts.sys.readFile = originalRead;
    }
}

function controls(input: RunTscOverlayInput, dependency: string, expectedValid: boolean) {
    const freshSidecar = runOverlayViaSidecarTyped(input);
    clearOverlayServiceCache(input.projectRoot);
    const clearedGate = gate(input);
    writeFileSync(input.filePath, input.content);
    const diskErrors = ts.getPreEmitDiagnostics(ts.createProgram([input.filePath, dependency], options)).map(diagnostic => diagnostic.code);
    assert.equal(clearedGate.ok, expectedValid);
    assert.deepEqual(diskErrors, expectedValid ? [] : [ASSIGNMENT_ERROR]);
    assert.equal(freshSidecar.status, "ok");
    if (freshSidecar.status === "ok") assert.equal(freshSidecar.findings.length === 0, expectedValid);
    return { freshSidecar, clearedGate, diskErrors };
}

function gate(input: RunTscOverlayInput) {
    return gateProposedContent([{ path: input.filePath, content: input.content }], { projectRoot: input.projectRoot, tscUnavailableSeverity: "error" });
}

function snapshotThenWrite(direction: "number-to-string" | "string-to-number", timing: Timing) {
    const dir = project(`${direction}-${timing}`);
    const dependency = join(dir, "dependency.ts");
    const before = direction === "number-to-string" ? numberDependency : stringDependency;
    const after = direction === "number-to-string" ? stringDependency : numberDependency;
    writeFileSync(dependency, before);
    const consumer = join(dir, "consumer.ts");
    writeFileSync(consumer, baselineContent);
    const input = { projectRoot: dir, filePath: consumer, content: consumerContent };
    try {
        const seeded = seedInterleaving(input, dependency, before, after, timing);
        const stableRuns = Array.from({ length: 3 }, () => runOverlayCheckInProcessTyped(input));
        const warmGate = gate(input);
        const checked = controls(input, dependency, direction === "string-to-number");
        if (timing === "between-runs") assert.equal(warmGate.ok, direction === "string-to-number");
        console.log(JSON.stringify({ direction, timing, ...seeded, stableRuns, warmGate, ...checked }));
    } finally {
        clearOverlayServiceCache(dir);
    }
}

try {
    snapshotThenWrite("number-to-string", "interleaved");
    snapshotThenWrite("string-to-number", "interleaved");
    snapshotThenWrite("number-to-string", "between-runs");
    snapshotThenWrite("string-to-number", "between-runs");
} finally {
    rmSync(root, { recursive: true, force: true });
}
