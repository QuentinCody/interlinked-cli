import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { analyzeSyntax, type ImportReference } from "../lib/metrics/analysis-syntax.js";
import { hashBytes } from "../lib/metrics/inventory.js";
import { isJsonObject } from "../lib/json-types.js";
import { parseTsSource } from "./checks/cyclomatic-ast.js";
import { hasExactSyntax } from "./function-tokens/ast-tokens.js";
import { runtimeOpacity } from "./test-dependency-graph.js";

/**
 * Content identity of one verification check: the digest of everything that decides its verdict.
 * Two checks with the same identity may share a result; a receipt is keyed by it.
 *
 * Dimensions (each one alone separates identities — see check-identity.test.ts):
 * - inputs: the plan snapshot (repository inventory, test universe, declared deps, changed paths) and the runtime hash
 * - command: the logical argv the runner executes (mode, workers, coverage flags)
 * - toolchain: node plus the installed vitest and typescript versions
 * - environmentHash: the captured process environment
 * - platform: os / arch / kernel release
 * - policy: the digest of the water-line files that turn measurements into a verdict
 */
export const CHECK_IDENTITY_VERSION = "check-identity-v4";

export interface ToolchainIdentity { node: string; vitest: string | null; typescript: string | null; }
export interface CheckIdentityInput {
    inputs: { snapshot: string; runtimeHash: string };
    command: readonly string[];
    toolchain: ToolchainIdentity;
    environmentHash: string;
    platform: string;
    policy: string;
}

export function checkIdentity(input: CheckIdentityInput): string {
    return hashBytes(JSON.stringify([CHECK_IDENTITY_VERSION, input.inputs.snapshot, input.inputs.runtimeHash, [...input.command], input.toolchain, input.environmentHash, input.platform, input.policy]));
}

/**
 * Environment variables excluded from the identity because they are PROVEN not to reach a verdict: the shell's
 * working-directory bookkeeping, the variables git sets only for the hook process (measured 2026-09-28: a hook
 * differs from a terminal in `GIT_EXEC_PATH`, `GIT_PREFIX`, `GIT_CONFIG_PARAMETERS`, `PWD`, `SHLVL`), and the
 * variables this route sets ITSELF to carry its own bookkeeping to the child (stage, ledger path, outcome
 * record, lease ancestry, scope file, test capacity scope). Everything else stays in the hash — `PATH` and
 * toolchain paths (they choose binaries), `CI`, `NODE_ENV`, `NODE_OPTIONS`, `HOME`, `LANG`, `TZ`, `TMPDIR`,
 * and every other `INTERLINKED_*` or user variable, because a test may read any of them. The child process
 * still receives the exact environment; the shared-completion path keeps the exact hash.
 */
const IDENTITY_ENVIRONMENT_EXCLUDED = new Set([
    "PWD", "OLDPWD", "SHLVL", "_",
    "GIT_EXEC_PATH", "GIT_PREFIX", "GIT_CONFIG_PARAMETERS",
    "INTERLINKED_STAGE", "INTERLINKED_STAGES_LEDGER", "INTERLINKED_BOUNDED_OUTCOME", "INTERLINKED_LEASE_ANCESTORS",
    "INTERLINKED_COVERAGE_SCOPE_FILE", "INTERLINKED_TEST_CAPACITY_SCOPE",
]);

function identityEnvironmentEntry([key]: [string, string]): boolean {
    return !IDENTITY_ENVIRONMENT_EXCLUDED.has(key);
}

/** Digest of the verdict-relevant environment: the exact environment minus the session and orchestration variables above. */
export function identityEnvironmentHash(environment: NodeJS.ProcessEnv): string {
    const entries = Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined).filter(identityEnvironmentEntry)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return hashBytes(JSON.stringify(["identity-environment-v1", process.execArgv, entries]));
}

function installedVersion(root: string, name: string): string | null {
    try {
        const manifest: unknown = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));
        return isJsonObject(manifest) && typeof manifest.version === "string" ? manifest.version : null;
    } catch {
        return null;
    }
}

/** Node plus the installed test toolchain; an absent package is null, never a guess. */
export function toolchainIdentity(root: string): ToolchainIdentity {
    return { node: process.versions.node, vitest: installedVersion(root, "vitest"), typescript: installedVersion(root, "typescript") };
}

/** Water-lines that decide a verdict: coverage and cap baselines plus every vitest config at the root. */
const POLICY_FILES = [".interlinked/coverage-baseline.json", ".interlinked/coverage-edit-baseline.json", ".interlinked/metric-caps.json"];

function policyPaths(root: string): string[] {
    const configs = existsSync(root) ? readdirSync(root).filter(name => /^vitest(\.[\w-]+)?\.config\.[cm]?[jt]s$/.test(name)).sort() : [];
    return [...POLICY_FILES, ...configs].filter(path => existsSync(join(root, path)));
}

/**
 * Code the runner executes that lives OUTSIDE the checkout (a reporter module passed by path, such as the pre-push
 * coverage-scope reporter in the source checkout while the run happens in an export): the runtime snapshot cannot
 * see it, so its bytes and everything it can load are bound into the identity. Loads are read from the PARSED
 * source (a specifier that is not one string literal is a computed load) and each is resolved the way the runtime
 * resolves it — `require("x")` by CommonJS rules, `from "x"` / `import "x"` / `import("x")` by ESM rules (a
 * package `exports` map is read under the `import` condition, a relative path must name a file) — from the
 * IMPORTING module's location. A dependency inside `node_modules` is bound by its COMPLETE installed contents plus
 * the installed contents of its declared dependencies (a version never binds bytes). A closure is UNRESOLVED
 * (`unresolved`) when a load cannot be bound: a computed specifier, an unreadable, unparseable or unresolvable
 * module, an `exports` shape this resolver does not model (patterns, arrays, a subpath it does not export), a
 * declared dependency that is not installed, or a closure larger than the bound. It is OPAQUE (`opaque`) under
 * the same input-eligibility rule tests and setup files obey (`test-dependency-graph.ts`): hashing bytes cannot
 * see what the process, the file system, the network or the clock return, so a module that names such a read,
 * or imports any builtin other than the pure ones, is not reusable evidence. Either way the caller must run
 * fresh and certify nothing.
 */
export interface ReporterBinding { entries: [string, string][]; unresolved: string[]; opaque: string[]; }

const REPORTER_CLOSURE_MAX_FILES = 400;
const SCANNED_EXTENSION = /\.[cm]?[jt]sx?$/;
const NODE_MODULES = `${sep}node_modules${sep}`;
/**
 * Builtin operations that compute over their arguments only: no file, process, working directory, environment,
 * network or clock behind any of them. A module is listed whole only when EVERY export satisfies that; otherwise
 * the permitted named exports are listed, and a default or namespace import of it (`*`) is opaque. `path.resolve`
 * and `path.relative` read the working directory, `url.pathToFileURL` resolves through it, `util.debuglog` reads
 * the environment, `buffer.File` defaults its timestamp from the clock, and `events.EventEmitterAsyncResource`
 * reads async context. Buffer allocation can expose uninitialized memory. None of those is admitted.
 */
const PURE_BUILTINS = new Set(["assert", "assert/strict", "punycode", "querystring", "string_decoder", "util/types"]);
const PURE_BUILTIN_NAMES = new Map<string, Set<string>>([
    ["path", new Set(["basename", "dirname", "extname", "format", "isAbsolute", "join", "normalize", "parse", "sep", "delimiter"])],
    ["url", new Set(["fileURLToPath", "URL", "URLSearchParams"])],
    ["util", new Set(["format", "inspect", "isDeepStrictEqual", "promisify", "inherits", "types"])],
]);
type LoadMode = "import" | "require";

interface Binder { entries: [string, string][]; unresolved: string[]; opaque: string[]; seen: Set<string>; packages: Set<string>; queue: string[]; }

function isBuiltin(specifier: string): boolean {
    return specifier.startsWith("node:") || builtinModules.includes(specifier);
}

/** True when every imported name of the builtin is a pure operation (see PURE_BUILTINS / PURE_BUILTIN_NAMES). */
function isPureBuiltinImport(specifier: string, names: readonly string[]): boolean {
    const module = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
    if (PURE_BUILTINS.has(module)) return true;
    const permitted = PURE_BUILTIN_NAMES.get(module);
    return permitted !== undefined && names.length > 0 && names.every(name => permitted.has(name));
}

/** Node's resolver reports real paths; start from real paths too so one file never appears under two names. */
function realOrResolved(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function readManifest(path: string): Record<string, unknown> | null {
    try {
        const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
        return isJsonObject(manifest) ? manifest : null;
    } catch {
        return null;
    }
}

/** The installed root of package `name` as seen from `dir`: the nearest ancestor `node_modules/<name>` that exists. */
function packageRootFrom(dir: string, name: string): string | null {
    for (let current = dir; ; current = dirname(current)) {
        const candidate = join(current, "node_modules", name);
        if (isFile(join(candidate, "package.json"))) return realOrResolved(candidate);
        if (dirname(current) === current) return null;
    }
}

/** `["pkg", "."]`, `["@s/pkg", "./sub"]`; null for a specifier that is not a bare package name. */
function splitBare(specifier: string): [string, string] | null {
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) return null;
    const parts = specifier.split("/");
    const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] ?? "";
    if (!name || (specifier.startsWith("@") && parts.length < 2)) return null;
    const rest = specifier.slice(name.length);
    return [name, rest ? `.${rest}` : "."];
}

/**
 * The target of an `exports` value under `mode`; null when not exported, undefined when the shape is not modelled
 * (an array, or an object whose matching branch is not modelled). Conditions are matched in object order like
 * Node: the mode's own condition, `node` and `default`; every other condition is skipped.
 */
function exportsTarget(value: unknown, mode: LoadMode): string | null | undefined {
    if (value === null || typeof value === "string") return value;
    if (!isJsonObject(value)) return undefined;
    for (const [condition, next] of Object.entries(value)) {
        if (condition !== mode && condition !== "node" && condition !== "default") continue;
        const target = exportsTarget(next, mode);
        if (target !== null) return target;
    }
    return null;
}

/** Resolves `subpath` through a package's `exports` field; undefined when the field's shape is not modelled. */
function resolveExports(exports: unknown, subpath: string, mode: LoadMode): string | null | undefined {
    const map = isJsonObject(exports) ? exports : null;
    const keys = map === null ? [] : Object.keys(map);
    const isSubpathMap = map !== null && keys.length > 0 && keys.every(key => key.startsWith("."));
    if (!isSubpathMap) return subpath === "." ? exportsTarget(exports, mode) : null;
    if (keys.some(key => key.includes("*"))) return undefined;
    return subpath in map ? exportsTarget(map[subpath], mode) : null;
}

/** Legacy resolution: `main` or `index.js` for ".", the subpath itself otherwise, with CommonJS extension probing. */
function resolveLegacy(root: string, main: unknown, subpath: string): string | null {
    const entry = typeof main === "string" ? main : "index.js";
    const base = join(root, subpath === "." ? entry : subpath);
    for (const candidate of [base, `${base}.js`, `${base}.json`, join(base, "index.js")]) if (isFile(candidate)) return candidate;
    return null;
}

/** A bare specifier resolved under `mode` from the importer's directory, or null when it cannot be resolved exactly. */
function resolveBare(importer: string, specifier: string, mode: LoadMode): string | null {
    const bare = splitBare(specifier);
    if (bare === null) return null;
    const [name, subpath] = bare;
    const root = packageRootFrom(dirname(importer), name);
    const manifest = root === null ? null : readManifest(join(root, "package.json"));
    if (root === null || manifest === null) return null;
    if (!("exports" in manifest)) return resolveLegacy(root, manifest.main, subpath);
    const target = resolveExports(manifest.exports, subpath, mode);
    if (typeof target !== "string" || !target.startsWith("./")) return null;
    const file = join(root, target);
    return isFile(file) ? file : null;
}

/** Resolution the way the runtime loads it: CommonJS for `require`, ESM rules (exact relative file, `import` condition) otherwise. */
function resolveFrom(importer: string, specifier: string, mode: LoadMode): string | null {
    if (mode === "require") {
        try {
            return createRequire(importer).resolve(specifier);
        } catch {
            return null;
        }
    }
    if (specifier.startsWith("/")) return isFile(specifier) ? realOrResolved(specifier) : null;
    if (specifier.startsWith(".")) {
        const file = resolve(dirname(importer), specifier);
        return isFile(file) ? realOrResolved(file) : null;
    }
    return resolveBare(importer, specifier, mode);
}

/** One parsed load of `importer`: a builtin is pure or opaque, a module is resolved by the load's mode, a computed specifier is unresolved. */
function bindLoad(importer: string, reference: ImportReference, binder: Binder): string | null {
    const { specifier, loader: mode } = reference;
    if (specifier === null) {
        binder.unresolved.push(`${importer}:${reference.line} (computed load)`);
        return null;
    }
    if (isBuiltin(specifier)) {
        if (!isPureBuiltinImport(specifier, reference.names)) binder.opaque.push(`${importer} (imports ${[...new Set(reference.names)].join(", ")} from ${specifier})`);
        return null;
    }
    const resolved = resolveFrom(importer, specifier, mode);
    if (resolved === null) binder.unresolved.push(`${importer} -> ${specifier} (${mode})`);
    return resolved;
}

/**
 * The files `importer`'s parsed source loads. An unparseable module cannot be scanned (unresolved); one that names
 * a runtime read the bytes cannot pin is opaque, exactly as a test or setup file would be.
 */
function loadedFiles(importer: string, source: string, binder: Binder): string[] {
    const parsed = parseTsSource(source, importer);
    if (parsed === null || !hasExactSyntax(parsed)) {
        binder.unresolved.push(`${importer} (${parsed === null ? "typescript unavailable to parse loads" : "does not parse"})`);
        return [];
    }
    const read = runtimeOpacity(source);
    if (read !== null) binder.opaque.push(`${importer} (reads \`${read}\`)`);
    const next: string[] = [];
    for (const reference of analyzeSyntax(parsed).imports) {
        if (reference.typeOnly) continue;
        const resolved = bindLoad(importer, reference, binder);
        if (resolved !== null) next.push(resolved);
    }
    return next;
}

/** The installed root of the package a node_modules file belongs to, or null outside node_modules. */
function packageRootOf(path: string): string | null {
    const marker = path.lastIndexOf(NODE_MODULES);
    if (marker < 0) return null;
    const rest = path.slice(marker + NODE_MODULES.length).split(sep);
    const name = rest[0]?.startsWith("@") ? rest.slice(0, 2).join(sep) : rest[0] ?? "";
    const root = join(path.slice(0, marker), "node_modules", name);
    return isFile(join(root, "package.json")) ? root : null;
}

/** Hashes one file's bytes into the binder; null when already seen, unreadable or over the closure bound (the last two are unresolved). */
function bindBytes(path: string, binder: Binder): Buffer | null {
    if (binder.seen.has(path)) return null;
    binder.seen.add(path);
    if (binder.seen.size > REPORTER_CLOSURE_MAX_FILES) {
        binder.unresolved.push(`${path} (closure exceeds ${REPORTER_CLOSURE_MAX_FILES} files)`);
        return null;
    }
    try {
        const source = readFileSync(path);
        binder.entries.push([path, hashBytes(source)]);
        return source;
    } catch {
        binder.unresolved.push(path);
        return null;
    }
}

/** Every file installed under a package root (nested node_modules are other packages: reached through dependencies). */
function installedFiles(root: string): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
            const path = join(dir, entry.name);
            if (entry.name === "node_modules") continue;
            const kind = entry.isSymbolicLink() ? statSync(path) : entry;
            if (kind.isDirectory()) walk(path);
            else if (kind.isFile()) files.push(path);
        }
    };
    walk(root);
    return files;
}

/** Declared dependency names a package can load at runtime (peers and optionals only when installed). */
function declaredDependencies(manifest: Record<string, unknown>): { name: string; required: boolean }[] {
    const names = (field: string, required: boolean) => (isJsonObject(manifest[field]) ? Object.keys(manifest[field]) : []).map(name => ({ name, required }));
    return [...names("dependencies", true), ...names("peerDependencies", false), ...names("optionalDependencies", false)];
}

/** Code a package's runtime can execute: declaration files never run, so their imports are not loads. */
function isExecutableCode(file: string): boolean {
    return SCANNED_EXTENSION.test(file) && !/\.d\.[cm]?ts$/.test(file);
}

/**
 * Hashes every installed file of a package and applies the SAME parsed eligibility checks to its code as to the
 * reporter (a dependency's code runs too): runtime reads, impure builtin imports and computed loads, with every
 * load it names queued for binding. Once the closure is already ineligible, further files are hashed but not
 * parsed — the verdict is fresh-only either way. False once the closure bound is exceeded.
 */
function bindPackageFiles(files: readonly string[], binder: Binder): boolean {
    for (const file of files) {
        const source = bindBytes(file, binder);
        if (source === null && binder.seen.size > REPORTER_CLOSURE_MAX_FILES) return false;
        if (source === null || !isExecutableCode(file) || binder.opaque.length || binder.unresolved.length) continue;
        binder.queue.push(...loadedFiles(file, source.toString("utf8"), binder));
    }
    return true;
}

/**
 * Binds a dependency package: its COMPLETE installed contents (a version pins nothing — an edited internal file is
 * a different reporter) and, transitively, the installed contents of every package it declares. A declared
 * dependency that is not installed is unresolved (the package may still load it from elsewhere); an absent peer or
 * optional dependency cannot be loaded and is skipped.
 */
function bindPackage(root: string, binder: Binder): void {
    if (binder.packages.has(root)) return;
    binder.packages.add(root);
    const manifest = readManifest(join(root, "package.json"));
    if (manifest === null) {
        binder.unresolved.push(`${root} (unreadable package manifest)`);
        return;
    }
    let files: string[];
    try {
        files = installedFiles(root);
    } catch {
        binder.unresolved.push(`${root} (unreadable package contents)`);
        return;
    }
    if (!bindPackageFiles(files, binder)) return;
    for (const { name, required } of declaredDependencies(manifest)) {
        const dependency = packageRootFrom(root, name);
        if (dependency !== null) bindPackage(dependency, binder);
        else if (required) binder.unresolved.push(`${root} -> ${name} (declared dependency not installed)`);
    }
}

/** Binds one loaded file: a checkout-external module is hashed and scanned; a node_modules file binds its whole package. */
function bindFile(path: string, binder: Binder): string[] {
    const root = packageRootOf(path);
    if (root !== null) {
        bindPackage(root, binder);
        return [];
    }
    const source = bindBytes(path, binder);
    if (source === null || !SCANNED_EXTENSION.test(path)) return [];
    return loadedFiles(path, source.toString("utf8"), binder);
}

export function reporterBinding(reporters: readonly string[]): ReporterBinding {
    const binder: Binder = { entries: [], unresolved: [], opaque: [], seen: new Set(), packages: new Set(), queue: reporters.map(realOrResolved) };
    for (let next = binder.queue.shift(); next !== undefined; next = binder.queue.shift()) binder.queue.push(...bindFile(next, binder));
    const distinct = (notes: string[]) => [...new Set(notes)].sort();
    return { entries: binder.entries.sort((left, right) => left[0].localeCompare(right[0])), unresolved: distinct(binder.unresolved), opaque: distinct(binder.opaque) };
}

/** True when a binding taken after the run no longer matches the one the identity was computed from. */
export function reporterBindingChanged(before: ReporterBinding, after: ReporterBinding): boolean {
    return JSON.stringify(before) !== JSON.stringify(after);
}

/** Digest of the present policy files' bytes, keyed by path so a moved or removed file changes it too. */
export function policyDigest(root: string): string {
    const entries = policyPaths(root).map(path => [path, hashBytes(readFileSync(join(root, path)))]);
    return hashBytes(JSON.stringify(["policy-v1", entries]));
}
