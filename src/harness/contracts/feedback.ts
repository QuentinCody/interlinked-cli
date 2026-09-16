import { existsSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { inspectContracts } from "./evidence.js";
import { contractDigest, contractPath, readContractFile, CONTRACT_MANIFEST } from "./paths.js";
import { isOraclePath, reviewExpectations } from "./review.js";

/** Post-edit advice only; no execution, Stop intervention, or claim of checked behavior. */
export function contractFeedback(root: string, paths: readonly string[], acknowledged: Set<string>): string[] {
    const messages: string[] = [], selected: string[] = [];
    const relativePaths = paths.map(path => isAbsolute(path) ? relative(root, path) : path);
    if (relativePaths.some(path => /\.(?:py|[cm]?[jt]sx?|rs|go|java|kt|cs|rb|php)$/.test(path)) && !acknowledged.has("contract-review:intro")) {
        acknowledged.add("contract-review:intro");
        messages.push("[interlinked:test-contract-review] [heuristic] Derive expected results from supplied requirements/examples before inspecting implementation output. Preserve existing invocation modes when extending behavior. Use tests contracts import/inspect/run for executable public examples; tests review for changed expectations. Passing tests or coverage alone cannot validate their expected answers.");
    }
    for (const path of relativePaths.filter(isOraclePath).slice(0, 32)) {
        try {
            const identity = existsSync(contractPath(root, path)) ? contractDigest(readContractFile(root, path, 256 * 1024)) : "deleted";
            const key = `contract-review:file:${path}:${identity}`;
            if (acknowledged.has(key)) continue;
            acknowledged.add(key); selected.push(path);
        } catch { messages.push(`[interlinked:test-contract-review] NOT REVIEWED: ${path} exceeds readable scope`); }
    }
    const review = reviewExpectations(root, selected);
    messages.push(...review.findings.slice(0, 3).map(row => `[interlinked:test-contract-review] [heuristic] ${row.path}: ${row.message}`));
    messages.push(...review.gaps.slice(0, 1).map(gap => `[interlinked:test-contract-review] NOT REVIEWED: ${gap}`));
    appendManifestAdvice(root, relativePaths, acknowledged, messages);
    return messages;
}

function appendManifestAdvice(root: string, paths: string[], acknowledged: Set<string>, messages: string[]): void {
    if (!paths.includes(CONTRACT_MANIFEST)) return;
    try {
        const report = inspectContracts(root).report;
        const key = `contract-review:manifest:${contractDigest(report)}`;
        if (acknowledged.has(key)) return;
        acknowledged.add(key);
        const unresolved = report.cases.filter(row => row.provenance !== "matched").length;
        messages.push(`[interlinked:test-contract-review] ${report.cases.length} declared cases; ${unresolved} unresolved/inferred sources; ${report.gaps.length} preservation gaps. No tests executed. Review proposed expectations, then run interlinked tests contracts run --json at a coherent change boundary.`);
    } catch (error) { messages.push(`[interlinked:test-contract-review] NOT REVIEWED: ${String(error)}`); }
}
