import type { AnalyzedFile } from "./analysis.js";
import { hashBytes } from "./inventory.js";
import type { SyntaxFacts } from "./analysis-syntax.js";
import type { InventoryFile } from "./measurement-types.js";
import { measurePythonFiles, type PythonFileRow, type PythonFunctionRow } from "./python-measure.js";
import type { StructureFunction } from "./structure.js";

export interface PythonCloneBody { hash: string; startOffset: number; endOffset: number; }
/** Facts the Python adapters read; JavaScript and TypeScript files never carry this. */
export interface PythonFacts { row: PythonFileRow; cloneHashes: Map<number, PythonCloneBody>; }

/** Same index as the TypeScript collector (`maintainability.ts`), 0 to 100, higher is better. */
function maintainability(fn: PythonFunctionRow): number {
    const loc = Math.max(1, fn.endLine - fn.line + 1);
    const raw = 171 - 5.2 * Math.log(Math.max(1, fn.volume)) - 0.23 * fn.cyclomatic - 16.2 * Math.log(loc);
    return Math.max(0, raw * 100 / 171);
}

function structureFunction(fn: PythonFunctionRow): StructureFunction {
    return { name: fn.name, line: fn.line, endLine: fn.endLine, startOffset: fn.startOffset, endOffset: fn.endOffset, tokens: fn.tokens,
        exposure: fn.exposure, cyclomatic: fn.cyclomatic, cognitive: fn.cognitive, difficulty: fn.difficulty, volume: fn.volume, maintainability: maintainability(fn) };
}

function cloneHashes(row: PythonFileRow): Map<number, PythonCloneBody> {
    const hashes = new Map<number, PythonCloneBody>();
    for (const fn of row.functions) {
        if (fn.cloneTokens) hashes.set(fn.startOffset, { hash: hashBytes(JSON.stringify(fn.cloneTokens)), startOffset: fn.bodyStart, endOffset: fn.endOffset });
    }
    return hashes;
}

/** Same entities as `analyzeSyntax`; `identifiers` holds the use count of each declared name only (the unused adapter reads nothing else). */
function pythonSyntax(row: PythonFileRow): SyntaxFacts {
    const { statements, declarations } = row.facts;
    return { statements, tests: [], imports: [], declarations: declarations.map(({ name, line, exported, decorated }) => ({ name, line, exported, decorated })),
        identifiers: new Map(declarations.map(item => [item.name, item.uses])), topLevelTokens: row.topLevelTokens };
}

function analyzedFile(input: InventoryFile, row: PythonFileRow): AnalyzedFile {
    const structure = input.role === "product" ? { state: "measured" as const, typescriptVersion: "python-ast", astTokens: row.astTokens,
        physicalLines: input.content.split(/\r?\n/).length - Number(input.content.endsWith("\n")),
        types: { explicitAny: row.anyLines.length, unknown: 0, assertions: 0, nonNullAssertions: 0 }, functions: row.functions.map(structureFunction) } : null;
    return { input, structure, python: { row, cloneHashes: cloneHashes(row) },
        syntax: pythonSyntax(row) };
}

/** One isolated interpreter process for the whole batch; a file is a stated gap when it cannot be measured. */
export function analyzePythonFiles(inputs: readonly InventoryFile[], binary?: string): Map<string, AnalyzedFile | string> {
    const rows = measurePythonFiles(inputs, binary);
    const result = new Map<string, AnalyzedFile | string>();
    inputs.forEach((input, index) => {
        const row = rows[index];
        if (!row) result.set(input.path, "Python analyzer returned no row");
        else if ("error" in row) result.set(input.path, row.error.startsWith("Isolated") ? row.error : `Python source did not parse (${row.error})`);
        else result.set(input.path, analyzedFile(input, row));
    });
    return result;
}
