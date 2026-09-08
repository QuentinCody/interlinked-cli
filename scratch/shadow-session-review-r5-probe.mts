import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { gateProposedContent } from "../src/harness/content-gate.js";

// Reviewer-owned disposable projects only. No production writes or guard overrides.
const root = mkdtempSync(join(import.meta.dirname, "shadow-review-r5-"));
function put(path: string, value: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
}
function json(value: unknown): string { return `${JSON.stringify(value, null, "\t")}\n`; }
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
const options = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, skipLibCheck: true };

function configCase(name: string, baseName: string): void {
    const projectRoot = join(root, name);
    const base = join(projectRoot, baseName);
    const source = join(projectRoot, "widget.ts");
    put(base, json({ compilerOptions: { ...options, strictNullChecks: false } }));
    put(join(projectRoot, "tsconfig.json"), json({ extends: `./${baseName}`, include: ["*.ts"] }));
    put(source, "export const value: string = null;\n");
    assert.deepEqual(errors(projectRoot), []);
    const batch = [
        { path: base, content: json({ compilerOptions: { ...options, strictNullChecks: true } }) },
        { path: source, content: "export const value: string = null;\nexport const additional = 1;\n" },
    ];
    const gate = gateProposedContent(batch, { projectRoot, tscUnavailableSeverity: "error" });
    for (const entry of batch) put(entry.path, entry.content);
    const materialized = errors(projectRoot);
    assert(materialized.some(error => error.code === 2322));
    console.log(name, JSON.stringify({ gate, materialized }));
}

function siblingCase(name: string, changeImporter: boolean): void {
    const projectRoot = join(root, name);
    const exporter = join(projectRoot, "value.ts");
    const importer = join(projectRoot, "consumer.ts");
    const oldImporter = 'import { value } from "./value.js";\nexport const count: number = value;\n';
    put(join(projectRoot, "tsconfig.json"), json({ compilerOptions: options, include: ["*.ts"] }));
    put(exporter, "export const value = 1;\n");
    put(importer, oldImporter);
    assert.deepEqual(errors(projectRoot), []);
    const batch = [
        { path: exporter, content: 'export const value = "changed";\n' },
        { path: importer, content: oldImporter + (changeImporter ? "export const additional = 1;\n" : "") },
    ];
    const gate = gateProposedContent(batch, { projectRoot, tscUnavailableSeverity: "error" });
    for (const entry of batch) put(entry.path, entry.content);
    const materialized = errors(projectRoot);
    assert(materialized.some(error => error.code === 2322));
    console.log(name, JSON.stringify({ gate, materialized }));
}

try {
    configCase("custom_extends_name", "base.json");
    configCase("recognized_extends_name_control", "tsconfig.base.json");
    siblingCase("unchanged_importer", false);
    siblingCase("changed_importer_control", true);
} finally {
    rmSync(root, { recursive: true, force: true });
}
