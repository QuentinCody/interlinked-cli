import { dirname, resolve } from "node:path";
import type * as TS from "typescript";
import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { isJavaScriptLanguage } from "./inventory-roles.js";
import type { RepositoryInventory } from "./measurement-types.js";
import { measurementCompilerOptions } from "./typed-program.js";

function inventoryHost(inventory: RepositoryInventory, ts: typeof TS, options: TS.CompilerOptions): TS.CompilerHost {
    const contents = new Map(inventory.files.map(file => [resolve(inventory.root, file.path), file.content]));
    const directories = new Set<string>();
    for (const path of contents.keys()) {
        for (let directory = dirname(path); !directories.has(directory); directory = dirname(directory)) directories.add(directory);
    }
    const host = ts.createCompilerHost(options, true);
    const readFile = host.readFile, fileExists = host.fileExists, directoryExists = host.directoryExists;
    const libraryDirectory = dirname(ts.getDefaultLibFilePath(options));
    const standardLibrary = (path: string): boolean => dirname(resolve(path)) === libraryDirectory && /[/\\]lib\.[^/\\]+\.d\.ts$/.test(path);
    // Proposed/deleted local source must come from the inventory, never stale disk bytes.
    host.readFile = path => contents.get(resolve(path)) ?? (standardLibrary(path) ? readFile(path) : undefined);
    host.fileExists = path => contents.has(resolve(path)) || (standardLibrary(path) && fileExists(path));
    host.directoryExists = path => directories.has(resolve(path)) || directoryExists?.(path) === true;
    return host;
}

interface ExportProgram { ts: typeof TS; program: TS.Program; options: TS.CompilerOptions; host: TS.CompilerHost; }

function exportDiagnostic(source: TS.SourceFile, context: ExportProgram): TS.Diagnostic | undefined {
    const { ts, program } = context;
    const declarations = source.statements.filter(ts.isExportDeclaration);
    return program.getSemanticDiagnostics(source).find(diagnostic =>
        // Conflicting exports can be diagnosed on declaration names instead of export lists.
        [2308, 2323, 2484, 2528].includes(diagnostic.code) || declarations.some(declaration =>
            diagnostic.start !== undefined && diagnostic.start >= declaration.getStart(source) && diagnostic.start < declaration.end));
}

function reexportSources(source: TS.SourceFile, context: ExportProgram): Array<TS.SourceFile | string> {
    const { ts, program, options, host } = context;
    return source.statements.filter(ts.isExportDeclaration).flatMap(declaration => {
        if (!declaration.moduleSpecifier || !ts.isStringLiteral(declaration.moduleSpecifier)) return [];
        const specifier = declaration.moduleSpecifier.text;
        const resolved = ts.resolveModuleName(specifier, source.fileName, options, host).resolvedModule;
        const dependency = resolved && program.getSourceFile(resolved.resolvedFileName);
        return [dependency ?? `Re-export source unavailable: ${specifier}`];
    });
}

function moduleIssue(source: TS.SourceFile, context: ExportProgram, seen: Set<string>): string | null {
    if (seen.has(source.fileName)) return null;
    seen.add(source.fileName);
    const { ts, program } = context;
    const first = program.getSyntacticDiagnostics(source)[0] ?? exportDiagnostic(source, context);
    if (first) return ts.flattenDiagnosticMessageText(first.messageText, " ");
    for (const dependency of reexportSources(source, context)) {
        if (typeof dependency === "string") return dependency;
        const issue = moduleIssue(dependency, context, seen);
        if (issue) return issue;
    }
    return null;
}

function exportedNames(source: TS.SourceFile, context: ExportProgram): Set<string> | string {
    const { ts, program } = context;
    const checker = program.getTypeChecker(), symbol = checker.getSymbolAtLocation(source);
    const exports = symbol ? checker.getExportsOfModule(symbol) : [];
    for (const exported of exports) {
        if (exported.flags & ts.SymbolFlags.Alias && !checker.getAliasedSymbol(exported).declarations?.length) return `Unresolved exported binding: ${exported.getName()}`;
    }
    return new Set(exports.map(item => item.getName()));
}

function moduleExports(path: string, context: ExportProgram): Set<string> | string {
    const { ts, program } = context;
    const optionIssue = program.getOptionsDiagnostics()[0];
    if (optionIssue) return ts.flattenDiagnosticMessageText(optionIssue.messageText, " ");
    const source = program.getSourceFile(path);
    if (!source) return "Source unavailable";
    const issue = moduleIssue(source, context, new Set());
    if (issue) return issue;
    return exportedNames(source, context);
}

/** Share one compiler program; module symbols retain aliases, default and transitive re-exports. */
export function exportContractReader(inventory: RepositoryInventory, paths: string[]): (path: string, name: string) => boolean | string {
    if (!paths.length) return () => "No export contracts requested";
    const parsed = parseTsSource("", "contract.ts");
    if (!parsed) return () => "TypeScript compiler unavailable for export analysis";
    const { ts } = parsed;
    const configured = measurementCompilerOptions(inventory, ts);
    if (configured.issues.length) return () => configured.issues.join("; ");
    const options = { ...configured.options, allowJs: true, checkJs: true, types: [] };
    const host = inventoryHost(inventory, ts, options);
    const roots = inventory.files.filter(file => paths.includes(file.path) && isJavaScriptLanguage(file.language));
    const program = ts.createProgram(roots.map(file => resolve(inventory.root, file.path)), options, host);
    const results = new Map<string, Set<string> | string>();
    return (path, name) => {
        let result = results.get(path);
        if (result === undefined) {
            result = moduleExports(resolve(inventory.root, path), { ts, program, options, host });
            results.set(path, result);
        }
        return typeof result === "string" ? `Export analysis incomplete for ${path}: ${result}` : result.has(name);
    };
}
