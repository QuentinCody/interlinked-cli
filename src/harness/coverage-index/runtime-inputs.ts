import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readlinkSync, realpathSync, readdirSync, statSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { hashBytes } from "../../lib/metrics/inventory.js";
import { skipsCoverageOverlayEntry } from "../coverage-overlay.js";

export interface CoverageRuntimeInput { path: string; kind: string; mode: number; hash: string; }
export interface CoverageRuntimeSnapshot { inputs: CoverageRuntimeInput[]; hash: string; }
export interface CoverageRuntimeOptions { deadline: number; originalRoot: string; excluded?: readonly string[]; }
const MAX_ENTRIES = 200_000;
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
interface Census { options: CoverageRuntimeOptions; entries: number; bytes: number; buffer: Buffer; inputs: CoverageRuntimeInput[]; }
interface InputLocation { path: string; logical: string; canonical: string; entry: BigIntStats; stat: BigIntStats; link: string | undefined; mount: string | undefined; mounted: boolean; }

export function remainingCoverageTime(deadline: number): number {
    const remaining = Math.floor(deadline - Date.now());
    if (remaining < 1) throw new Error("Coverage runtime validation deadline exhausted; index unavailable");
    return remaining;
}
/** Vite's bundled config loader removes its temporary files but retains this directory. */
export function prepareCoverageRuntime(root: string, deadline: number): void {
    remainingCoverageTime(deadline);
    const dependencies = join(root, "node_modules");
    if (!statSync(dependencies).isDirectory()) throw new Error("Local dependency directory required for coverage runtime verification");
    mkdirSync(join(dependencies, ".vite-temp"), { recursive: true });
}
function state(stat: BigIntStats): string {
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function within(root: string, path: string): boolean {
    const value = relative(root, path);
    return !isAbsolute(value) && !/^\.\.(?:[\\/]|$)/.test(value);
}
function fileHash(path: string, before: BigIntStats, census: Census): string {
    const descriptor = openSync(path, "r");
    try {
        if (state(fstatSync(descriptor, { bigint: true })) !== state(before)) throw new Error("Coverage input changed before reading");
        const hash = createHash("sha256");
        let bytes = 0n;
        for (;;) {
            remainingCoverageTime(census.options.deadline);
            const count = readSync(descriptor, census.buffer, 0, census.buffer.length, null);
            if (!count) break;
            census.bytes += count; bytes += BigInt(count);
            if (census.bytes > MAX_BYTES) throw new Error("Coverage inputs exceed 4 GiB validation bound");
            hash.update(census.buffer.subarray(0, count));
        }
        if (bytes !== before.size || state(fstatSync(descriptor, { bigint: true })) !== state(before) || state(statSync(path, { bigint: true })) !== state(before)) throw new Error("Coverage input changed while reading");
        return hash.digest("hex");
    } finally { closeSync(descriptor); }
}
function locate(path: string, logical: string, census: Census, dependencyRoot: string | undefined): InputLocation {
    const entry = lstatSync(path, { bigint: true }), canonical = realpathSync(path);
    const mounted = logical.split(/[\\/]/).at(-1) === "node_modules";
    const mount = mounted ? canonical : dependencyRoot;
    const link = entry.isSymbolicLink() ? readlinkSync(path) : undefined;
    const allowed = within(census.options.originalRoot, canonical) || (mount !== undefined && within(mount, canonical));
    if (link !== undefined && !mounted && !allowed) throw new Error(`External coverage symlink cannot be verified: ${logical}`);
    return { path, logical, canonical, entry, stat: link === undefined ? entry : statSync(path, { bigint: true }), link, mount, mounted };
}
function unchanged(location: InputLocation): void {
    if (state(lstatSync(location.path, { bigint: true })) !== state(location.entry) ||
        (location.link !== undefined && readlinkSync(location.path) !== location.link)) throw new Error(`Coverage input changed while reading: ${location.logical}`);
}
function omitted(name: string, location: InputLocation, census: Census): boolean {
    const child = resolve(location.path, name);
    return census.options.excluded?.some(excluded => child === resolve(excluded)) === true ||
        (!location.mount && skipsCoverageOverlayEntry(name, location.logical ? 1 : 0));
}
async function visitDirectory(location: InputLocation, census: Census, ancestors: ReadonlySet<string>): Promise<void> {
    const { path, logical, canonical, stat, mounted, mount } = location;
    if (ancestors.has(canonical)) throw new Error(`Cyclic coverage directory link: ${logical}`);
    census.inputs.push({ path: logical, kind: mounted ? "dependency" : "directory", mode: Number(stat.mode & 0o777n), hash: mounted ? hashBytes(canonical) : "" });
    const nextAncestors = new Set([...ancestors, canonical]);
    for (const name of readdirSync(path).sort()) {
        if (omitted(name, location, census)) continue;
        await visit(join(path, name), logical ? join(logical, name) : name, census, nextAncestors, mount);
    }
    if (state(statSync(path, { bigint: true })) !== state(stat)) throw new Error(`Coverage directory changed while reading: ${logical}`);
}
async function visit(path: string, logical: string, census: Census, ancestors: ReadonlySet<string>, dependencyRoot?: string): Promise<void> {
    remainingCoverageTime(census.options.deadline);
    if (++census.entries > MAX_ENTRIES) throw new Error("Coverage inputs exceed 200000-entry validation bound");
    if (census.entries % 64 === 0) await setImmediate();
    const location = locate(path, logical, census, dependencyRoot);
    if (location.link !== undefined && !location.mounted) census.inputs.push({ path: logical, kind: "link", mode: 0, hash: hashBytes(location.canonical) });
    if (location.stat.isDirectory()) await visitDirectory(location, census, ancestors);
    else if (location.stat.isFile()) census.inputs.push({ path: logical, kind: "file", mode: Number(location.stat.mode & 0o777n), hash: fileHash(path, location.stat, census) });
    else throw new Error(`Unsupported coverage runtime input: ${logical}`);
    unchanged(location);
}
/** Verify the actual mirror, including ignored files and linked dependency bytes. */
export async function captureCoverageRuntime(root: string, options: CoverageRuntimeOptions): Promise<CoverageRuntimeSnapshot> {
    const census: Census = { options, entries: 0, bytes: 0, buffer: Buffer.allocUnsafe(64 * 1024), inputs: [] };
    await visit(realpathSync(root), "", census, new Set());
    const inputs = census.inputs.filter(input => input.path !== "");
    remainingCoverageTime(options.deadline);
    return { inputs, hash: hashBytes(JSON.stringify(inputs)) };
}
/** Source/test bytes have shard identities; every other byte invalidates the whole index. */
export function coverageRuntimeSupportHash(snapshot: CoverageRuntimeSnapshot, sourcePaths: ReadonlySet<string>): string {
    return hashBytes(JSON.stringify(snapshot.inputs.map(input => input.kind === "file" && sourcePaths.has(input.path) ? { ...input, hash: "per-shard-source" } : input)));
}
