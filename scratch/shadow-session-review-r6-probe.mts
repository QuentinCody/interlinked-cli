import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { runMultiEdit } from "../src/commands/multi-edit.js";
import { gateProposedContent } from "../src/harness/content-gate.js";
import { scanSelfImports } from "../src/harness/checks/self-import-scan.js";
import { evaluateTscDiffOverlay } from "../src/harness/diff-overlay.js";

// Every write stays in a unique reviewer-owned scratch project.
const root = mkdtempSync(join(import.meta.dirname, "shadow-review-r6-"));
const ASSIGNMENT_ERROR = 2322;
const options = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, skipLibCheck: true, strict: true };
function put(path: string, value: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
}
function json(value: unknown): string { return `${JSON.stringify(value, null, "\t")}\n`; }
function errors(configPath: string) {
    const raw = ts.readConfigFile(configPath, ts.sys.readFile);
    assert.equal(raw.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(configPath), undefined, configPath);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    return [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map(error => ({
        code: error.code, file: error.file?.fileName,
        message: ts.flattenDiagnosticMessageText(error.messageText, "\n"),
    }));
}
function report(name: string, value: unknown): void { console.log(name, JSON.stringify(value)); }

function unchangedConfig(): void {
    const projectRoot = join(root, "unchanged-config");
    const config = join(projectRoot, "tsconfig.json");
    const source = join(projectRoot, "value.ts");
    const configContent = json({ compilerOptions: options, include: ["*.ts"] });
    const before = "export const value = 1;\n";
    const after = "export const value = 2;\n";
    put(config, configContent);
    put(source, before);
    assert.deepEqual(errors(config), []);
    const batch = [{ path: source, content: after }, { path: config, content: configContent }];
    const gate = gateProposedContent(batch, { projectRoot, tscUnavailableSeverity: "error" });
    const multiEdit = runMultiEdit([
        { path: source, edits: [{ old_string: before, new_string: after }] },
        { path: config, edits: [{ old_string: configContent, new_string: configContent }] },
    ], { projectRoot });
    const withoutConfig = gateProposedContent(batch.slice(0, 1), { projectRoot, tscUnavailableSeverity: "error" });
    put(source, after);
    const materialized = errors(config);
    assert.deepEqual(materialized, []);
    report("unchanged_config", { gate, multiEdit, withoutConfig, materialized });
}

function baselineHistory(): void {
    const projectRoot = join(root, "baseline-history");
    const config = join(projectRoot, "tsconfig.json");
    const exporter = join(projectRoot, "value.ts");
    const consumer = join(projectRoot, "consumer.ts");
    const consumerContent = 'import { value } from "./value.js";\nexport const count: number = value;\n';
    const goodExport = "export const value = 1;\n";
    const badExport = 'export const value = "changed";\n';
    put(config, json({ compilerOptions: options, include: ["*.ts"] }));
    put(exporter, badExport);
    put(consumer, consumerContent);
    assert(errors(config).some(error => error.code === ASSIGNMENT_ERROR));
    const repair = gateProposedContent([
        { path: exporter, content: goodExport }, { path: consumer, content: consumerContent },
    ], { projectRoot, tscUnavailableSeverity: "error" });
    assert.equal(repair.ok, true);
    put(exporter, goodExport);
    const repairedDisk = errors(config);
    assert.deepEqual(repairedDisk, []);
    const reintroduce = gateProposedContent([
        { path: exporter, content: badExport }, { path: consumer, content: consumerContent },
    ], { projectRoot, tscUnavailableSeverity: "error" });
    put(exporter, badExport);
    const materialized = errors(config);
    assert(materialized.some(error => error.code === ASSIGNMENT_ERROR));
    report("baseline_history", { repair, repairedDisk, reintroduce, materialized });

    const fresh = join(root, "fresh-baseline-control");
    put(join(fresh, "tsconfig.json"), readFileSync(config, "utf8"));
    put(join(fresh, "value.ts"), goodExport);
    put(join(fresh, "consumer.ts"), consumerContent);
    report("fresh_baseline_control", gateProposedContent([
        { path: join(fresh, "value.ts"), content: badExport },
        { path: join(fresh, "consumer.ts"), content: consumerContent },
    ], { projectRoot: fresh, tscUnavailableSeverity: "error" }));
}

function independentProject(): void {
    const projectRoot = join(root, "independent-project");
    const appConfig = join(projectRoot, "tsconfig.app.json");
    const importer = join(projectRoot, "modules/widget.ts");
    const proposed = 'export { value } from "./widget.js";\n';
    put(join(projectRoot, "tsconfig.json"), json({ compilerOptions: options, files: ["build.ts"] }));
    put(join(projectRoot, "build.ts"), "export const build = 1;\n");
    put(appConfig, json({ compilerOptions: { ...options, moduleSuffixes: [".native", ""] }, include: ["modules"] }));
    put(importer, "export const before = 1;\n");
    put(join(projectRoot, "modules/widget.native.ts"), "export const value = 1;\n");
    assert.deepEqual(errors(appConfig), []);
    const selfImport = scanSelfImports(proposed, importer);
    const gate = gateProposedContent([{ path: importer, content: proposed }], { projectRoot, tscUnavailableSeverity: "error" });
    put(importer, proposed);
    const materialized = errors(appConfig);
    assert.deepEqual(materialized, []);
    report("independent_project", { selfImport, gate, materialized });
}

function singleFileHistory(): void {
    const projectRoot = join(root, "single-file-history");
    const config = join(projectRoot, "tsconfig.json");
    const exporter = join(projectRoot, "value.ts");
    const consumer = join(projectRoot, "consumer.ts");
    const consumerContent = 'import { value } from "./value.js";\nexport const count: number = value;\n';
    put(config, json({ compilerOptions: options, include: ["*.ts"] }));
    put(exporter, 'export const value = "changed";\n');
    put(join(projectRoot, "alternate.ts"), 'export const value = "changed";\n');
    put(consumer, consumerContent);
    // A refused proposal primes the baseline without changing the consumer on disk.
    const refused = evaluateTscDiffOverlay(consumer, consumerContent + "export const pending: = 1;\n", projectRoot);
    assert(refused.newFindings.length > 0);
    put(exporter, "export const value = 1;\n");
    assert.deepEqual(errors(config), []);
    // The later proposal introduces the same error afresh through a different import.
    const proposed = consumerContent.replace("./value.js", "./alternate.js");
    const next = evaluateTscDiffOverlay(consumer, proposed, projectRoot);
    put(consumer, proposed);
    const materialized = errors(config);
    assert(materialized.some(error => error.code === ASSIGNMENT_ERROR));
    report("single_file_history", { refused, next, materialized });
}

try {
    unchangedConfig();
    baselineHistory();
    independentProject();
    singleFileHistory();
} finally {
    rmSync(root, { recursive: true, force: true });
}
