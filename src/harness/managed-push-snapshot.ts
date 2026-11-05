import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ManagedPushTrust { files: Readonly<Record<string, string>>; packages: readonly string[]; }
export interface FrozenFile { path: string; sha256: string; mode: number; size: number; }
export interface ManagedPushSnapshot { root: string; files: FrozenFile[]; bytes: number; }
/** Only a verified source/hash comparison establishes this refusal; arbitrary error text cannot. */
export class ManagedPushTrustMismatch extends Error {
    constructor(path: string) { super(`Managed push trust map does not match ${path}`); }
}
const MAX_FILES = 4096;
const MAX_BYTES = 64 * 1024 * 1024;

export function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

export function requireOwnedDirectory(path: string): void {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Managed push directory is unowned or writable by others");
}

function safeRelative(path: string): void {
    if (isAbsolute(path) || !/^[A-Za-z0-9@_.\/-]+$/.test(path) || path.split("/").some(part => part === ".." || part === "." || !part)) throw new Error("Unsafe managed push path");
}

function copyFrozenFile(source: string, path: string, state: ManagedPushSnapshot, expected?: string): void {
    safeRelative(path);
    const before = lstatSync(source);
    if (!before.isFile() || realpathSync(source) !== source) throw new Error("Managed push input must be a canonical regular file");
    if (before.size + state.bytes > MAX_BYTES || state.files.length >= MAX_FILES) throw new Error("Managed push snapshot exceeds bounded runtime size");
    const bytes = readFileSync(source);
    const after = lstatSync(source);
    const sha256 = digest(bytes);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== bytes.length || before.mtimeMs !== after.mtimeMs) throw new Error(`Managed push input changed: ${path}`);
    // The trust map pins these bytes; a difference means the map is stale for this checkout, not that the file moved.
    if (expected && sha256 !== expected) throw new ManagedPushTrustMismatch(path);
    const target = join(state.root, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const mode = before.mode & 0o111 ? 0o555 : 0o444;
    writeFileSync(target, bytes, { mode, flag: "wx" });
    state.files.push({ path, sha256, mode, size: bytes.length });
    state.bytes += bytes.length;
}

function copyPackageTree(source: string, destination: string, state: ManagedPushSnapshot): void {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
        const child = join(source, entry.name);
        const path = `${destination}/${entry.name}`;
        if (entry.isDirectory()) copyPackageTree(child, path, state);
        else copyFrozenFile(child, path, state);
    }
}

function copyRuntimePackages(root: string, names: readonly string[], state: ManagedPushSnapshot): void {
    const pending = [...names];
    const copied = new Set<string>();
    while (pending.length) {
        const name = pending.pop();
        if (!name || copied.has(name)) continue;
        safeRelative(name);
        const source = join(root, "node_modules", name);
        const pkg: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
        copyPackageTree(source, `node_modules/${name}`, state);
        copied.add(name);
        pending.push(...Object.keys(pkg.dependencies ?? {}));
        for (const optional of Object.keys(pkg.optionalDependencies ?? {})) {
            try { if (statSync(join(root, "node_modules", optional)).isDirectory()) pending.push(optional); }
            catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
        }
    }
}

/** An install may replace an earlier input while later files are copied. */
function verifyOriginalGeneration(root: string, files: FrozenFile[]): void {
    for (const file of files) {
        const path = join(root, file.path);
        const stat = lstatSync(path);
        if (!stat.isFile() || realpathSync(path) !== path || stat.size !== file.size || digest(readFileSync(path)) !== file.sha256) throw new Error(`Managed push runtime generation changed: ${file.path}`);
    }
}

/** Snapshots are bounded and private. A never-executed native rewrite cannot grow this cache indefinitely. */
export function createManagedPushSnapshot(root: string, trust: ManagedPushTrust): ManagedPushSnapshot {
    root = realpathSync(root);
    requireOwnedDirectory(root);
    const stateDirectory = join(root, ".interlinked");
    try { mkdirSync(stateDirectory, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    requireOwnedDirectory(stateDirectory);
    const cache = join(stateDirectory, "managed-push");
    try { mkdirSync(cache, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    requireOwnedDirectory(cache);
    if (realpathSync(cache) !== cache || readdirSync(cache).length >= 16) throw new Error("Managed push snapshot capacity unavailable");
    const state: ManagedPushSnapshot = { root: mkdtempSync(join(cache, "run-")), files: [], bytes: 0 };
    try {
        for (const [path, hash] of Object.entries(trust.files)) {
            safeRelative(path);
            copyFrozenFile(resolve(root, path), path, state, hash);
        }
        copyRuntimePackages(root, trust.packages, state);
        verifyOriginalGeneration(root, state.files);
        return state;
    } catch (error) { removeManagedPushSnapshot(state.root); throw error; }
}

export function sealManagedPushSnapshot(root: string): void {
    for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) sealManagedPushSnapshot(join(root, entry.name));
    chmodSync(root, 0o500);
}

/** Only the freshly allocated, private snapshot path is passed here. */
export function removeManagedPushSnapshot(root: string): void {
    const part = relative(dirname(root), root);
    if (!/^run-[A-Za-z0-9]+$/.test(part)) throw new Error("Refusing to remove an unrecognized managed push snapshot");
    const unlock = (path: string): void => {
        chmodSync(path, 0o700);
        for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) unlock(join(path, entry.name));
    };
    unlock(root);
    rmSync(root, { recursive: true });
}
