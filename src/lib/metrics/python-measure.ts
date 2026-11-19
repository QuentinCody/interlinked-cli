import { spawnSync } from "node:child_process";
import type { JsonObject } from "../json-types.js";
import { natural, record, textField } from "./evidence-json.js";
import type { InventoryFile } from "./measurement-types.js";
import { parsePythonFacts, type PythonModuleFacts } from "./python-facts.js";
import { PYTHON_SCORE_SCRIPT } from "./python-score-script.js";

const ANALYZER_TIMEOUT_MS = 120_000;
const ANALYZER_OUTPUT_LIMIT = 128 * 1024 * 1024;

export interface PythonFunctionRow {
    name: string; line: number; endLine: number; startOffset: number; endOffset: number; bodyStart: number;
    tokens: number; exposure: number; cyclomatic: number; cognitive: number; volume: number; difficulty: number;
    /** Exact written-token sequence of the body; null below 30 tokens. */
    cloneTokens: (readonly [number, string])[] | null;
}
export interface PythonImportRow { module: string; level: number; names: string[]; line: number; typeOnly: boolean; }
export interface PythonFileRow {
    astTokens: number; topLevelTokens: number; functions: PythonFunctionRow[]; imports: PythonImportRow[];
    deadStores: number[]; initializers: number; annotationSlots: number; anyLines: number[];
    facts: PythonModuleFacts;
}
export type PythonRow = PythonFileRow | { error: string };

function finite(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid Python analyzer ${label}`);
    return value;
}
function list(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`Invalid Python analyzer ${label}`);
    return value;
}
function naturals(value: unknown, label: string): number[] { return list(value, label).map(item => natural(item, label)); }

function cloneSequence(value: unknown): PythonFunctionRow["cloneTokens"] {
    if (value === null) return null;
    return list(value, "clone tokens").map(item => {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[1] !== "string") throw new Error("Invalid Python analyzer clone token");
        return [natural(item[0], "token kind"), item[1]] as const;
    });
}

function parseFunction(row: JsonObject): PythonFunctionRow {
    return { name: textField(row.name, "name"), line: natural(row.line, "line"), endLine: natural(row.endLine, "endLine"),
        startOffset: natural(row.startOffset, "startOffset"), endOffset: natural(row.endOffset, "endOffset"), bodyStart: natural(row.bodyStart, "bodyStart"),
        tokens: natural(row.tokens, "tokens"), exposure: natural(row.exposure, "exposure"), cyclomatic: natural(row.cyclomatic, "cyclomatic"),
        cognitive: natural(row.cognitive, "cognitive"), volume: finite(row.volume, "volume"), difficulty: finite(row.difficulty, "difficulty"),
        cloneTokens: cloneSequence(row.cloneTokens) };
}

function parseImport(row: JsonObject): PythonImportRow {
    return { module: typeof row.module === "string" ? row.module : "", level: natural(row.level, "level"), line: natural(row.line, "line"),
        names: list(row.names, "names").map(name => textField(name, "name")), typeOnly: row.typeOnly === true };
}

function parseFile(value: unknown): PythonFileRow {
    const row = record(value, "Python measurement");
    return { astTokens: natural(row.astTokens, "astTokens"), topLevelTokens: natural(row.topLevelTokens, "topLevelTokens"),
        functions: list(row.functions, "functions").map(item => parseFunction(record(item, "function"))),
        imports: list(row.imports, "imports").map(item => parseImport(record(item, "import"))),
        deadStores: naturals(row.deadStores, "dead stores"), initializers: natural(row.initializers, "initializers"),
        annotationSlots: natural(row.annotationSlots, "annotation slots"), anyLines: naturals(row.anyLines, "Any lines"),
        facts: parsePythonFacts(row.facts) };
}

export function pythonAvailable(binary = "python3"): boolean {
    const probe = spawnSync(binary, ["-I", "-S", "-B", "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], { encoding: "utf8", cwd: "/", timeout: 10_000 });
    return !probe.error && probe.status === 0;
}

function unavailable(files: readonly InventoryFile[], reason: string): PythonRow[] { return files.map(() => ({ error: reason })); }

/**
 * One isolated `python3 -I -S -B -c <fixed script>` process for the whole batch. The script parses and tokenizes source text
 * with the standard library; no target module is imported or run. Every outcome is one row per input, in order.
 */
export function measurePythonFiles(files: readonly InventoryFile[], binary = "python3"): PythonRow[] {
    if (!files.length) return [];
    const result = spawnSync(binary, ["-I", "-S", "-B", "-c", PYTHON_SCORE_SCRIPT], {
        encoding: "utf8", cwd: "/", timeout: ANALYZER_TIMEOUT_MS, maxBuffer: ANALYZER_OUTPUT_LIMIT,
        input: JSON.stringify(files.map(file => ({ path: file.path, content: file.content }))) });
    if (result.error || result.status !== 0) {
        return unavailable(files, `Isolated python3 (3.10 or newer) analyzer unavailable, failed, or exceeded its time or output budget (${binary}); Python files were not measured`);
    }
    try {
        const rows = list(record(JSON.parse(result.stdout), "Python response").files, "files");
        if (rows.length !== files.length) throw new Error("Python response population mismatch");
        return rows.map((item, index) => {
            const row = record(item, "Python row");
            if (row.path !== files[index]?.path) throw new Error("Python response order mismatch");
            return typeof row.error === "string" ? { error: row.error } : parseFile(row.result);
        });
    } catch (error) {
        return unavailable(files, `Python analyzer output was invalid (${error instanceof Error ? error.message : "unknown"}); Python files were not measured`);
    }
}
