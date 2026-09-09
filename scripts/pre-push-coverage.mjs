import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Record the provider's effective inclusion decision in the same Vitest run. */
export default class PushCoverageScopeReporter {
    onInit(ctx) {
        const destination = process.env.INTERLINKED_PRE_PUSH_COVERAGE_SCOPE;
        if (!destination) throw new Error("Missing pre-push coverage scope destination");
        const provider = ctx.coverageProvider;
        if (typeof provider?.isIncluded !== "function") throw new Error("Coverage provider cannot establish its effective scope");
        const paths = (process.env.INTERLINKED_PRE_PUSH_COVERAGE_TARGETS ?? "").split(",").filter(Boolean);
        const included = Object.fromEntries(paths.map(path => [path, provider.isIncluded(resolve(ctx.config.root, path))]));
        if (Object.values(included).some(value => typeof value !== "boolean")) throw new Error("Coverage provider returned an unknown inclusion decision");
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, JSON.stringify({ version: 1, root: ctx.config.root, included }));
    }
}

function resolvedScope(root, scopePath, changedPaths) {
    if (scopePath === undefined) return null;
    const scope = JSON.parse(readFileSync(scopePath, "utf8"));
    if (!scope || scope.version !== 1 || resolve(scope.root) !== root || !scope.included || typeof scope.included !== "object" ||
        changedPaths.some(path => !Object.hasOwn(scope.included, path) || typeof scope.included[path] !== "boolean")) {
        throw new Error("Coverage scope is missing or does not describe this pushed revision");
    }
    return scope.included;
}

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
export function assertCoverageMembership(root, reportPath, baselinePath, changedPaths, scopePath) {
    const scope = resolvedScope(root, scopePath, changedPaths);
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
    let runtimeTargets = 0;
    for (const path of changedPaths) {
        if (scope?.[path] === false) continue;
        if (/(?:^|\/)(?:__tests__|tests?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/.test(path)) continue;
        const absolute = resolve(root, path);
        try { lstatSync(absolute); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (hasOnlyTypes(ts, path, readFileSync(absolute, "utf8"))) continue;
        runtimeTargets++;
        if (!Object.hasOwn(baseline.files, path)) continue;
        const entry = entries.get(path);
        if (![entry?.lines?.pct, entry?.branches?.pct].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)) missing.push(path);
    }
    if (missing.length) throw new Error(`Coverage is unmeasured for changed baselined source: ${missing.join(", ")}`);
    return runtimeTargets;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const [root, report, baseline, changed, scope] = process.argv.slice(2);
        console.log(assertCoverageMembership(root, report, baseline, changed.split(",").filter(Boolean), scope));
    } catch (error) {
        console.error(`[pre-push] ${error.message}`);
        process.exitCode = 1;
    }
}
