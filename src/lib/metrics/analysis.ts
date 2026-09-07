import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { hasExactSyntax } from "../../harness/function-tokens/ast-tokens.js";
import { analyzeSyntax, type SyntaxFacts } from "./analysis-syntax.js";
import { isJavaScriptLanguage } from "./inventory-roles.js";
import type { InventoryFile, InventoryGap, RepositoryInventory } from "./measurement-types.js";
import { measureStructure, type MeasuredStructure } from "./structure.js";

export interface AnalyzedFile { input: InventoryFile; syntax: SyntaxFacts; structure: MeasuredStructure | null; }
export interface RepositoryAnalysis { inventory: RepositoryInventory; files: AnalyzedFile[]; gaps: InventoryGap[]; }

function analyzeFile(input: InventoryFile): AnalyzedFile | string {
    if (!isJavaScriptLanguage(input.language)) return `No scoring adapter for ${input.language ?? "this source language"}`;
    const parsed = parseTsSource(input.content, input.path);
    if (!parsed || !hasExactSyntax(parsed)) return "Parser unavailable or source requires recovery";
    const structure = input.role === "product" ? measureStructure(input.content, input.path) : null;
    if (structure?.state === "unavailable") return structure.reason;
    return { input, syntax: analyzeSyntax(parsed), structure };
}

export function analyzeRepository(inventory: RepositoryInventory): RepositoryAnalysis {
    const analysis: RepositoryAnalysis = { inventory, files: [], gaps: [...inventory.gaps] };
    for (const file of inventory.files) {
        if (file.role !== "product" && file.role !== "test") continue;
        const measured = analyzeFile(file);
        if (typeof measured === "string") analysis.gaps.push({ path: file.path, role: file.role, reason: measured });
        else analysis.files.push(measured);
    }
    return analysis;
}
