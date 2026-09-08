import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import ts from "typescript";
import { selfImportOptionsResolution, resolvesToSelf } from "../src/harness/checks/self-import-resolve.js";
import { scanSelfImports, selfImportNotMeasuredWarning } from "../src/harness/checks/self-import-scan.js";
import { gateProposedContent } from "../src/harness/content-gate.js";

const root = mkdtempSync(join(import.meta.dirname, "shadow-review-r3-"));
const options = { composite: true, module: "ESNext", moduleResolution: "Bundler", moduleSuffixes: [".native", ""] };
function put(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}
function json(path: string, value: unknown): void { put(path, JSON.stringify(value)); }
function actualProject(configPath: string, importer: string) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    return {
        rootFile: parsed.fileNames.includes(importer),
        inProgram: program.getSourceFile(importer) !== undefined,
        errors: [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map(error => error.code),
        resolved: ts.resolveModuleName("./widget.js", importer, parsed.options, ts.sys).resolvedModule?.resolvedFileName,
    };
}
const content = 'export { x } from "./widget.js";\n';
try {
    const capped = join(root, "capped");
    const importer = join(capped, "src/widget.ts");
    put(importer, content);
    put(join(capped, "src/widget.native.ts"), "export const x = 1;\n");
    put(join(capped, "other.ts"), "export const other = 1;\n");
    const references: { path: string }[] = [];
    for (let index = 0; index < 31; index += 1) {
        const name = `tsconfig.other${index}.json`;
        json(join(capped, name), { compilerOptions: options, files: ["other.ts"] });
        references.push({ path: `./${name}` });
    }
    const appConfig = join(capped, "tsconfig.app.json");
    json(appConfig, { compilerOptions: options, include: ["src"] });
    const appRef = { path: "./tsconfig.app.json" };
    json(join(capped, "tsconfig.json"), { files: [], references: [...references, appRef] });
    console.log("reference_cap", JSON.stringify({
        selected: selfImportOptionsResolution(importer),
        findings: scanSelfImports(content, importer),
        warning: selfImportNotMeasuredWarning(importer),
        actual: actualProject(appConfig, importer),
    }));
    json(join(capped, "tsconfig.json"), { files: [], references: [appRef, ...references] });
    console.log("reference_cap_reordered", JSON.stringify({
        selected: selfImportOptionsResolution(importer), findings: scanSelfImports(content, importer),
    }));

    const transitive = join(root, "transitive");
    const declaration = join(transitive, "src/widget.d.ts");
    put(declaration, content);
    put(join(transitive, "src/widget.native.ts"), "export const x = 1;\n");
    put(join(transitive, "src/main.ts"), '/// <reference path="./widget.d.ts" />\nexport const main = 1;\n');
    json(join(transitive, "tsconfig.json"), { files: [], references: [{ path: "./tsconfig.app.json" }] });
    const transitiveConfig = join(transitive, "tsconfig.app.json");
    json(transitiveConfig, { compilerOptions: options, files: ["src/main.ts", "src/widget.native.ts"] });
    console.log("transitive_member", JSON.stringify({
        selected: selfImportOptionsResolution(declaration),
        findings: scanSelfImports(content, declaration),
        warning: selfImportNotMeasuredWarning(declaration),
        actual: actualProject(transitiveConfig, declaration),
    }));

    const batch = join(root, "batch");
    const batchImporter = join(batch, "widget.ts");
    const sibling = join(batch, "widget.native.ts");
    put(batchImporter, "export const before = 1;\n");
    json(join(batch, "tsconfig.json"), { compilerOptions: options, include: ["*.ts"] });
    const entries = [{ path: sibling, content: "export const x = 1;\n" }, { path: batchImporter, content }];
    const gate = gateProposedContent(entries, { projectRoot: batch });
    console.log("batch_overlay", JSON.stringify({ ok: gate.ok, selfImportFailures: gate.failures.filter(failure => failure.code === "self_import") }));
    for (const entry of entries) put(entry.path, entry.content);
    console.log("batch_materialized", JSON.stringify({ findings: scanSelfImports(content, batchImporter), actual: actualProject(join(batch, "tsconfig.json"), batchImporter) }));
} finally {
    rmSync(root, { recursive: true, force: true });
}
