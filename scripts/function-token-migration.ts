/** Paired counts on identical bytes; never installs dependencies or executes target code. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { collectScoringSources } from "../src/lib/metrics/source-census.js";
import { computeTypeScriptFunctionTokens } from "../src/harness/function-tokens/typescript.js";
import { functionTokenProvenance } from "../src/harness/function-tokens/provenance.js";
import { isJsonObject } from "../src/lib/json-types.js";
import { computeLegacyFunctionTokens } from "./function-token-migration-legacy.js";

interface Repository { name: string; path: string; commit: string; }
interface Difference { file: string; sha256: string; name: string; line: number; old: number; current: number; }
type Source = ReturnType<typeof collectScoringSources>["sources"][number];

function repositories(manifest: string): Repository[] {
    const data: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    if (!isJsonObject(data) || !Array.isArray(data.repositories)) throw new Error("Manifest requires repositories");
    return data.repositories.map(row => {
        if (!isJsonObject(row) || typeof row.name !== "string" || typeof row.path !== "string"
            || typeof row.commit !== "string" || !/^[a-f0-9]{40}$/.test(row.commit)) throw new Error("Invalid repository pin");
        return { name: row.name, path: resolve(dirname(manifest), row.path), commit: row.commit };
    });
}

function git(root: string, args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 15_000 }).trim();
}

function requirePinned(repo: Repository): void {
    if (git(repo.path, ["rev-parse", "HEAD"]) !== repo.commit) throw new Error(`${repo.name}: HEAD changed`);
    if (git(repo.path, ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all"])) {
        throw new Error(`${repo.name}: corpus checkout is dirty`);
    }
}

function compareSource(source: Source): Difference[] | null {
    if (!/\.[cm]?[jt]sx?$/i.test(source.file)) return null;
    const before = computeLegacyFunctionTokens(source.content, source.file);
    const after = computeTypeScriptFunctionTokens(source.content, source.file);
    if (!before || !after) return null;
    if (before.length !== after.length) throw new Error(`${source.file}: implementation population changed`);
    return after.map((entry, index) => {
        const old = before[index];
        if (!old || old.startOffset !== entry.startOffset || old.endOffset !== entry.endOffset
            || old.qualifiedName !== entry.qualifiedName) throw new Error(`${source.file}: function identity/span changed`);
        return { file: source.file, sha256: source.sha256, name: entry.qualifiedName, line: entry.line,
            old: old.canonicalTokens, current: entry.canonicalTokens };
    });
}

function measure(repo: Repository, pinned: boolean) {
    if (pinned) requirePinned(repo);
    const census = collectScoringSources(repo.path);
    const all: Difference[] = [];
    const unmeasured: Array<{ file: string; reason: string }> = [...census.notMeasured];
    let files = 0;
    for (const source of census.sources) {
        const rows = compareSource(source);
        if (rows === null) unmeasured.push({ file: source.file, reason: "JS/TS comparison unavailable: unsupported language or parser recovery" });
        else { files++; all.push(...rows); }
    }
    if (pinned) requirePinned(repo);
    const differences = all.filter(row => row.old !== row.current);
    return { name: repo.name, commit: repo.commit, pinned, files, functions: all.length,
        oldOverCap: all.filter(row => row.old > 500).length,
        currentOverCap: all.filter(row => row.current > 500).length,
        newlyOverCap: differences.filter(row => row.old <= 500 && row.current > 500).length,
        noLongerOverCap: differences.filter(row => row.old > 500 && row.current <= 500).length,
        changedFunctions: differences.length,
        sourceHash: createHash("sha256").update(JSON.stringify(census.sources.map(row => [row.file, row.sha256]))).digest("hex"),
        unmeasured, discoveryIssues: census.discoveryIssues, differences };
}

const opts = new Command().requiredOption("--manifest <path>").requiredOption("--out <file>")
    .option("--working-tree <path>", "Also measure an explicitly unpinned working tree")
    .parse().opts<{ manifest: string; out: string; workingTree?: string }>();
const rows = [];
for (const repo of repositories(resolve(opts.manifest))) {
    process.stderr.write(`Comparing ${repo.name}\n`);
    rows.push(measure(repo, true));
}
if (opts.workingTree) {
    const path = resolve(opts.workingTree);
    rows.push(measure({ name: "interlinked-cli working tree", path, commit: git(path, ["rev-parse", "HEAD"]) }, false));
}
const output = resolve(opts.out);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ schemaVersion: 1, modelCalls: 0, repositoryCodeExecuted: false,
    legacy: "interlinked-code-v1", measurement: functionTokenProvenance(["typescript"]), repositories: rows }, null, 2) + "\n");
process.stdout.write(JSON.stringify(rows.map(({ differences: _differences, ...row }) => row), null, 2) + "\n");
