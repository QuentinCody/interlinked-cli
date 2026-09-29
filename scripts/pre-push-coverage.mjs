import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// A STATIC import, resolved beside this script: the check-identity binder hashes every statically resolvable
// dependency of a reporter, while a computed load (createRequire, import(expr)) is unresolvable and would make
// every coverage run fresh-only. The compiler that classifies type-only changes is therefore this checkout's.
import ts from "typescript";

/** Every code file under src/ (the coverage universe), so a scope recorded without explicit targets serves any later push. */
function sourceFiles(root) {
    const found = [];
    const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) found.push(relative(root, path).replaceAll("\\", "/"));
        }
    };
    if (existsSync(join(root, "src"))) walk(join(root, "src"));
    return found.sort();
}

/**
 * Record the provider's effective inclusion decision in the same Vitest run. The destination comes from
 * INTERLINKED_PRE_PUSH_COVERAGE_SCOPE (the raw pre-push route) or INTERLINKED_COVERAGE_SCOPE_FILE (the scheduler
 * route, which points inside the run directory so the scope travels with the receipt); without explicit
 * targets every src/ code file is recorded, which makes the scope reusable for any changed-file set.
 */
export default class PushCoverageScopeReporter {
    onInit(ctx) {
        const destination = process.env.INTERLINKED_PRE_PUSH_COVERAGE_SCOPE ?? process.env.INTERLINKED_COVERAGE_SCOPE_FILE;
        if (!destination) throw new Error("Missing pre-push coverage scope destination");
        const provider = ctx.coverageProvider;
        if (typeof provider?.isIncluded !== "function") throw new Error("Coverage provider cannot establish its effective scope");
        const targets = (process.env.INTERLINKED_PRE_PUSH_COVERAGE_TARGETS ?? "").split(",").filter(Boolean);
        const paths = targets.length ? targets : sourceFiles(ctx.config.root);
        const included = Object.fromEntries(paths.map(path => [path, provider.isIncluded(resolve(ctx.config.root, path))]));
        if (Object.values(included).some(value => typeof value !== "boolean")) throw new Error("Coverage provider returned an unknown inclusion decision");
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, JSON.stringify({ version: 1, root: ctx.config.root, included }));
    }
}

/**
 * The recorded scope: project-relative inclusion decisions plus the absolute root the run happened in. The root
 * is informational — the receipt's identity, not this path, binds the scope to the bytes it describes — so a scope
 * recorded in another export of the same revision is accepted here and its run root is returned for re-rooting.
 */
function resolvedScope(root, scopePath, changedPaths) {
    if (scopePath === undefined) return null;
    const scope = JSON.parse(readFileSync(scopePath, "utf8"));
    // A changed path that no longer exists (deleted in the pushed revision) cannot be a runtime target and cannot be
    // in a scope recorded from disk; every path that does exist must be described.
    const present = changedPaths.filter(path => existsSync(resolve(root, path)));
    if (!scope || scope.version !== 1 || typeof scope.root !== "string" || !scope.included || typeof scope.included !== "object" ||
        present.some(path => !Object.hasOwn(scope.included, path) || typeof scope.included[path] !== "boolean")) {
        throw new Error("Coverage scope is missing or does not describe this pushed revision");
    }
    return { included: scope.included, runRoot: resolve(scope.root) };
}

/** Report keys are absolute paths under the RUN's root; map them to project-relative paths whichever root recorded them. */
function reportEntries(report, roots) {
    return new Map(Object.entries(report).map(([path, entry]) => {
        const base = roots.find(candidate => path === candidate || path.startsWith(`${candidate}/`)) ?? roots[0];
        return [relative(base, resolve(base, path)).replaceAll("\\", "/"), entry];
    }));
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
    const resolved = resolvedScope(root, scopePath, changedPaths);
    const scope = resolved?.included ?? null;
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("Invalid coverage summary");
    if (!baseline || baseline.version !== 1 || !baseline.files || typeof baseline.files !== "object" || Array.isArray(baseline.files)) {
        throw new Error("Invalid coverage baseline");
    }
    const entries = reportEntries(report, resolved ? [resolved.runRoot, root] : [root]);
    // `ts` is the static top-level import (see the module header).
    const missing = [];
    let runtimeTargets = 0;
    for (const path of changedPaths) {
        const verdict = classifyChangedPath({ ts, root, path, scope, baseline, entries });
        if (verdict === "skip") continue;
        runtimeTargets++;
        if (verdict === "unmeasured") missing.push(path);
    }
    if (missing.length) throw new Error(`Coverage is unmeasured for changed baselined source: ${missing.join(", ")}`);
    return runtimeTargets;
}

/** Mirrors `src/harness/coverage-metric-names.ts::COVERAGE_METRICS` — this
 *  script runs from the git hook without the TS build, so it cannot import it.
 *  json-summary always emits all four; an absent one is unmeasured, never 0. */
const COVERAGE_METRICS = ["lines", "statements", "functions", "branches"];
const TEST_OR_TYPES_PATH = /(?:^|\/)(?:__tests__|tests?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;
const isPct = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

/** "skip" = not a runtime target; otherwise a runtime target that is
 *  "measured" (every metric present, or not baselined yet) or "unmeasured". */
function classifyChangedPath({ ts, root, path, scope, baseline, entries }) {
    if (scope?.[path] === false || TEST_OR_TYPES_PATH.test(path)) return "skip";
    const absolute = resolve(root, path);
    try { lstatSync(absolute); }
    catch (error) { if (error.code === "ENOENT") return "skip"; throw error; }
    if (hasOnlyTypes(ts, path, readFileSync(absolute, "utf8"))) return "skip";
    if (!Object.hasOwn(baseline.files, path)) return "measured";
    const entry = entries.get(path);
    return COVERAGE_METRICS.every(metric => isPct(entry?.[metric]?.pct)) ? "measured" : "unmeasured";
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
