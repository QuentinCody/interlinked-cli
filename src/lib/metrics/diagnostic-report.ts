import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { collectTrivialHelperEvidence } from "../../harness/checks/over-extraction.js";
import { exactCloneGroups } from "./adapter-clones.js";
import { qualityFinding } from "./adapter-values.js";
import { analyzeRepository, type AnalyzedFile, type RepositoryAnalysis } from "./analysis.js";
import { collectSourceLines, linesInSpan, lineUnionCounts, type SourceLines } from "./diagnostic-lines.js";
import { DIAGNOSTIC_LIMITATIONS, DIAGNOSTIC_PROFILE, diagnosticRatio, type PYTHON_DIAGNOSTIC_PROFILE } from "./diagnostic-profile.js";
import { collectRepositoryInventory, hashBytes } from "./inventory.js";
import type { QualityFinding, RepositoryInventory } from "./measurement-types.js";

export interface DiagnosticFunction {
    file: string; name: string; line: number; endLine: number; startOffset: number; endOffset: number;
    sloc: number; cyclomatic: number; mass: number; highComplexityMass: number;
}
export interface DiagnosticFile {
    path: string; sourceSha256: string; language: string | null; sloc: number;
    patternLines: number[]; cloneLines: number[]; redundantCloneLines: number[];
    counts: ReturnType<typeof lineUnionCounts>;
}
interface FileMeasurement {
    file: AnalyzedFile; source: SourceLines; functions: DiagnosticFunction[];
    patternLines: Set<number>; cloneLines: Set<number>; redundantCloneLines: Set<number>; findings: QualityFinding[];
}

function measureFile(file: AnalyzedFile): FileMeasurement {
    const parsed = parseTsSource(file.input.content, file.input.path);
    if (!parsed || !file.structure) throw new Error(`Previously measured parser unavailable: ${file.input.path}`);
    const source = collectSourceLines(parsed, file.structure.functions.map(fn => fn.startOffset));
    const functions = file.structure.functions.map(fn => {
        const sloc = source.functions.get(fn.startOffset)?.size ?? 0;
        const mass = fn.cyclomatic * Math.sqrt(sloc);
        return { file: file.input.path, name: fn.name, line: fn.line, endLine: fn.endLine,
            startOffset: fn.startOffset, endOffset: fn.endOffset, sloc, cyclomatic: fn.cyclomatic, mass,
            highComplexityMass: fn.cyclomatic > DIAGNOSTIC_PROFILE.erosionThreshold ? mass : 0 };
    });
    const patternLines = new Set<number>(), findings: QualityFinding[] = [];
    for (const match of collectTrivialHelperEvidence(parsed)) {
        const lines = linesInSpan(source, match.startOffset, match.endOffset);
        for (const line of lines) patternLines.add(line);
        findings.push(qualityFinding({ metric: "single_use_trivial_helper", file: file.input, line: match.line,
            endLine: lines.at(-1) ?? match.line, message: match.text }));
    }
    return { file, source, functions, patternLines, cloneLines: new Set(), redundantCloneLines: new Set(), findings };
}

function fileReport(measurement: FileMeasurement): DiagnosticFile {
    const sorted = (lines: Set<number>): number[] => [...lines].sort((a, b) => a - b);
    return { path: measurement.file.input.path, sourceSha256: measurement.file.input.sha256, language: measurement.file.input.language,
        sloc: measurement.source.sloc.size, patternLines: sorted(measurement.patternLines), cloneLines: sorted(measurement.cloneLines),
        redundantCloneLines: sorted(measurement.redundantCloneLines), counts: lineUnionCounts(measurement.patternLines, measurement.cloneLines) };
}

function cloneEvidence(analysis: RepositoryAnalysis, measured: Map<string, FileMeasurement>) {
    return [...exactCloneGroups(analysis)].filter(([, members]) => members.length > 1).map(([hash, members]) => ({
        hash, members: members.map((member, index) => {
            const file = measured.get(member.file.input.path)!;
            const lines = linesInSpan(file.source, member.startOffset, member.endOffset);
            for (const line of lines) {
                file.cloneLines.add(line);
                if (index > 0) file.redundantCloneLines.add(line);
            }
            return { file: member.file.input.path, sourceSha256: member.file.input.sha256,
                startOffset: member.startOffset, endOffset: member.endOffset, lines, representative: index === 0 };
        }),
    }));
}

function measurementScope(inventory: RepositoryInventory, analysis: RepositoryAnalysis) {
    const excluded = inventory.files.filter(file => file.role !== "product")
        .map(file => ({ path: file.path, role: file.role, reason: "Diagnostic profile measures product source only" }));
    return { roleVersion: String(inventory.version), discovery: inventory.discovery,
        eligibleFiles: analysis.inventory.files.length + analysis.inventory.gaps.length, measuredFiles: analysis.files.length,
        status: analysis.gaps.length || inventory.issues.length ? "partial" : "complete",
        notMeasured: analysis.gaps, exclusions: [...inventory.excluded, ...excluded], discoveryIssues: inventory.issues };
}

export function aggregateDiagnostics(files: DiagnosticFile[], functions: DiagnosticFunction[]) {
    const sum = (key: keyof DiagnosticFile["counts"]): number => files.reduce((total, file) => total + file.counts[key], 0);
    const totalMass = functions.reduce((total, fn) => total + fn.mass, 0);
    const highMass = functions.reduce((total, fn) => total + fn.highComplexityMass, 0);
    return {
        verbosity: { ...diagnosticRatio(sum("union"), files.reduce((total, file) => total + file.sloc, 0)),
            patternLines: sum("pattern"), cloneLines: sum("clone"), overlapLines: sum("overlap"),
            redundantCloneLines: files.reduce((total, file) => total + file.redundantCloneLines.length, 0) },
        erosion: { ...diagnosticRatio(highMass, totalMass), functions: functions.length,
            highComplexityFunctions: functions.filter(fn => fn.highComplexityMass > 0).length },
    };
}

export interface DiagnosticReport {
    schemaVersion: 1; profile: typeof DIAGNOSTIC_PROFILE | typeof PYTHON_DIAGNOSTIC_PROFILE; modelCalls: 0;
    sourceHash: string; inputHash: string; measurementIdentity: string; parsers: string[];
    scope: ReturnType<typeof measurementScope>;
    verbosity: ReturnType<typeof aggregateDiagnostics>["verbosity"];
    erosion: ReturnType<typeof aggregateDiagnostics>["erosion"];
    files: DiagnosticFile[]; functions: DiagnosticFunction[]; clones: ReturnType<typeof cloneEvidence>;
    findings: QualityFinding[]; limitations: string[];
}

/** Offline census. No composite weights, hook delivery or ratchet baselines are changed. */
export function measureDiagnosticInventory(inventory: RepositoryInventory): DiagnosticReport {
    const productInventory = { ...inventory, files: inventory.files.filter(file => file.role === "product"),
        gaps: inventory.gaps.filter(gap => gap.role === "product") };
    const analysis = analyzeRepository(productInventory);
    analysis.files.sort((a, b) => a.input.path.localeCompare(b.input.path));
    const measured = new Map(analysis.files.map(file => [file.input.path, measureFile(file)]));
    const clones = cloneEvidence(analysis, measured);
    const files = [...measured.values()].map(fileReport), functions = [...measured.values()].flatMap(file => file.functions);
    const parsers = [...new Set(analysis.files.map(file => file.structure!.typescriptVersion))].sort();
    return {
        schemaVersion: 1, profile: DIAGNOSTIC_PROFILE, modelCalls: 0, sourceHash: inventory.sourceHash, inputHash: inventory.inputHash,
        measurementIdentity: hashBytes(JSON.stringify([DIAGNOSTIC_PROFILE, inventory.version, parsers])), parsers,
        scope: measurementScope(inventory, analysis), ...aggregateDiagnostics(files, functions),
        files, functions, clones, findings: [...measured.values()].flatMap(file => file.findings), limitations: DIAGNOSTIC_LIMITATIONS,
    };
}

export function collectDiagnosticReport(root: string): DiagnosticReport {
    return measureDiagnosticInventory(collectRepositoryInventory(root));
}
