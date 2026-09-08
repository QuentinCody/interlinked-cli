import { createHash } from "node:crypto";
import { closeSync, type BigIntStats, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { LintImportEntry } from "./types.js";

// Runtime receipts/cache state is outside the source closure. Explicit requests
// into it require review; source, dependency and generated directories remain.
const OMIT = new Set([".git", ".interlinked", "__pycache__", ".mypy_cache", ".ruff_cache", ".pytest_cache", ".eslintcache", ".stylelintcache"]);
const MAX_ENTRIES = 100_000;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_ANCHOR_CHARS = 1024 * 1024;
const IGNORE_OVERRIDES = new Set(["--no-ignore", "--no-respect-gitignore", "--no-git-ignore", "--disable-ignore", "--disregard-sqlfluffignores", "--no-force-exclude", "--ignore-parent-exclusion"]);

export interface SourceFileSnapshot { identity: string; digest: string }
export type LintSourceSnapshot = Map<string, SourceFileSnapshot>;
interface ReadBudget { deadline: number; bytes: number }
interface Census extends ReadBudget {
    root: string; files: LintSourceSnapshot; seen: Set<string>; visited: number; ignoreOverride: boolean;
}
interface FileMetadata { identity: string; targetIdentity: string; stat: BigIntStats; link: boolean }

function identity(stat: BigIntStats): string {
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(":");
}

function metadata(path: string): FileMetadata {
    const entry = lstatSync(path, { bigint: true });
    if (!entry.isSymbolicLink()) return { identity: identity(entry), targetIdentity: identity(entry), stat: entry, link: false };
    const target = statSync(path, { bigint: true });
    return { identity: identity(entry) + "->" + readlinkSync(path) + "->" + identity(target), targetIdentity: identity(target), stat: target, link: true };
}

function checkTime(budget: ReadBudget): void {
    if (performance.now() >= budget.deadline) throw new Error("Lint source snapshot time budget exhausted; no verdict");
}

function readContent(path: string, before: FileMetadata, budget: ReadBudget, consume?: (chunk: Buffer) => void): string {
    if (!before.stat.isFile()) throw new Error("Lint source is not a regular file: " + path + "; no verdict");
    if (before.stat.size > BigInt(MAX_TOTAL_BYTES - budget.bytes)) throw new Error("Lint source snapshot byte budget exceeded; no verdict");
    const descriptor = openSync(path, "r");
    try {
        const opened = fstatSync(descriptor, { bigint: true });
        if (identity(opened) !== before.targetIdentity) throw new Error("Lint source changed before reading: " + path + "; no verdict");
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(CHUNK_BYTES);
        let bytes = 0n;
        for (;;) {
            checkTime(budget);
            const count = readSync(descriptor, buffer, 0, buffer.length, null);
            if (count === 0) break;
            budget.bytes += count;
            if (budget.bytes > MAX_TOTAL_BYTES) throw new Error("Lint source snapshot byte budget exceeded; no verdict");
            bytes += BigInt(count);
            const chunk = buffer.subarray(0, count);
            hash.update(chunk);
            consume?.(chunk);
        }
        if (bytes !== opened.size || identity(fstatSync(descriptor, { bigint: true })) !== before.targetIdentity || metadata(path).identity !== before.identity) {
            throw new Error("Lint source changed while reading: " + path + "; no verdict");
        }
        return hash.digest("hex");
    } finally { closeSync(descriptor); }
}

function confinedDirectory(root: string, path: string): string {
    const canonical = realpathSync(path);
    const rel = relative(root, canonical);
    if (/^\.\.(?:[\\/]|$)/.test(rel) || isAbsolute(rel)) throw new Error("External symlinked lint directory needs review: " + path + "; no verdict");
    return canonical;
}

function visitSource(census: Census, path: string): void {
    if (census.seen.has(path)) return;
    census.seen.add(path);
    if (++census.visited > MAX_ENTRIES) throw new Error("Lint source snapshot census budget exceeded; no verdict");
    checkTime(census);
    const before = metadata(path);
    const file = relative(census.root, path).split("\\").join("/");
    if (before.stat.isDirectory()) {
        if (before.link) {
            census.files.set(file, { identity: before.identity, digest: "" });
            visitSource(census, confinedDirectory(census.root, path));
            return;
        }
        visitDirectory(census, path);
        return;
    }
    census.files.set(file, { identity: before.identity, digest: readContent(path, before, census) });
}

function visitDirectory(census: Census, path: string): void {
    for (const child of readdirSync(path)) {
        if (OMIT.has(child)) {
            if (census.ignoreOverride) throw new Error("Lint ignore override intersects omitted runtime state; no source snapshot verdict");
            continue;
        }
        visitSource(census, join(path, child));
    }
}

function checkExplicitRuntimeTargets(entry: LintImportEntry): void {
    const targets = entry.targets ?? entry.report?.args ?? [];
    if (targets.some((target) => target.split(/[\\/]/).some((part) => OMIT.has(part)))) {
        throw new Error("Explicit lint target intersects omitted runtime state; no source snapshot verdict");
    }
}

/** Stream every regular file in the working scope; no extension/ignore guessing. */
export function captureLintSourceSnapshot(root: string, entry: LintImportEntry, deadline: number): LintSourceSnapshot {
    checkExplicitRuntimeTargets(entry);
    const canonicalRoot = realpathSync(root);
    const scope = confinedDirectory(canonicalRoot, join(root, entry.scope));
    const census: Census = { root: canonicalRoot, files: new Map(), seen: new Set(), visited: 0, bytes: 0, deadline,
        ignoreOverride: (entry.flags ?? []).some((flag) => IGNORE_OVERRIDES.has(flag)) };
    visitSource(census, scope);
    checkTime(census);
    return census.files;
}

export function checkLintSourceSnapshot(before: LintSourceSnapshot, after: LintSourceSnapshot): void {
    const changed = [...new Set([...before.keys(), ...after.keys()])].find((file) => {
        const previous = before.get(file);
        const current = after.get(file);
        return previous?.digest !== current?.digest || previous?.identity !== current?.identity;
    });
    if (changed !== undefined) throw new Error("Lint source changed during analysis: " + changed + "; no verdict");
}

/** Anchor bytes are from a checked read matching the pre-analysis digest. */
export function lintSnapshotLine(root: string, file: string, line: number, snapshot: LintSourceSnapshot, deadline: number): string {
    const path = join(root, file);
    const canonicalFile = relative(realpathSync(root), realpathSync(path)).split("\\").join("/");
    const expected = snapshot.get(file) ?? snapshot.get(canonicalFile);
    if (!expected) throw new Error("Lint diagnostic has no source snapshot: " + file + "; no verdict");
    const before = metadata(path);
    if (before.identity !== expected.identity) throw new Error("Lint source changed before anchoring: " + file + "; no verdict");
    const decoder = new StringDecoder("utf8");
    let current = 1;
    let anchor = "";
    function consume(text: string): void {
        for (const part of text.split(/(?<=\n)/)) {
            if (current === line) {
                anchor += part;
                if (anchor.length > MAX_ANCHOR_CHARS) throw new Error("Lint diagnostic anchor budget exceeded; no verdict");
            }
            if (part.endsWith("\n")) current++;
        }
    }
    const digest = readContent(path, before, { deadline, bytes: 0 }, (chunk) => consume(decoder.write(chunk)));
    consume(decoder.end());
    if (digest !== expected.digest) throw new Error("Lint source changed before anchoring: " + file + "; no verdict");
    if (current < line) throw new Error("Stale lint location: " + file + ":" + line);
    return anchor.replace(/\r?\n$/, "");
}
