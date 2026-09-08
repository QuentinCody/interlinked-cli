import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import ts from "typescript";
import { gateProposedContent } from "../src/harness/content-gate.js";
import { scanSelfImports, selfImportNotMeasuredWarning } from "../src/harness/checks/self-import-scan.js";
import { selfImportOptionsResolution } from "../src/harness/checks/self-import-resolve.js";
import { withProposedFiles } from "../src/harness/checks/proposed-files.js";
import { runPreBlockRegistryGate } from "../src/harness/pre-block-gate.js";
import { gateProposedContentInline } from "../src/commands/multi-edit-apply.js";

const root = mkdtempSync(join(import.meta.dirname, "shadow-review-r4-"));
const content = 'export { x } from "./widget.js";\n';
const options = { composite: true, module: "ESNext", moduleResolution: "Bundler", moduleSuffixes: [".native", ""] };
function put(path: string, value: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
}
function json(value: unknown): string { return `${JSON.stringify(value, null, "\t")}\n`; }
function project(configPath: string, importer: string) {
    const raw = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(configPath), undefined, configPath);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    return { rootFile: parsed.fileNames.includes(importer), inProgram: program.getSourceFile(importer) !== undefined,
        errors: [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map(error => error.code),
        resolved: ts.resolveModuleName("./widget.js", importer, parsed.options, ts.sys).resolvedModule?.resolvedFileName };
}
try {
    const batchRoot = join(root, "batch");
    const importer = join(batchRoot, "widget.ts");
    const sibling = join(batchRoot, "widget.native.ts");
    put(importer, "export const before = 1;\n");
    put(join(batchRoot, "tsconfig.json"), json({ compilerOptions: options, include: ["*.ts"] }));
    const entries = [{ path: sibling, content: "export const x = 1;\n" }, { path: importer, content }];
    console.log("valid_batch_gate", JSON.stringify(gateProposedContent(entries, { projectRoot: batchRoot })));
    for (const entry of entries) put(entry.path, entry.content);
    console.log("valid_batch_materialized", JSON.stringify(project(join(batchRoot, "tsconfig.json"), importer)));

    const configPath = join(batchRoot, "tsconfig.json");
    const proposedConfig = json({ compilerOptions: { ...options, moduleSuffixes: [""] }, include: ["*.ts"] });
    console.log("baseline_before_config_change", JSON.stringify(scanSelfImports(content, importer)));
    const view = new Map([[configPath, proposedConfig], [importer, content]]);
    withProposedFiles(view, () => {
        console.log("proposed_after_config_change", JSON.stringify(scanSelfImports(content, importer)));
        console.log("baseline_classification", JSON.stringify(runPreBlockRegistryGate({ content, filePath: importer, baselineContent: content, projectRoot: batchRoot }).filter(outcome => outcome.checkId === "self_import")));
    });
    console.log("config_batch_gate", JSON.stringify(gateProposedContent([{ path: configPath, content: proposedConfig }, { path: importer, content }], { projectRoot: batchRoot })));
    put(configPath, proposedConfig);
    console.log("config_batch_materialized", JSON.stringify(project(configPath, importer)));

    const alternate = join(root, "alternate");
    const altImporter = join(alternate, "modules/widget.ts");
    put(altImporter, content);
    put(join(alternate, "modules/widget.native.ts"), "export const x = 1;\n");
    put(join(alternate, "build.ts"), "export const build = 1;\n");
    put(join(alternate, "tsconfig.json"), json({ compilerOptions: { ...options, moduleSuffixes: [""] }, files: ["build.ts"] }));
    const appConfig = join(alternate, "tsconfig.app.json");
    put(appConfig, json({ compilerOptions: options, include: ["modules"] }));
    console.log("unreferenced_project", JSON.stringify({ selected: selfImportOptionsResolution(altImporter), findings: scanSelfImports(content, altImporter), warning: selfImportNotMeasuredWarning(altImporter), actual: project(appConfig, altImporter) }));

    const parity = join(root, "multi-edit");
    const parityFile = join(parity, "widget.ts");
    put(parityFile, "export const x = 1;\n");
    put(join(parity, "tsconfig.json"), json({ compilerOptions: { ...options, moduleSuffixes: [""] }, include: ["*.ts"] }));
    const parityBatch = [{ path: parityFile, content: 'import "./widget.js";\nexport const x = 1;\n' }];
    console.log("multi_edit_parity", JSON.stringify({
        shared: gateProposedContent(parityBatch, { projectRoot: parity }),
        multiEdit: gateProposedContentInline(parityBatch, { projectRoot: parity }),
    }));
} finally {
    rmSync(root, { recursive: true, force: true });
}
