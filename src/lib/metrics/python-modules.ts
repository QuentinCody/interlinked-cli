import type { AnalyzedFile } from "./analysis.js";
import type { ScoringEdge, ScoringGraph } from "./graph-types.js";
import type { PythonImportRow } from "./python-measure.js";

function dirname(path: string): string {
    const index = path.lastIndexOf("/");
    return index < 0 ? "" : path.slice(0, index);
}

function join(...parts: string[]): string { return parts.filter(Boolean).join("/"); }

/**
 * Static first-party resolution for Python imports. A module name resolves to a measured `.py` file or package
 * `__init__.py`; anything else is external and ignored. Search roots for absolute imports are the repository root,
 * `src/`, the importing file's own directory (script layout) and the top of its package chain.
 */
export function pythonModuleResolver(known: ReadonlySet<string>): (from: string, reference: PythonImportRow) => string[] {
    const exists = (path: string): boolean => known.has(path);
    const packageTop = (directory: string): string => {
        let current = directory;
        while (current && exists(join(current, "__init__.py"))) current = dirname(current);
        return current;
    };
    const moduleFile = (base: string, parts: readonly string[]): string | null => {
        const joined = join(base, ...parts);
        if (parts.length) return [`${joined}.py`, `${joined}/__init__.py`].find(exists) ?? null;
        const init = join(base, "__init__.py");
        return exists(init) ? init : null;
    };
    const bases = (from: string, reference: PythonImportRow): string[] => {
        const directory = dirname(from);
        if (reference.level > 0) {
            const parts = directory.split("/").filter(Boolean);
            return [parts.slice(0, Math.max(0, parts.length - (reference.level - 1))).join("/")];
        }
        return [...new Set(["", "src", directory, packageTop(directory)])];
    };
    const targets = (base: string, reference: PythonImportRow): string[] => {
        const parts = reference.module ? reference.module.split(".") : [];
        const selfModule = moduleFile(base, parts);
        if (reference.names.includes("*")) return selfModule ? [selfModule] : [];
        const submodules = reference.names.map(name => moduleFile(base, [...parts, name]));
        const found = submodules.filter((item): item is string => item !== null);
        return submodules.includes(null) && selfModule ? [...new Set([...found, selfModule])] : [...new Set(found)];
    };
    return (from, reference) => {
        for (const base of bases(from, reference)) {
            const found = targets(base, reference).filter(target => target !== from);
            if (found.length) return found;
        }
        return [];
    };
}

/** `import_module(name)` with a computed name cannot be resolved statically: the same stated gap as a non-literal `require()`. */
export function pythonDynamicImports(files: readonly AnalyzedFile[]): ScoringGraph["unresolved"] {
    return files.flatMap(file => (file.python?.row.facts.dynamicImports ?? []).map(line => ({ file: file.input.path, line, specifier: null })));
}

/** One edge per resolved first-party import of every Python file; `import` inside `TYPE_CHECKING` stays `typeOnly`, as in TypeScript. */
export function pythonScoringEdges(files: readonly AnalyzedFile[], known: ReadonlySet<string>): ScoringEdge[] {
    const resolve = pythonModuleResolver(known);
    return files.flatMap(file => (file.python?.row.imports ?? []).flatMap(reference => resolve(file.input.path, reference)
        .map(to => ({ from: file.input.path, to, line: reference.line, names: reference.names, typeOnly: reference.typeOnly }))));
}
