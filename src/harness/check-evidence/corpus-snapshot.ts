import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { evidenceDigest } from "../finding-outcomes.js";

export type CorpusScope = "source" | "tests" | "source-and-tests";
export interface CorpusFailure { file: string; message: string }
export interface CorpusInput { file: string; digest: string; content: string }
export interface CorpusSnapshot {
    inputs: CorpusInput[];
    failures: CorpusFailure[];
    exclusions: string[];
    discovered: number;
    eligible: number;
    digest: string;
}
const EXCLUDED = new Set(["node_modules", ".git", ".interlinked", "dist", "coverage", "__fixtures__", "fixtures"]);
/** Explicit test-only scope for the first cohort; unknown detectors survey both domains. */
export function corpusScope(check: string): CorpusScope {
    return check === "unawaited_async_assertion" ? "tests" : "source-and-tests";
}
function eligible(file: string, scope: CorpusScope): boolean {
    if (!/\.[cm]?[jt]sx?$/.test(file) || file.endsWith(".d.ts")) return false;
    const test = /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.includes("/__tests__/");
    return scope === "source-and-tests" || (scope === "tests" ? test : !test);
}
function visitFile(path: string, root: string, scope: CorpusScope, out: CorpusSnapshot): void {
    const file = relative(root, path);
    out.discovered++;
    if (!eligible(file, scope)) { out.exclusions.push(file); return; }
    out.eligible++;
    try {
        // Bound retained input memory and keep oversized inputs visibly incomplete.
        if (lstatSync(path).size > 2_000_000) throw new Error("input exceeds 2 MB scan budget");
        const content = readFileSync(path, "utf8");
        out.inputs.push({ file, content, digest: evidenceDigest(content) });
    } catch (error) { out.failures.push({ file, message: String(error) }); }
}
function visit(path: string, root: string, scope: CorpusScope, out: CorpusSnapshot): void {
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error("symlink input is outside the declared traversal contract");
        if (!stat.isDirectory()) { visitFile(path, root, scope, out); return; }
        for (const name of readdirSync(path).sort()) {
            const child = join(path, name);
            if (EXCLUDED.has(name)) out.exclusions.push(relative(root, child));
            else visit(child, root, scope, out);
        }
    } catch (error) { out.failures.push({ file: relative(root, path), message: String(error) }); }
}
/** Snapshot exact bytes read; failed discovery never becomes a successful empty scan. */
export function captureCorpusInputs(searchRoot: string, repoRoot: string, scope: CorpusScope): CorpusSnapshot {
    const out: CorpusSnapshot = { inputs: [], failures: [], exclusions: [], discovered: 0, eligible: 0, digest: "" };
    visit(resolve(searchRoot), resolve(repoRoot), scope, out);
    out.digest = evidenceDigest(JSON.stringify({ scope, inputs: out.inputs.map(({ file, digest }) => [file, digest]),
        failures: out.failures, excluded_directories: [...EXCLUDED] }));
    return out;
}
