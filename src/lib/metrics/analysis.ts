import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { hasExactSyntax } from "../../harness/function-tokens/ast-tokens.js";
import { analyzeSyntax, type SyntaxFacts } from "./analysis-syntax.js";
import { isJavaScriptLanguage, sourceAnalysisExclusion } from "./inventory-roles.js";
import type { InventoryFile, InventoryGap, RepositoryInventory } from "./measurement-types.js";
import { analyzePythonFiles, type PythonFacts } from "./python-analysis.js";
import { measureStructure, type MeasuredStructure } from "./structure.js";

export interface AnalyzedFile { input: InventoryFile; syntax: SyntaxFacts; structure: MeasuredStructure | null; /** Set only for Python files. */ python?: PythonFacts; }
export interface RepositoryAnalysis { inventory: RepositoryInventory; files: AnalyzedFile[]; gaps: InventoryGap[]; exclusions: InventoryGap[]; }
export interface AnalysisOptions {
    /** Profiles that only support JavaScript and TypeScript (the diagnostics census) turn Python off. Default on. */
    python?: boolean;
    /** Interpreter name for the Python batch; tests only. */
    pythonBinary?: string;
}

function analyzeFile(input: InventoryFile, python: Map<string, AnalyzedFile | string>): AnalyzedFile | string {
    const analyzed = python.get(input.path);
    if (analyzed !== undefined) return analyzed;
    if (!isJavaScriptLanguage(input.language)) return `No scoring adapter for ${input.language ?? "this source language"}`;
    const parsed = parseTsSource(input.content, input.path);
    if (!parsed || !hasExactSyntax(parsed)) return "Parser unavailable or source requires recovery";
    const structure = input.role === "product" ? measureStructure(input.content, input.path) : null;
    if (structure?.state === "unavailable") return structure.reason;
    return { input, syntax: analyzeSyntax(parsed), structure };
}

function selectedPython(inventory: RepositoryInventory, options: AnalysisOptions): Map<string, AnalyzedFile | string> {
    if (options.python === false) return new Map();
    const inputs = inventory.files.filter(file => (file.role === "product" || file.role === "test") && file.language === "python");
    return analyzePythonFiles(inputs, options.pythonBinary);
}

export function analyzeRepository(inventory: RepositoryInventory, options: AnalysisOptions = {}): RepositoryAnalysis {
    const analysis: RepositoryAnalysis = { inventory, files: [], gaps: [...inventory.gaps], exclusions: [] };
    const python = selectedPython(inventory, options);
    for (const file of inventory.files) {
        if (file.role !== "product" && file.role !== "test") continue;
        const exclusion = sourceAnalysisExclusion(file.path, file.content);
        if (exclusion) {
            analysis.exclusions.push({ path: file.path, role: file.role, reason: exclusion });
            continue;
        }
        const measured = analyzeFile(file, python);
        if (typeof measured === "string") analysis.gaps.push({ path: file.path, role: file.role, reason: measured });
        else analysis.files.push(measured);
    }
    return analysis;
}
