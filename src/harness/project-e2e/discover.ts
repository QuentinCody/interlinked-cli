// ===========================================
// Discovery — read-only inspection that PROPOSES configuration
// ===========================================
// Plan 31 §5.1 and §16 Unit B. Scans manifests, runner configs, test layouts
// and existing contract declarations under bounded limits, then emits a
// reviewable proposal: advisory projects, argv build steps, artifact globs,
// candidate scenarios for EXISTING contract cases, and explicit gaps for
// everything it cannot decide. It never executes a project script, never
// enables required mode and never invents an expectation (decisions 1, 15).

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { matchesGlob } from "../../lib/path-glob.js";
import { CONTRACT_MANIFEST } from "../contracts/paths.js";
import { parseContractManifest } from "../contracts/schema.js";
import type { ContractCase } from "../contracts/types.js";
import { parseE2ePolicy, type E2eArgvStep, type E2ePolicy, type E2eProject, type E2eScenario } from "./policy.js";

export interface DiscoveredExecutable { id: string; kind: "package-bin" | "cargo-bin" | "python-script" | "python-entry"; argv: string[]; source: string; }
/** `inputs` are the build's own script files (bound as shared inputs so editing them invalidates receipts); `artifacts` are its inferred outputs. */
/** An inferred output glob that covers an EXISTING declared contract input with no file-level write evidence (D1): NOT proposed, so the input stays tracked. */
export interface ArtifactConflict { glob: string; inputs: string[]; }
export interface DiscoveredBuild { prepare: E2eArgvStep[]; artifacts: string[]; inputs: string[]; /** Command words that look like scripts/variables but resolve to no file (C1): a freshness gap until declared. */ unresolved: string[]; conflicts: ArtifactConflict[]; source: string; }
export interface DiscoveredProject {
    id: string; root: string; languages: string[]; manifests: string[]; build: DiscoveredBuild | null;
    tests: { layouts: string[]; runners: string[] }; executables: DiscoveredExecutable[];
    contracts: { manifest: string | null; cases: string[]; /** Every input path and path-shaped argv token the cases name. */ paths: string[]; invalid?: string }; proposal: E2eProject; gaps: string[];
}
export interface DiscoveryLimits { directoriesScanned: number; capped: boolean; /** Directories at the depth bound that were NOT descended (project-relative). */ omittedSubtrees: string[]; }
export interface DiscoveryReport {
    version: 1; root: string; scannedAt: string; projects: DiscoveredProject[]; ambiguities: string[]; gaps: string[];
    limits: DiscoveryLimits; proposal: E2ePolicy;
}
export interface PythonEntryPoint { name: string; module: string; callable: string | null; }

const MANIFESTS = ["package.json", "pyproject.toml", "setup.py", "requirements.txt", "Cargo.toml", "go.mod"] as const;
/** Pseudo-manifest for a bare Python script directory (a `__main__`-guarded .py with no packaging file): still a runnable project. */
const PYTHON_SCRIPTS = "*.py";
const PYTHON_MANIFESTS = ["pyproject.toml", "setup.py", "requirements.txt", PYTHON_SCRIPTS];
const TEST_LAYOUTS = ["test", "tests", "__tests__", "spec", "e2e"];
const SKIPPED = new Set([".git", "node_modules", ".interlinked", "target", "__pycache__", ".venv", "venv", "dist", "build", ".next", "coverage"]);
const MAX_DEPTH = 4;
const MAX_DIRECTORIES = 2000;
const MAX_OMITTED_RECORDED = 100;
const OUTPUT_DIRS = ["dist", "build", "out", "lib", "target", "bin"];
const SOURCE_SUFFIXES = [".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".py", ".rs", ".go"];
const MAX_TEXT_BYTES = 256 * 1024;
const NATIVE_RUNNERS = new Set(["vitest", "pytest", "unittest", "cargo-test", "go-test"]);
const KNOWN_JS_RUNNERS = ["vitest", "jest", "mocha", "ava", "tap", "playwright", "cypress"];
const SHARED_CANDIDATES = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json", "pyproject.toml", "requirements.txt", "setup.py", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum"];

interface Candidate { dir: string; manifests: string[]; }
interface Scan { candidates: Candidate[]; directoriesScanned: number; capped: boolean; omitted: string[]; }

function readText(path: string): string | null {
    try { if (statSync(path).size > MAX_TEXT_BYTES) return null; return readFileSync(path, "utf8"); } catch { return null; }
}
function readJson(path: string): Record<string, unknown> | null {
    const text = readText(path);
    if (text === null) return null;
    try { const value: unknown = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null; } catch { return null; } // SAFETY: guarded object
}
/** Real manifests first; a directory with only `__main__`-guarded .py scripts counts through the `*.py` pseudo-manifest. */
function manifestsIn(dir: string, entries: Dirent[]): string[] {
    const manifests: string[] = MANIFESTS.filter(name => entries.some(entry => entry.name === name && entry.isFile()));
    if (manifests.length) return manifests;
    if (TEST_LAYOUTS.includes(basename(dir))) return []; // a test directory's __main__-guarded runner is not a project
    const script = entries.some(entry => entry.isFile() && entry.name.endsWith(".py") && hasMainGuard(join(dir, entry.name)));
    return script ? [PYTHON_SCRIPTS] : [];
}
function descendable(entries: Dirent[]): Dirent[] {
    return entries.filter(entry => entry.isDirectory() && !SKIPPED.has(entry.name) && !entry.name.startsWith("."));
}
/** A directory at the depth bound is NOT descended; every child it would have visited is recorded as an omission (B6). */
function recordOmitted(scan: Scan, root: string, dir: string, entries: Dirent[]): void {
    for (const entry of descendable(entries)) {
        if (scan.omitted.length < MAX_OMITTED_RECORDED) scan.omitted.push(relative(root, join(dir, entry.name)).replaceAll("\\", "/"));
    }
}
function scanManifests(root: string): Scan {
    const scan: Scan = { candidates: [], directoriesScanned: 0, capped: false, omitted: [] };
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (stack.length) {
        const { dir, depth } = stack.pop()!;
        if (scan.directoriesScanned >= MAX_DIRECTORIES) { scan.capped = true; break; }
        scan.directoriesScanned += 1;
        const entries = readdirSync(dir, { withFileTypes: true });
        const manifests = manifestsIn(dir, entries);
        if (manifests.length) scan.candidates.push({ dir, manifests });
        if (depth >= MAX_DEPTH) { recordOmitted(scan, root, dir, entries); continue; }
        for (const entry of descendable(entries)) stack.push({ dir: join(dir, entry.name), depth: depth + 1 });
    }
    scan.candidates.sort((a, b) => a.dir.localeCompare(b.dir));
    scan.omitted.sort();
    return scan;
}
function workspaceGlobs(pkg: Record<string, unknown> | null): string[] {
    const raw = pkg?.workspaces;
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === "object" && Array.isArray((raw as { packages?: unknown }).packages) ? (raw as { packages: unknown[] }).packages : []);
    return list.filter((item): item is string => typeof item === "string");
}
function declaredWorkspace(parentDir: string, childDir: string): boolean {
    const globs = workspaceGlobs(readJson(join(parentDir, "package.json")));
    const rel = relative(parentDir, childDir).replaceAll("\\", "/");
    return globs.some(glob => glob === rel || (glob.endsWith("/*") && rel.startsWith(glob.slice(0, -1)) && !rel.slice(glob.length - 1).includes("/")) || (glob.endsWith("/**") && rel.startsWith(glob.slice(0, -2))));
}
function ambiguities(root: string, candidates: Candidate[]): string[] {
    const notes: string[] = [];
    for (const child of candidates) {
        if (!child.manifests.includes("package.json")) continue;
        const parent = candidates.find(row => row.dir !== child.dir && child.dir.startsWith(`${row.dir}/`) && row.manifests.includes("package.json"));
        if (parent && !declaredWorkspace(parent.dir, child.dir)) notes.push(`${relative(root, join(child.dir, "package.json"))} is nested under ${relative(root, join(parent.dir, "package.json")) || "package.json"} without a declared workspace; select the project root explicitly`);
    }
    return notes;
}
function hasMainGuard(path: string): boolean {
    return /__name__\s*==\s*["']__main__["']/.test(readText(path) ?? "");
}
function languagesOf(dir: string, manifests: string[]): string[] {
    const languages: string[] = [];
    if (manifests.includes("package.json")) languages.push(existsSync(join(dir, "tsconfig.json")) || hasFiles(join(dir, "src"), ".ts") ? "typescript" : "javascript");
    if (manifests.some(name => PYTHON_MANIFESTS.includes(name))) languages.push("python");
    if (manifests.includes("Cargo.toml")) languages.push("rust");
    if (manifests.includes("go.mod")) languages.push("go");
    return languages;
}
function hasFiles(dir: string, suffix: string): boolean {
    try { return readdirSync(dir).some(name => name.endsWith(suffix)); } catch { return false; }
}
interface WordState { words: string[]; current: string; quote: '"' | "'" | null; pending: boolean; }
function flushWord(state: WordState): void {
    if (state.pending) state.words.push(state.current);
    state.current = ""; state.pending = false;
}
/** One character inside a quoted region; returns the index consumed through. */
function quotedChar(state: WordState, command: string, index: number): number {
    const char = command[index]!;
    if (char === state.quote) { state.quote = null; return index; }
    if (char === "\\" && state.quote === '"' && index + 1 < command.length) { state.current += command[index + 1]; return index + 1; }
    state.current += char;
    return index;
}
function consumeChar(state: WordState, command: string, index: number): number {
    const char = command[index]!;
    if (state.quote) return quotedChar(state, command, index);
    if (char === "'" || char === '"') { state.quote = char; state.pending = true; return index; }
    if (char === "\\" && index + 1 < command.length) { state.current += command[index + 1]; state.pending = true; return index + 1; }
    if (/[\s;&|()]/.test(char)) { flushWord(state); return index; }
    state.current += char; state.pending = true;
    return index;
}
/** POSIX-style word split with single/double quotes and backslash escapes (no expansion); operators split words like whitespace (C1). */
function shellWords(command: string): string[] {
    const state: WordState = { words: [], current: "", quote: null, pending: false };
    for (let index = 0; index < command.length; index += 1) index = consumeChar(state, command, index);
    flushWord(state);
    return state.words;
}
/** Words a build command names as script FILES: resolved ones are inputs; path-shaped or variable words that do not resolve are unresolved. */
function scriptWordsOf(dir: string, command: string): { inputs: string[]; unresolved: string[] } {
    return scriptWordsFrom(dir, shellWords(command));
}
function scriptWordsFrom(dir: string, words: readonly string[]): { inputs: string[]; unresolved: string[] } {
    const inputs: string[] = [], unresolved: string[] = [];
    for (const word of words) {
        if (word.startsWith("-")) continue;
        if (word.includes("$") || word.includes("`")) { unresolved.push(word); continue; }
        if (!/\.[A-Za-z]+$/.test(word) && !word.includes("/")) continue;
        if (isLocalFile(dir, word)) inputs.push(word); else unresolved.push(word);
    }
    return { inputs, unresolved };
}
const WRITE_EVIDENCE = ["mkdir", "mkdirSync", "writeFile", "writeFileSync", "createWriteStream", "rm", "rmSync", "emptyDir", "emptyDirSync", "outDir", "outdir", "out-dir", "outfile", "outFile", "--out", "-o"];
/** Directories with OUTPUT evidence only (C2): named as a write/output-option argument in the command or script — a directory merely READ is never an artifact. */
function writtenOutputDirs(text: string): Set<string> {
    const named = new Set<string>();
    const sites = WRITE_EVIDENCE.map(api => api.replaceAll("-", "\\-")).join("|");
    for (const name of OUTPUT_DIRS) if (new RegExp(`(?:${sites})[=\\s(]{1,3}["'\`]?${name}(?:/|["'\`\\s]|$)`).test(text)) named.add(name);
    return named;
}
/** Output directories: write evidence in the command/script files, plus contract paths that do not exist yet (they must be produced by prepare). */
function outputDirs(dir: string, command: string, scriptFiles: string[], contractPaths: string[]): string[] {
    const named = writtenOutputDirs([command, ...scriptFiles.map(file => readText(join(dir, file)) ?? "")].join("\n"));
    for (const path of contractPaths) {
        const top = path.split("/")[0]!;
        if (path.includes("/") && !existsSync(join(dir, path)) && (OUTPUT_DIRS.includes(top) || !existsSync(join(dir, top)))) named.add(top);
    }
    return [...named].sort().map(name => `${name}/**`);
}
/** Writers whose FIRST argument is the destination. */
const FIRST_ARG_WRITERS = ["writeFile", "writeFileSync", "createWriteStream", "appendFile", "appendFileSync"];
/** Writers whose SECOND argument is the destination (the first is a SOURCE — naming it proves nothing about it being generated, E1). */
const SECOND_ARG_WRITERS = ["copyFile", "copyFileSync", "cpSync", "cp", "rename", "renameSync"];
/** Option-style output targets (`outfile: "x"`, `--out x`). */
const OUTPUT_OPTIONS = ["outfile", "outFile", "--out", "--outfile", "-o"];
/** The literal must be the COMPLETE argument: closing quote, then `,` or `)` (an expression such as `"x" + ".bak"` is not the path). */
const QUOTED = `["'\`](?:\\./)?PATH["'\`]\\s*[,)]`;
const ANY_QUOTED = `["'\`][^"'\`\\n]*["'\`]`;
/** Source text with `//`, `#` line comments and block comments removed, so a commented-out writer is not read as executable. */
function withoutComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1").replace(/^\s*#[^\n]*/gm, "");
}
/**
 * True when executable script text names this exact path as a COMPLETE literal in a DESTINATION position. This is a static
 * SIGN that the build writes the file — enough to propose an artifact glob and to accept one at adoption — never proof that
 * preparation regenerated it, which is why freshness (generation.ts) does not depend on it.
 */
function writesExactPath(text: string, path: string): boolean {
    const code = withoutComments(text);
    const target = QUOTED.replace("PATH", path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
    const first = new RegExp(`(?:${FIRST_ARG_WRITERS.join("|")})\\s*\\(\\s*${target}`);
    const second = new RegExp(`(?:${SECOND_ARG_WRITERS.join("|")})\\s*\\(\\s*${ANY_QUOTED}\\s*,\\s*${target}`);
    const option = new RegExp(`(?:${OUTPUT_OPTIONS.map(name => name.replaceAll("-", "\\-")).join("|")})\\s*[:=\\s]\\s*["'\`]?(?:\\./)?${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["'\`]?(?:\\s|,|\\)|$)`);
    return first.test(code) || second.test(code) || option.test(code);
}
/** D1: an inferred output glob covering an existing declared input that the script does not provably write is dropped, so the input keeps its freshness check. */
function resolveArtifactConflicts(dir: string, text: string, candidates: string[], contractPaths: string[]): { artifacts: string[]; conflicts: ArtifactConflict[] } {
    const artifacts: string[] = [], conflicts: ArtifactConflict[] = [];
    for (const glob of candidates) {
        const covered = contractPaths.filter(path => matchesGlob(path, glob) && existsSync(join(dir, path)) && !writesExactPath(text, path));
        if (covered.length) conflicts.push({ glob, inputs: covered }); else artifacts.push(glob);
    }
    return { artifacts, conflicts };
}
/** The package.json script an `npm run <name>` / `pnpm run <name>` / `yarn <name>` step aliases, or null when the step is a direct command. */
function packageScriptFor(dir: string, argv: readonly string[]): string | null {
    const [tool, verb, name] = argv;
    const alias = (tool === "npm" || tool === "pnpm" || tool === "bun") && verb === "run" ? name : tool === "yarn" ? verb : undefined;
    if (!alias) return null;
    const scripts = readJson(join(dir, "package.json"))?.scripts;
    const command = scripts && typeof scripts === "object" ? (scripts as Record<string, unknown>)[alias] : undefined;
    return typeof command === "string" ? command : null;
}
/** Evidence text for the SUITE'S declared prepare steps (E2): each step's words plus the script files they name; an npm alias resolves one level into package.json. */
export function prepareEvidenceText(dir: string, steps: readonly E2eArgvStep[]): string {
    const chunks: string[] = [];
    for (const step of steps) {
        const aliased = packageScriptFor(dir, step.argv);
        const words = aliased === null ? step.argv : shellWords(aliased);
        chunks.push(words.join(" "), ...scriptWordsFrom(dir, words).inputs.map(file => readText(join(dir, file)) ?? ""));
    }
    return chunks.join("\n");
}
/** Artifact globs that would strip an EXISTING declared input of its freshness check with no proof the declared preparation writes it (D1/E2) — the check adoption re-runs on any policy. */
export function artifactConflictsOf(dir: string, artifacts: readonly string[], contractPaths: readonly string[], prepare: readonly E2eArgvStep[]): ArtifactConflict[] {
    return resolveArtifactConflicts(dir, prepareEvidenceText(dir, prepare), [...artifacts], [...contractPaths]).conflicts;
}
function buildOf(dir: string, manifests: string[], pkg: Record<string, unknown> | null, contractPaths: string[]): DiscoveredBuild | null {
    const scripts = pkg?.scripts;
    const buildScript = scripts && typeof scripts === "object" ? (scripts as Record<string, unknown>).build : undefined;
    if (typeof buildScript === "string") {
        const { inputs, unresolved } = scriptWordsOf(dir, buildScript);
        const prepare: E2eArgvStep[] = [{ argv: ["npm", "run", "build"] }];
        const { artifacts, conflicts } = resolveArtifactConflicts(dir, prepareEvidenceText(dir, prepare), outputDirs(dir, buildScript, inputs, contractPaths), contractPaths);
        return { prepare, artifacts, inputs, unresolved, conflicts, source: `package.json scripts.build: ${buildScript}` };
    }
    if (manifests.includes("Cargo.toml")) return { prepare: [{ argv: ["cargo", "build", "--release"] }], artifacts: ["target/**"], inputs: [], unresolved: [], conflicts: [], source: "Cargo.toml" };
    if (manifests.includes("go.mod")) return { prepare: [{ argv: ["go", "build", "./..."] }], artifacts: outputDirs(dir, "", [], contractPaths), inputs: [], unresolved: [], conflicts: [], source: "go.mod" };
    return null;
}
function testsOf(dir: string, manifests: string[], pkg: Record<string, unknown> | null): { layouts: string[]; runners: string[] } {
    const layouts = TEST_LAYOUTS.filter(name => existsSync(join(dir, name)) && statSync(join(dir, name)).isDirectory());
    const runners: string[] = [];
    const deps = { ...(pkg?.dependencies as Record<string, unknown> | undefined ?? {}), ...(pkg?.devDependencies as Record<string, unknown> | undefined ?? {}) };
    for (const runner of KNOWN_JS_RUNNERS) if (runner in deps) runners.push(runner);
    const pythonText = ["pyproject.toml", "requirements.txt", "setup.py"].map(name => readText(join(dir, name)) ?? "").join("\n");
    if (/\bpytest\b/.test(pythonText)) runners.push("pytest");
    else if (manifests.some(name => PYTHON_MANIFESTS.includes(name)) && layouts.some(name => hasFiles(join(dir, name), ".py"))) runners.push("unittest");
    if (manifests.includes("Cargo.toml")) runners.push("cargo-test");
    if (manifests.includes("go.mod")) runners.push("go-test");
    return { layouts, runners };
}
function packageBins(dir: string, pkg: Record<string, unknown> | null): DiscoveredExecutable[] {
    const bin = pkg?.bin;
    if (typeof bin === "string") return [{ id: String(pkg?.name ?? basename(dir)).replace(/^@[^/]+\//, ""), kind: "package-bin", argv: ["node", bin], source: "package.json bin" }];
    if (!bin || typeof bin !== "object") return [];
    return Object.entries(bin).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([name, path]) => ({ id: name, kind: "package-bin", argv: ["node", path], source: "package.json bin" }));
}
function cargoBins(dir: string): DiscoveredExecutable[] {
    const text = readText(join(dir, "Cargo.toml"));
    if (text === null) return [];
    const names = [...text.matchAll(/^\s*name\s*=\s*"([^"]+)"/gm)].map(match => match[1]!);
    const hasMain = existsSync(join(dir, "src/main.rs"));
    return names.slice(0, hasMain ? 1 : 0).map(name => ({ id: name, kind: "cargo-bin", argv: [`./target/release/${name}`], source: "Cargo.toml [package].name + src/main.rs" }));
}
/** `[project.scripts]` entries of pyproject.toml: `name = "module:callable"` (callable null for a bare module). */
export function pythonEntryPoints(dir: string): PythonEntryPoint[] {
    const pyproject = readText(join(dir, "pyproject.toml")) ?? "";
    const scripts = pyproject.split(/\[project\.scripts\]/)[1]?.split(/\n\[/)[0] ?? "";
    return [...scripts.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*"([A-Za-z0-9_.]+)(?::([A-Za-z0-9_.]+))?"/gm)].map(match => ({ name: match[1]!, module: match[2]!, callable: match[3] ?? null }));
}
/** The module's file (`pkg/mod.py` or `pkg/mod/__init__.py`) when it lives in this project; null means the entry cannot be invoked from the tree. */
function pythonModuleFile(dir: string, module: string): string | null {
    const base = module.replaceAll(".", "/");
    for (const candidate of [`${base}.py`, `${base}/__init__.py`]) if (existsSync(join(dir, candidate))) return candidate;
    return null;
}
function entryLabel(entry: PythonEntryPoint): string { return `${entry.name} = ${entry.module}${entry.callable ? `:${entry.callable}` : ""}`; }
/** A console entry is invoked as its declared CALLABLE, never substituted by `-m` (B5): running a module is not calling its entry point. */
function pythonEntryExecutable(dir: string, entry: PythonEntryPoint, gaps: string[]): DiscoveredExecutable | null {
    if (!pythonModuleFile(dir, entry.module)) { gaps.push(`console script ${entryLabel(entry)} names a module with no file in this project; declare its argv explicitly (an installed environment is required to run it)`); return null; }
    // `sys.exit(callable())` is exactly what an installed console script does (C3): None → 0, int → that status, str → printed to stderr, status 1.
    const argv = entry.callable ? ["python3", "-c", `import sys, ${entry.module} as _entry; sys.exit(_entry.${entry.callable}())`] : ["python3", "-m", entry.module];
    return { id: entry.name, kind: "python-entry", argv, source: `pyproject.toml [project.scripts] ${entryLabel(entry)} (callable invoked with console-script exit semantics; the installed console script needs pip install)` };
}
function pythonExecutables(dir: string, gaps: string[]): DiscoveredExecutable[] {
    const found: DiscoveredExecutable[] = [];
    for (const entry of pythonEntryPoints(dir)) { const executable = pythonEntryExecutable(dir, entry, gaps); if (executable) found.push(executable); }
    for (const name of readdirSync(dir).filter(name => name.endsWith(".py")).sort()) {
        if (hasMainGuard(join(dir, name))) found.push({ id: name, kind: "python-script", argv: ["python3", name], source: `${name} __main__ guard` });
    }
    return found;
}
/** Every declared input plus every path-shaped process argv token (the paths a case needs on disk). */
export function contractPaths(cases: readonly ContractCase[]): string[] {
    const paths = new Set<string>();
    for (const row of cases) {
        for (const input of row.inputs) paths.add(input);
        if (row.runner.kind !== "process") continue;
        for (const token of row.runner.argv) if (/^[A-Za-z0-9_./-]+\/[A-Za-z0-9_./-]+$/.test(token)) paths.add(token.replace(/^\.\//, ""));
    }
    return [...paths].sort();
}
function contractsOf(dir: string): DiscoveredProject["contracts"] {
    const path = join(dir, CONTRACT_MANIFEST);
    if (!existsSync(path)) return { manifest: null, cases: [], paths: [] };
    try {
        const cases = parseContractManifest(readFileSync(path, "utf8")).cases;
        return { manifest: CONTRACT_MANIFEST, cases: cases.map(row => row.id), paths: contractPaths(cases) };
    }
    catch (error) { return { manifest: CONTRACT_MANIFEST, cases: [], paths: [], invalid: error instanceof Error ? error.message : String(error) }; }
}
function isSourceFile(dir: string, name: string, excluded: readonly string[]): boolean {
    return SOURCE_SUFFIXES.some(suffix => name.endsWith(suffix)) && !excluded.includes(name) && !/\.config\.[a-z]+$/.test(name) && !name.endsWith(".d.ts") && statSync(join(dir, name)).isFile();
}
function isLocalFile(dir: string, local: string): boolean {
    return local.length > 0 && existsSync(join(dir, local)) && statSync(join(dir, local)).isFile();
}
/** The file tokens an executable's argv names: script paths, or the python module file behind `-m` / the `-c` import. */
function executableFiles(dir: string, executable: DiscoveredExecutable): string[] {
    if (executable.kind !== "python-entry") return executable.argv.slice(1).map(token => token.replace(/^\.\//, ""));
    const module = executable.argv[1] === "-m" ? executable.argv[2] ?? "" : /import sys, ([A-Za-z0-9_.]+) as _entry/.exec(executable.argv[2] ?? "")?.[1] ?? "";
    const file = pythonModuleFile(dir, module);
    return file ? [file] : [];
}
/** Executable argv tokens (and python modules) that resolve to files in the tree and are not build outputs. */
function executableSources(dir: string, executables: readonly DiscoveredExecutable[], artifacts: readonly string[]): string[] {
    const outputs = artifacts.map(glob => glob.replace(/\/\*\*$/, "/"));
    const found = new Set<string>();
    for (const executable of executables) {
        for (const local of executableFiles(dir, executable)) if (!outputs.some(prefix => local.startsWith(prefix)) && isLocalFile(dir, local)) found.add(local);
    }
    return [...found];
}
function isPythonPackageDir(dir: string, entry: Dirent): boolean {
    return entry.isDirectory() && !SKIPPED.has(entry.name) && !TEST_LAYOUTS.includes(entry.name) && existsSync(join(dir, entry.name, "__init__.py"));
}
/** Source scope derived from the ACTUAL layout (B1): `src/**`, python packages, top-level source files, executable files. Never a nonexistent default. */
function protectedScopeOf(dir: string, executables: readonly DiscoveredExecutable[], build: DiscoveredBuild | null): string[] {
    const scope = new Set<string>();
    const entries = readdirSync(dir, { withFileTypes: true });
    const excluded = build?.inputs ?? [];
    if (entries.some(entry => entry.name === "src" && entry.isDirectory())) scope.add("src/**");
    for (const entry of entries.filter(entry => isPythonPackageDir(dir, entry))) scope.add(`${entry.name}/**`);
    for (const entry of entries.filter(entry => entry.isFile() && isSourceFile(dir, entry.name, excluded))) scope.add(entry.name);
    for (const file of executableSources(dir, executables, build?.artifacts ?? []).filter(file => !excluded.includes(file))) scope.add(file);
    return [...scope].sort();
}
function scenariosOf(dir: string, contracts: DiscoveredProject["contracts"], affects: string[], gaps: string[]): E2eScenario[] {
    if (!contracts.manifest || contracts.invalid) return [];
    const manifest = parseContractManifest(readFileSync(join(dir, contracts.manifest), "utf8"));
    const scenarios: E2eScenario[] = [];
    for (const row of manifest.cases) {
        if (row.runner.kind !== "process") { gaps.push(`contract case ${row.id} uses an ${row.runner.kind} runner; unsupported until a managed service adapter ships, so no scenario is proposed for it`); continue; }
        scenarios.push({ id: row.id, suite: "cli", description: row.description, affects: [...affects], contractIds: [row.id], required: false, boundary: { entry: "process", real: ["application"] } });
    }
    return scenarios;
}
function idFor(dir: string, root: string, pkg: Record<string, unknown> | null, taken: Set<string>): string {
    // A nested project is named by its directory (stable across package renames and what a monorepo reader recognizes); the root's directory name is arbitrary, so its manifest name wins there.
    const named = dir === root && typeof pkg?.name === "string" ? pkg.name.replace(/^@[^/]+\//, "") : basename(dir);
    const base = named.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 100) || "project";
    let id = base, suffix = 2;
    while (taken.has(id)) { id = `${base}-${suffix}`; suffix += 1; }
    taken.add(id);
    return id;
}
/** A build whose outputs cannot be inferred, or contract/executable paths under no artifact and absent from the tree, is an unresolved mapping (B2). */
function buildGaps(dir: string, found: Omit<DiscoveredProject, "proposal" | "gaps">): string[] {
    const gaps: string[] = [];
    const build = found.build;
    const artifactDirs = (build?.artifacts ?? []).map(glob => glob.replace(/\/\*\*$/, "/"));
    const absent = [...found.contracts.paths, ...found.executables.flatMap(row => row.argv.slice(1).filter(token => token.includes("/")))]
        .map(path => path.replace(/^\.\//, "")).filter(path => !existsSync(join(dir, path)) && !artifactDirs.some(prefix => path.startsWith(prefix)));
    if (build && !build.artifacts.length) gaps.push(`build outputs for ${found.id} could not be inferred from "${build.source}"; declare suites[].artifacts (the globs prepare produces) before adopting required mode`);
    if (absent.length) gaps.push(`these contract/executable paths are absent and no build artifact covers them: ${[...new Set(absent)].join(", ")}; declare suites[].artifacts or fix the paths`);
    if (build?.unresolved.length) gaps.push(`build input(s) ${build.unresolved.join(", ")} in "${build.source}" resolve to no file in the project; editing the real script would not invalidate receipts — declare it in sharedInputs`);
    for (const conflict of build?.conflicts ?? []) gaps.push(`${conflict.inputs.join(", ")} exist(s) and is a declared input, yet ${conflict.glob} looked like build output; the glob is NOT proposed and the input is kept in freshness tracking — if it really is generated, declare ${conflict.glob} in suites[].artifacts yourself`);
    return gaps;
}
function gapsFor(found: Omit<DiscoveredProject, "proposal" | "gaps">, languages: string[], dir: string): string[] {
    const gaps: string[] = buildGaps(dir, found);
    if (found.contracts.invalid) gaps.push(`existing ${found.contracts.manifest} is invalid: ${found.contracts.invalid}`);
    if (!found.contracts.cases.length) {
        const executables = found.executables.map(row => row.argv.join(" ")).join(", ") || "none found";
        gaps.push(`no contract cases declared for ${found.id}; executables found: ${executables}. Write cases with \`interlinked tests contracts import <doc>\` or author ${CONTRACT_MANIFEST}, then re-run discover`);
    }
    for (const runner of found.tests.runners) if (!NATIVE_RUNNERS.has(runner)) gaps.push(`test runner "${runner}" has no native integration; declare a structured-runner suite (run argv + a JSON-protocol or JUnit report, scenario caseIds) alongside portable contracts — no plugin is needed`);
    if (!found.tests.layouts.length) gaps.push(`No test layout was detected for ${found.id}; run \`interlinked tests readiness ${languages[0] ?? "typescript"} --json\``);
    return gaps;
}
function discoverProject(root: string, candidate: Candidate, taken: Set<string>): DiscoveredProject {
    const dir = candidate.dir, pkg = candidate.manifests.includes("package.json") ? readJson(join(dir, "package.json")) : null;
    const languages = languagesOf(dir, candidate.manifests);
    const id = idFor(dir, root, pkg, taken);
    const relRoot = dir === root ? "." : relative(root, dir).replaceAll("\\", "/");
    const contracts = contractsOf(dir);
    const build = buildOf(dir, candidate.manifests, pkg, contracts.paths);
    const entryGaps: string[] = [];
    const found: Omit<DiscoveredProject, "proposal" | "gaps"> = {
        id, root: relRoot, languages, manifests: candidate.manifests, build, tests: testsOf(dir, candidate.manifests, pkg),
        executables: [...packageBins(dir, pkg), ...cargoBins(dir), ...(languages.includes("python") ? pythonExecutables(dir, entryGaps) : [])], contracts,
    };
    const gaps = [...entryGaps, ...gapsFor(found, languages, dir)];
    const protectedInputs = protectedScopeOf(dir, found.executables, build);
    if (!protectedInputs.length) gaps.push(`no source scope could be inferred for ${id} (no src/, package directory, executable file or top-level source file); declare protectedInputs explicitly before adopting`);
    const suite = { id: "cli", adapter: "managed-contracts" as const, ...(build ? { prepare: build.prepare, artifacts: build.artifacts } : {}) };
    const proposal: E2eProject = {
        id, root: relRoot, protectedInputs, sharedInputs: [...SHARED_CANDIDATES.filter(name => existsSync(join(dir, name))), ...(build?.inputs ?? [])], mode: "advisory", gates: { stop: "warn" },
        suites: [suite], scenarios: scenariosOf(dir, contracts, protectedInputs, gaps),
    };
    return { ...found, proposal, gaps };
}
function validated(projects: E2eProject[], gaps: string[]): E2ePolicy {
    const policy: E2ePolicy = { version: 1, projects: projects.length ? projects : [], expectations: [] };
    if (!projects.length) return policy;
    try { parseE2ePolicy(JSON.stringify(policy)); }
    catch (error) { gaps.push(`proposal does not validate as a policy: ${error instanceof Error ? error.message : String(error)}`); }
    return policy;
}
/** Read-only. Proposes; never adopts, never runs scripts, never accepts inferred expectations. */
export function discoverProjects(root: string): DiscoveryReport {
    const scan = scanManifests(root);
    const taken = new Set<string>();
    const projects = scan.candidates.map(candidate => discoverProject(root, candidate, taken));
    const gaps: string[] = [];
    if (!projects.length) gaps.push(`no project manifest (${MANIFESTS.join(", ")}) found under ${root} within ${MAX_DEPTH} levels; declare the project explicitly in .interlinked/e2e-policy.json`);
    if (scan.capped) gaps.push(`scan stopped after ${MAX_DIRECTORIES} directories; nested projects beyond that point were not inspected`);
    if (scan.omitted.length) gaps.push(`depth bound (${MAX_DEPTH} levels) reached: ${scan.omitted.slice(0, 8).join(", ")}${scan.omitted.length > 8 ? ` and ${scan.omitted.length - 8} more` : ""} not inspected (${scan.omitted.length} subtree(s)); select or declare a project root there explicitly`);
    const proposal = validated(projects.map(row => row.proposal), gaps);
    return { version: 1, root, scannedAt: new Date().toISOString(), projects, ambiguities: ambiguities(root, scan.candidates), gaps, limits: { directoriesScanned: scan.directoriesScanned, capped: scan.capped, omittedSubtrees: scan.omitted }, proposal };
}
function projectLines(found: DiscoveredProject): string[] {
    return [
        `${found.id} (${found.root}): ${found.languages.join(", ") || "unknown language"}; manifests ${found.manifests.join(", ")}`,
        `  build: ${found.build ? `${found.build.prepare.map(step => step.argv.join(" ")).join("; ")} → artifacts ${found.build.artifacts.join(", ") || "none"} (${found.build.source})` : "none (interpreted or undeclared)"}`,
        `  tests: layouts ${found.tests.layouts.join(", ") || "none"}; runners ${found.tests.runners.join(", ") || "none"}`,
        `  executables: ${found.executables.map(row => `${row.id} = ${row.argv.join(" ")}`).join("; ") || "none"}`,
        `  contracts: ${found.contracts.manifest ? `${found.contracts.cases.length} case(s)` : "no manifest"}; proposed scenarios ${found.proposal.scenarios.map(row => row.id).join(", ") || "none"} (advisory)`,
        ...found.gaps.map(gap => `  gap: ${gap}`),
    ];
}
export function formatDiscovery(report: DiscoveryReport): string[] {
    const lines = report.projects.flatMap(projectLines);
    lines.push(...report.ambiguities.map(note => `ambiguity: ${note}`), ...report.gaps.map(gap => `gap: ${gap}`));
    const omitted = report.limits.omittedSubtrees.length ? `; ${report.limits.omittedSubtrees.length} subtree(s) omitted at the depth bound` : "";
    lines.push(`scanned ${report.limits.directoriesScanned} director${report.limits.directoriesScanned === 1 ? "y" : "ies"}${report.limits.capped ? " (capped)" : ""}${omitted}; nothing was executed or written. Adopt with: interlinked tests e2e adopt --from <report.json> [--project <id>] [--scenario <id>] [--mode required]`);
    return lines;
}
