import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { contentIdentity } from "../src/harness/check-engine/tool-runners/tsc-overlay-identity.js";
import { clearOverlayServiceCache, runOverlayCheckInProcessTyped } from "../src/harness/check-engine/tool-runners/tsc-overlay-service.js";
import { runOverlayViaSidecarTyped } from "../src/harness/check-engine/tool-runners/tsc-overlay-sidecar-client.js";
import { gateProposedContent } from "../src/harness/content-gate.js";

// Real BOM-marked UTF-16 source files, read by the installed TypeScript
// compiler. Writes complete between checks; no reader or compiler is mocked.
// Every fixture lives in this owned scratch tree and is removed in finally.
const root = mkdtempSync(join(import.meta.dirname, "../scratch/shadow-review-r12-"));
const loneSurrogate = String.fromCharCode(0xd800);
const replacement = String.fromCharCode(0xfffd);
const ASSIGNMENT_ERROR = 2322;
const baseline = 'import { value } from "./dependency.js";\nexport const result = value;\n';
const proposal = `import { value } from "./dependency.js";\nexport const result: ${JSON.stringify(loneSurrogate)} = value;\n`;
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
    writeFileSync(join(dir, "consumer.ts"), baseline);
    return dir;
}

function writeDependency(path: string, character: string): string {
    const content = `export const value = "${character}" as const;\n`;
    writeFileSync(path, Buffer.from(`\ufeff${content}`, "utf16le"));
    assert.equal(ts.sys.readFile(path), content);
    return content;
}

function caseOf(name: string, before: string, after: string, expectedCollision: boolean): void {
    const dir = project(name);
    const dependency = join(dir, "dependency.ts");
    const consumer = join(dir, "consumer.ts");
    const input = { projectRoot: dir, filePath: consumer, content: proposal };
    const gate = () => gateProposedContent([{ path: consumer, content: proposal }], { projectRoot: dir, tscUnavailableSeverity: "error" });
    try {
        const initialText = writeDependency(dependency, before);
        assert.deepEqual(ts.getPreEmitDiagnostics(ts.createProgram([consumer, dependency], options)), []);
        const warmup = runOverlayCheckInProcessTyped(input);
        const finalText = writeDependency(dependency, after);
        assert.notEqual(initialText, finalText);
        const sameDigest = contentIdentity(initialText) === contentIdentity(finalText);
        const warmGate = gate();
        const freshSidecar = runOverlayViaSidecarTyped(input);
        clearOverlayServiceCache(dir);
        const clearedGate = gate();
        writeFileSync(consumer, proposal);
        const diskErrors = ts.getPreEmitDiagnostics(ts.createProgram([consumer, dependency], options)).map(diagnostic => diagnostic.code);
        const expectedValid = after === loneSurrogate;
        assert.equal(clearedGate.ok, expectedValid);
        assert.deepEqual(diskErrors, expectedValid ? [] : [ASSIGNMENT_ERROR]);
        assert.equal(freshSidecar.status, "ok");
        if (freshSidecar.status === "ok") assert.equal(freshSidecar.findings.length === 0, expectedValid);
        if (!expectedCollision) assert.equal(warmGate.ok, expectedValid);
        console.log(JSON.stringify({ name, beforeCodeUnit: before.charCodeAt(0), afterCodeUnit: after.charCodeAt(0), sameDigest, warmup, warmGate, freshSidecar, clearedGate, diskErrors }));
    } finally {
        clearOverlayServiceCache(dir);
    }
}

try {
    caseOf("surrogate-to-replacement", loneSurrogate, replacement, true);
    caseOf("replacement-to-surrogate", replacement, loneSurrogate, true);
    caseOf("surrogate-to-ascii", loneSurrogate, "a", false);
    caseOf("ascii-to-surrogate", "a", loneSurrogate, false);
} finally {
    rmSync(root, { recursive: true, force: true });
}
