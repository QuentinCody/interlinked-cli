import { lstatSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Only syntax erased regardless of compiler options can excuse an absent entry. */
function hasOnlyTypes(ts, path, content) {
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) return false;
    return source.statements.every(node => {
        if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEmptyStatement(node)) return true;
        if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return true;
        if (ts.isImportDeclaration(node)) return node.importClause?.isTypeOnly === true;
        if (ts.isImportEqualsDeclaration(node)) return node.isTypeOnly === true;
        if (ts.isExportDeclaration(node)) return node.isTypeOnly || (!node.moduleSpecifier && node.exportClause &&
            ts.isNamedExports(node.exportClause) && node.exportClause.elements.every(element => element.isTypeOnly));
        return false;
    });
}

/** A missing report entry is unavailable evidence, unless the pushed file no longer emits code. */
export function assertCoverageMembership(root, reportPath, baselinePath, changedPaths) {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("Invalid coverage summary");
    if (!baseline || baseline.version !== 1 || !baseline.files || typeof baseline.files !== "object" || Array.isArray(baseline.files)) {
        throw new Error("Invalid coverage baseline");
    }
    const entries = new Map(Object.entries(report).map(([path, entry]) => [relative(root, resolve(root, path)).replaceAll("\\", "/"), entry]));
    const require = createRequire(resolve(root, "package.json"));
    const ts = require("typescript");
    const missing = [];
    for (const path of changedPaths) {
        if (!Object.hasOwn(baseline.files, path) || /(?:^|\/)(?:__tests__|tests?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/.test(path)) continue;
        const absolute = resolve(root, path);
        try { lstatSync(absolute); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (hasOnlyTypes(ts, path, readFileSync(absolute, "utf8"))) continue;
        const entry = entries.get(path);
        if (![entry?.lines?.pct, entry?.branches?.pct].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)) missing.push(path);
    }
    if (missing.length) throw new Error(`Coverage is unmeasured for changed baselined source: ${missing.join(", ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const [root, report, baseline, changed] = process.argv.slice(2);
        assertCoverageMembership(root, report, baseline, changed.split(",").filter(Boolean));
    } catch (error) {
        console.error(`[pre-push] ${error.message}`);
        process.exitCode = 1;
    }
}
