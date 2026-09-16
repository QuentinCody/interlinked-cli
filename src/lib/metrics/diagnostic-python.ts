import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { qualityFinding } from "./adapter-values.js";
import { lineUnionCounts } from "./diagnostic-lines.js";
import { PYTHON_DIAGNOSTIC_PROFILE } from "./diagnostic-profile.js";
import { PYTHON_DIAGNOSTIC_SCRIPT } from "./diagnostic-python-script.js";
import { aggregateDiagnostics, type DiagnosticFile, type DiagnosticFunction, type DiagnosticReport } from "./diagnostic-report.js";
import { natural, record, textField } from "./evidence-json.js";
import { collectRepositoryInventory, hashBytes, inventoryHash } from "./inventory.js";
import type { InventoryFile, InventoryGap, QualityFinding, RepositoryInventory } from "./measurement-types.js";
import type { JsonObject } from "../json-types.js";

interface PythonMeasurement {
    input: InventoryFile; file: DiagnosticFile; functions: DiagnosticFunction[]; findings: QualityFinding[];
    clones: { hash: string; startOffset: number; endOffset: number; lines: number[] }[];
}
const TOTAL_BUDGET_MS = 30_000;
const BATCH_TIMEOUT_MS = 10_000;
const BATCH_FILES = 8;

function objects(value: unknown): JsonObject[] {
    if (!Array.isArray(value)) throw new Error("Invalid Python analyzer rows");
    return value.map(item => record(item, "Python row"));
}
function lines(value: unknown): number[] {
    if (!Array.isArray(value)) throw new Error("Invalid Python analyzer lines");
    return [...new Set(value.map(line => natural(line, "line")))].sort((a, b) => a - b);
}
function parseFunction(row: JsonObject, file: string): DiagnosticFunction {
    const sloc = natural(row.sloc, "SLOC"), cyclomatic = natural(row.cyclomatic, "CC");
    const mass = cyclomatic * Math.sqrt(sloc);
    return { file, name: textField(row.name, "name"), sloc, cyclomatic, mass,
        line: natural(row.line, "line"), endLine: natural(row.endLine, "endLine"),
        startOffset: natural(row.startOffset, "startOffset"), endOffset: natural(row.endOffset, "endOffset"),
        highComplexityMass: cyclomatic > 10 ? mass : 0 };
}
function clone(row: JsonObject): PythonMeasurement["clones"][number][] {
    if (!Array.isArray(row.cloneTokens)) throw new Error("Invalid Python clone sequence");
    if (!row.cloneTokens.length) return [];
    const tokens = row.cloneTokens.map(item => {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[1] !== "string") throw new Error("Invalid Python clone token");
        return [natural(item[0], "token kind"), item[1]];
    });
    return [{ hash: hashBytes(JSON.stringify(tokens)), startOffset: natural(row.bodyStart, "body start"),
        endOffset: natural(row.endOffset, "body end"), lines: lines(row.cloneLines) }];
}
function parseMeasurement(input: InventoryFile, value: unknown): PythonMeasurement {
    const row = record(value, "Python measurement"), patterns = objects(row.patterns), functions = objects(row.functions);
    const patternLines = lines(patterns.flatMap(pattern => lines(pattern.lines)));
    const findings = patterns.map(pattern => {
        const covered = lines(pattern.lines);
        return qualityFinding({ file: input, metric: "opposite_boolean_returns", line: covered[0] ?? 1, endLine: covered.at(-1) ?? 1,
            message: "Opposite boolean returns in if/else; review a direct predicate expression while preserving truth conversion and evaluation behavior" });
    });
    return { input, functions: functions.map(fn => parseFunction(fn, input.path)), findings, clones: functions.flatMap(clone),
        file: { path: input.path, language: "python", sourceSha256: input.sha256, sloc: natural(row.sloc, "file SLOC"),
            patternLines, cloneLines: [], redundantCloneLines: [], counts: lineUnionCounts(patternLines, []) } };
}

function runBatch(batch: InventoryFile[], timeout: number) {
    const result = spawnSync("python3", ["-I", "-S", "-B", "-c", PYTHON_DIAGNOSTIC_SCRIPT], {
        encoding: "utf8", input: JSON.stringify(batch.map(file => ({ path: file.path, content: file.content }))), timeout,
        maxBuffer: 16 * 1024 * 1024, cwd: "/" });
    if (result.error || result.status !== 0) throw new Error("Isolated Python >=3.10 analyzer unavailable, failed, or exceeded its budget");
    const parsed = record(JSON.parse(result.stdout), "Python response");
    const rows = objects(parsed.files);
    if (rows.length !== batch.length || rows.some((row, i) => row.path !== batch[i]?.path)) throw new Error("Python response population mismatch");
    return { parser: textField(parsed.parser, "Python version"), rows };
}

function measurePython(files: InventoryFile[]) {
    const measured: PythonMeasurement[] = [], gaps: InventoryGap[] = [], parsers = new Set<string>();
    const deadline = performance.now() + TOTAL_BUDGET_MS;
    for (let i = 0; i < files.length; i += BATCH_FILES) {
        const batch = files.slice(i, i + BATCH_FILES);
        try {
            const remaining = Math.floor(deadline - performance.now());
            if (remaining <= 0) throw new Error("Python census exhausted its 30-second budget");
            const result = runBatch(batch, Math.min(BATCH_TIMEOUT_MS, remaining));
            const completed: PythonMeasurement[] = [], failed: InventoryGap[] = [];
            for (const [index, row] of result.rows.entries()) {
                const input = batch[index]!;
                if (row.error) failed.push({ path: input.path, role: "product", reason: textField(row.error, "parse error") });
                else completed.push(parseMeasurement(input, row.result));
            }
            parsers.add(result.parser);
            measured.push(...completed);
            gaps.push(...failed);
        } catch (error) {
            for (const input of files.slice(i)) gaps.push({ path: input.path, role: "product", reason: String(error) });
            break;
        }
    }
    return { measured, gaps, parsers: [...parsers].sort() };
}

function mergeClones(measured: PythonMeasurement[]): DiagnosticReport["clones"] {
    const groups = new Map<string, DiagnosticReport["clones"][number]["members"]>();
    for (const file of measured) for (const clone of file.clones) {
        const group = groups.get(clone.hash) ?? [];
        group.push({ file: file.input.path, sourceSha256: file.input.sha256, startOffset: clone.startOffset,
            endOffset: clone.endOffset, lines: clone.lines, representative: group.length === 0 });
        groups.set(clone.hash, group);
    }
    const clones = [...groups].filter(([, members]) => members.length > 1).map(([hash, members]) => ({ hash, members }));
    const byPath = new Map(measured.map(file => [file.input.path, file.file]));
    for (const group of clones) for (const member of group.members) {
        const file = byPath.get(member.file)!;
        file.cloneLines.push(...member.lines);
        if (!member.representative) file.redundantCloneLines.push(...member.lines);
    }
    for (const { file } of measured) {
        file.cloneLines = lines(file.cloneLines);
        file.redundantCloneLines = lines(file.redundantCloneLines);
        file.counts = lineUnionCounts(file.patternLines, file.cloneLines);
    }
    return clones;
}

/** Separate language profile; does not change JS/TS scoring or existing Python edit gates. */
export function collectPythonDiagnosticReport(root: string): DiagnosticReport {
    const inventory = collectRepositoryInventory(root);
    return measurePythonDiagnosticInventory(inventory);
}

export function measurePythonDiagnosticInventory(inventory: RepositoryInventory): DiagnosticReport {
    const isTest = (file: InventoryFile): boolean => /(^|\/)(test_[^/]+\.py|[^/]+_test\.py|conftest\.py)$/.test(file.path);
    const inputs = inventory.files.filter(file => file.role === "product" && !isTest(file));
    const selected = inputs.filter(file => file.language === "python").sort((a, b) => a.path.localeCompare(b.path));
    const { measured, gaps, parsers } = measurePython(selected);
    const notMeasured = [...inventory.gaps.filter(gap => gap.role === "product"), ...gaps,
        ...inputs.filter(file => file.language !== "python").map(file => ({ path: file.path, role: file.role, reason: "Unsupported in Python diagnostic profile" }))];
    const exclusions = [...inventory.excluded, ...inventory.files.filter(file => !inputs.includes(file))
        .map(file => ({ path: file.path, role: isTest(file) ? "test" as const : file.role, reason: "Python profile excludes non-product source and Python test names" }))];
    const clones = mergeClones(measured), files = measured.map(file => file.file), functions = measured.flatMap(file => file.functions);
    const roleVersion = `${inventory.version}+python-test-names-v1`;
    return { schemaVersion: 1, profile: PYTHON_DIAGNOSTIC_PROFILE, modelCalls: 0, sourceHash: inventoryHash(inputs), inputHash: inventory.inputHash,
        measurementIdentity: hashBytes(JSON.stringify([PYTHON_DIAGNOSTIC_PROFILE, roleVersion, parsers])), parsers,
        scope: { roleVersion, discovery: inventory.discovery, eligibleFiles: inputs.length + inventory.gaps.filter(gap => gap.role === "product").length,
            measuredFiles: files.length, status: notMeasured.length || inventory.issues.length ? "partial" : "complete", notMeasured, exclusions, discoveryIssues: inventory.issues },
        ...aggregateDiagnostics(files, functions), files, functions, clones, findings: measured.flatMap(file => file.findings),
        limitations: ["Python AST/tokenize diagnostic profile; not radon or benchmark parity and not a quality verdict.",
            "Only exact function clones and opposite-boolean-return patterns are measured; matches are advisory.",
            "Ratios describe measured product files only. Parsing failures, unsupported languages and exhausted budgets remain gaps.",
            "Nested functions/classes do not add branches to enclosing functions. Function signatures count; decorators are module/enclosing code.",
            "CC > 10 is discontinuous and ratios can be diluted. No target code or tests are executed; no model calls or dependency installation."] };
}
