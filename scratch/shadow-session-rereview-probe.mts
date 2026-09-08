// Review probes for the next round of Claude session 344d9ff3.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolvesToSelf, selfImportCompilerOptions, __resetSelfImportConfigCacheForTesting } from "../src/harness/checks/self-import-resolve.js";
import { scanSelfImports } from "../src/harness/checks/self-import-scan.js";
import ts from "typescript";
import { normalizeToolInput } from "../src/harness/shadow/protocol/tool-input.js";
import { projectPostImages } from "../src/harness/shadow/protocol/post-image-projector.js";

const root = mkdtempSync(join(import.meta.dirname, "shadow-session-rereview-"));
const config = (suffixes: string[]) => JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", moduleSuffixes: suffixes } });
function populate(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const importer = join(dir, "widget.ts");
    writeFileSync(importer, 'export { x } from "./widget.js";\n');
    writeFileSync(join(dir, "widget.native.ts"), "export const x = 1;\n");
    return importer;
}
try {
    writeFileSync(join(root, "base.json"), config([""]));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: "./base.json" }));
    const importer = populate(join(root, "src"));
    __resetSelfImportConfigCacheForTesting();
    const before = resolvesToSelf(importer, "./widget.js");
    writeFileSync(join(root, "base.json"), config([".native", ""]));
    const afterBaseChange = resolvesToSelf(importer, "./widget.js");
    __resetSelfImportConfigCacheForTesting();
    const fresh = resolvesToSelf(importer, "./widget.js");
    console.log("extends_cache", JSON.stringify({ before, afterBaseChange, fresh }));

    writeFileSync(join(root, "base.json"), config([""]));
    const nested = join(root, "nested");
    const nestedImporter = populate(nested);
    __resetSelfImportConfigCacheForTesting();
    const beforeCloserConfig = resolvesToSelf(nestedImporter, "./widget.js");
    writeFileSync(join(nested, "tsconfig.json"), config([".native", ""]));
    const afterCloserConfig = resolvesToSelf(nestedImporter, "./widget.js");
    __resetSelfImportConfigCacheForTesting();
    const freshCloserConfig = resolvesToSelf(nestedImporter, "./widget.js");
    console.log("discovery_cache", JSON.stringify({ beforeCloserConfig, afterCloserConfig, freshCloserConfig }));

    const solution = join(root, "solution");
    const solutionImporter = populate(join(solution, "src"));
    writeFileSync(join(solution, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }));
    writeFileSync(join(solution, "tsconfig.app.json"), JSON.stringify({ compilerOptions: { composite: true, module: "ESNext", moduleResolution: "Bundler", moduleSuffixes: [".native", ""] }, include: ["src"] }));
    __resetSelfImportConfigCacheForTesting();
    const appConfig = ts.readConfigFile(join(solution, "tsconfig.app.json"), ts.sys.readFile);
    const appProject = ts.parseJsonConfigFileContent(appConfig.config, ts.sys, solution);
    const actual = ts.resolveModuleName("./widget.js", solutionImporter, appProject.options, ts.sys).resolvedModule?.resolvedFileName;
    console.log("referenced_project", JSON.stringify({ ours: resolvesToSelf(solutionImporter, "./widget.js"), scan: scanSelfImports('export { x } from "./widget.js";\n', solutionImporter), selectedOptions: selfImportCompilerOptions(solutionImporter), configErrors: appProject.errors.map(error => error.code), checkedByApp: appProject.fileNames.includes(solutionImporter), actual }));
} finally {
    rmSync(root, { recursive: true, force: true });
    __resetSelfImportConfigCacheForTesting();
}

const patch = ["*** Begin Patch", "*** Update File: a.txt", "@@anchor", "-alpha", "+bravo", "*** End Patch"].join("\n");
const normalized = normalizeToolInput({ client: "codex", tool: "apply_patch", repo_root: "/repo", input: { patch } });
if (!normalized.ok) throw new Error(normalized.detail);
console.log("malformed_hunk_header", JSON.stringify(projectPostImages(normalized.normalized, new Map([["a.txt", "anchor\nalpha\n"]]))));
