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
import { currentProcessSignal } from "../../harness/check-engine/process-cancellation.js";
import { runProcessAsync } from "../../harness/check-engine/spawn-async.js";
import type { InventoryOptions } from "./inventory-paths.js";

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
    return parseBatchOutput(batch, result.stdout);
}

function parseBatchOutput(batch: InventoryFile[], output: string) {
    const parsed = record(JSON.parse(output), "Python response");
    const rows = objects(parsed.files);
    if (rows.length !== batch.length || rows.some((row, i) => row.path !== batch[i]?.path)) throw new Error("Python response population mismatch");
    return { parser: textField(parsed.parser, "Python version"), rows };
}

function parseBatchMeasurements(batch: InventoryFile[], rows: JsonObject[]) {
    const completed: PythonMeasurement[] = [], failed: InventoryGap[] = [];
    for (const [index, row] of rows.entries()) {
        const input = batch[index]!;
        if (row.error) failed.push({ path: input.path, role: "product", reason: textField(row.error, "parse error") });
        else completed.push(parseMeasurement(input, row.result));
    }
    return { completed, failed };
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
            const { completed, failed } = parseBatchMeasurements(batch, result.rows);
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

/** Foreground surveys measure every batch, with owned cancellation and full output. */
async function measurePythonAsync(files: InventoryFile[], signal?: AbortSignal) {
    const measured: PythonMeasurement[] = [], gaps: InventoryGap[] = [], parsers = new Set<string>();
    const checkCancellation = () => { currentProcessSignal()?.throwIfAborted(); signal?.throwIfAborted(); };
    for (let i = 0; i < files.length; i += BATCH_FILES) {
        checkCancellation();
        const batch = files.slice(i, i + BATCH_FILES);
        try {
            const process = await runProcessAsync("python3", ["-I", "-S", "-B", "-c", PYTHON_DIAGNOSTIC_SCRIPT], {
                cwd: "/", input: JSON.stringify(batch.map(file => ({ path: file.path, content: file.content }))),
                timeout: 0, maxBufferBytes: null, ...(signal ? { signal } : {}),
            });
            checkCancellation();
            if (process.code !== 0 || process.killed || process.timedOut || process.stdoutTruncated || process.stderrTruncated) {
                throw new Error("Isolated Python analyzer unavailable, interrupted or incomplete");
            }
            const result = parseBatchOutput(batch, process.stdout), { completed, failed } = parseBatchMeasurements(batch, result.rows);
            parsers.add(result.parser); measured.push(...completed); gaps.push(...failed);
        } catch (error) {
            checkCancellation();
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
    const { inputs, selected } = pythonInputs(inventory);
    return buildPythonDiagnosticReport(inventory, inputs, measurePython(selected));
}

export async function collectPythonDiagnosticReportAsync(root: string, options: InventoryOptions = {}): Promise<DiagnosticReport> {
    currentProcessSignal()?.throwIfAborted(); options.signal?.throwIfAborted();
    const inventory = collectRepositoryInventory(root, { ...options, resourcePolicy: "foreground-survey" });
    return measurePythonDiagnosticInventoryAsync(inventory, options);
}

export async function measurePythonDiagnosticInventoryAsync(inventory: RepositoryInventory, options: Pick<InventoryOptions, "signal"> = {}): Promise<DiagnosticReport> {
    const { inputs, selected } = pythonInputs(inventory);
    return buildPythonDiagnosticReport(inventory, inputs, await measurePythonAsync(selected, options.signal));
}

function pythonInputs(inventory: RepositoryInventory) {
    const isTest = (file: InventoryFile): boolean => /(^|\/)(test_[^/]+\.py|[^/]+_test\.py|conftest\.py)$/.test(file.path);
    const inputs = inventory.files.filter(file => file.role === "product" && !isTest(file));
    const selected = inputs.filter(file => file.language === "python").sort((a, b) => a.path.localeCompare(b.path));
    return { inputs, selected };
}

function buildPythonDiagnosticReport(inventory: RepositoryInventory, inputs: InventoryFile[], measurement: ReturnType<typeof measurePython>): DiagnosticReport {
    const { measured, gaps, parsers } = measurement;
    const isTest = (file: InventoryFile): boolean => /(^|\/)(test_[^/]+\.py|[^/]+_test\.py|conftest\.py)$/.test(file.path);
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
