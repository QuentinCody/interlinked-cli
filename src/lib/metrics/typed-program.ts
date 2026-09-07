import { resolve } from "node:path";
import type * as TS from "typescript";
import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { isJsonObject } from "../json-types.js";
import type { RepositoryInventory } from "./measurement-types.js";

export interface TypedMeasurementProgram { ts: typeof TS; program: TS.Program; options: TS.CompilerOptions; issues: string[]; }

function compilerOptions(inventory: RepositoryInventory, ts: typeof TS): { options: TS.CompilerOptions; issues: string[] } {
    const defaults: TS.CompilerOptions = { strict: true, noEmit: true, skipLibCheck: true,
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
    const config = inventory.files.find(file => file.path === "tsconfig.json");
    if (!config) return { options: defaults, issues: [] };
    const raw = ts.parseConfigFileTextToJson(config.path, config.content);
    if (raw.error || !isJsonObject(raw.config)) return { options: defaults, issues: ["Invalid tsconfig.json"] };
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, inventory.root);
    return { options: { ...parsed.options, noEmit: true, skipLibCheck: true },
        issues: parsed.errors.filter(error => error.code !== 18003).map(error => ts.flattenDiagnosticMessageText(error.messageText, " ")) };
}

export function createTypedMeasurementProgram(inventory: RepositoryInventory): TypedMeasurementProgram | null {
    const loaded = parseTsSource("", "measurement.ts");
    if (!loaded) return null;
    const { ts } = loaded;
    const { options, issues } = compilerOptions(inventory, ts);
    const files = inventory.files.filter(file => file.language === "typescript" && file.role === "product");
    const contents = new Map(inventory.files.map(file => [resolve(inventory.root, file.path), file.content]));
    const host = ts.createCompilerHost(options);
    const originalRead = host.readFile;
    host.readFile = path => contents.get(resolve(path)) ?? originalRead(path);
    const program = ts.createProgram(files.map(file => resolve(inventory.root, file.path)), options, host);
    return { ts, program, options, issues };
}
