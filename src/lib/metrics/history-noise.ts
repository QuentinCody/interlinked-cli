import { execFileSync } from "node:child_process";
import { isDependencyLockfile, sourceLanguage } from "./inventory-roles.js";
import { classifyByPath } from "./role-evidence.js";
import { SHAPE_MIN_CHARS, shapeEvidence } from "./role-evidence-content.js";
import { applyRepoEvidence, loadRepoEvidence, type RepoEvidence } from "./role-repo-evidence.js";
import { applyToolExclude, type ToolExcludes } from "./role-tool-excludes.js";

/**
 * Which paths in a git history are noise for a history metric (rework, change coupling). The two metrics count every changed line
 * or file, so a lockfile, a tool-written migration snapshot or a minified bundle fills the numerator with text nobody wrote.
 * The rules reuse the v5 source roles (path evidence and minified shape); the rest is history-only and path-only.
 * A set-aside file is counted and reported, never dropped silently.
 */
export type HistoryKind = "code" | "data";
export type HistoryVerdict = { kind: HistoryKind } | { kind: "set-aside"; reason: string };

const MAX_BLOB_BYTES = 16 * 1024 * 1024;
/** Drizzle and similar migrators write a snapshot and a journal beside the SQL; a person does not edit them. */
const MIGRATION_SNAPSHOT = /(?:^|\/)(?:migrations?|drizzle)\/(?:.*\/)?meta\/(?:\d+_snapshot|_journal)\.json$/;
const MIGRATION_LOCK = /(^|\/)migration_lock\.toml$/;
/** Styles and markup are written by hand as often as code; they are not data tables. */
const MARKUP = /\.(?:css|scss|sass|less|html?)$/i;

/** Code is a file in a language the role table knows, or styles and markup; the rest (json, yaml, md, text) is data. */
export function historyKind(path: string): HistoryKind {
	return sourceLanguage(path) !== null || MARKUP.test(path) ? "code" : "data";
}

/** The verdict from the path alone. Generated and vendor paths come from the v5 roles. */
export function classifyHistoryPath(rawPath: string, excludes?: ToolExcludes | RepoEvidence): HistoryVerdict {
	const path = rawPath.replaceAll("\\", "/");
	if (isDependencyLockfile(path) || MIGRATION_LOCK.test(path)) return { kind: "set-aside", reason: "lockfile" };
	if (MIGRATION_SNAPSHOT.test(path)) return { kind: "set-aside", reason: "migration snapshot" };
	const byPath = classifyByPath(path);
	const decision = excludes === undefined ? byPath : "tools" in excludes ? applyRepoEvidence(excludes, path, byPath) : applyToolExclude(excludes, path, byPath);
	if ((decision.role === "generated" || decision.role === "vendor" || decision.role === "unlinted") && decision.evidence !== null) {
		return { kind: "set-aside", reason: `${decision.role} (${decision.evidence.kind})` };
	}
	return { kind: historyKind(path) };
}

/** A path verdict that content may still move: a minified bundle is generated whatever its name. */
export function withShape(verdict: HistoryVerdict, content: string): HistoryVerdict {
	if (verdict.kind === "set-aside" || shapeEvidence(content) === null) return verdict;
	return { kind: "set-aside", reason: "generated (shape)" };
}

function gitOutput(cwd: string, args: string[], input?: string): Buffer | null {
	try {
		return execFileSync("git", args, { cwd, input, maxBuffer: MAX_BLOB_BYTES + 4096, stdio: ["pipe", "pipe", "ignore"] });
	} catch { return null; }
}

/** Sizes of `rev:path` blobs in one git process; a missing blob is absent from the result. */
function blobSizes(cwd: string, entries: ReadonlyArray<{ path: string; rev: string }>): Map<number, number> {
	const sizes = new Map<number, number>();
	const output = gitOutput(cwd, ["cat-file", "--batch-check"], entries.map(entry => `${entry.rev}:${entry.path}\n`).join(""));
	if (output === null) return sizes;
	for (const [index, line] of output.toString("utf8").split("\n").entries()) {
		const match = /^[0-9a-f]+ blob (\d+)$/.exec(line);
		if (match?.[1] !== undefined) sizes.set(index, Number(match[1]));
	}
	return sizes;
}

const CHUNK_BYTES = 96 * 1024 * 1024;
/** Binary formats never carry a minified-text shape; reading them only costs bytes. */
const BINARY_NAME = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|woff2?|ttf|otf|eot|mp[34]|mov|webm|ogg|wav|wasm|bin|so|dylib|exe|dll|class|pyc|sqlite3?|db)$/i;

/** Read `rev:path` blobs with one `git cat-file --batch` process per chunk of at most CHUNK_BYTES; a blob that cannot be read is absent. */
function readBlobs(cwd: string, entries: ReadonlyArray<{ path: string; rev: string }>, sizes: ReadonlyArray<number>): Map<number, string> {
	const texts = new Map<number, string>();
	let start = 0;
	while (start < entries.length) {
		let end = start, total = 0;
		while (end < entries.length && (end === start || total + (sizes[end] ?? 0) <= CHUNK_BYTES)) total += sizes[end++] ?? 0;
		const output = execBatch(cwd, entries.slice(start, end), total);
		if (output !== null) parseBatch(output, start, texts);
		start = end;
	}
	return texts;
}

function execBatch(cwd: string, entries: ReadonlyArray<{ path: string; rev: string }>, expectedBytes: number): Buffer | null {
	try {
		return execFileSync("git", ["cat-file", "--batch"], { cwd, input: entries.map(entry => `${entry.rev}:${entry.path}\n`).join(""),
			maxBuffer: expectedBytes + 64 * 1024 + entries.length * 256, stdio: ["pipe", "pipe", "ignore"] });
	} catch { return null; }
}

/** `<oid> blob <size>\n<bytes>\n` per found blob and `<name> missing\n` per absent one, in request order. */
function parseBatch(output: Buffer, firstIndex: number, texts: Map<number, string>): void {
	let at = 0, index = firstIndex;
	while (at < output.length) {
		const eol = output.indexOf(10, at);
		if (eol === -1) return;
		const match = /^[0-9a-f]+ blob (\d+)$/.exec(output.toString("utf8", at, eol));
		at = eol + 1;
		if (match?.[1] !== undefined) {
			const size = Number(match[1]);
			texts.set(index, output.toString("utf8", at, at + size));
			at += size + 1;
		}
		index++;
	}
}

/**
 * The minified-shape detail for each requested blob that has one, keyed by path. Two git processes read all sizes and then
 * every blob of at least the shape size (within a size bound, skipping binary names), whatever the history holds.
 */
export function blobShapes(cwd: string, entries: ReadonlyArray<{ path: string; rev: string }>): Map<string, string> {
	const found = new Map<string, string>();
	if (entries.length === 0) return found;
	const wanted: Array<{ path: string; rev: string }> = [], sizes: number[] = [];
	for (const [index, size] of blobSizes(cwd, entries)) {
		const entry = entries[index];
		if (entry === undefined || size < SHAPE_MIN_CHARS || size > MAX_BLOB_BYTES || BINARY_NAME.test(entry.path)) continue;
		wanted.push(entry);
		sizes.push(size);
	}
	for (const [index, text] of readBlobs(cwd, wanted, sizes)) {
		const entry = wanted[index], evidence = shapeEvidence(text);
		if (entry !== undefined && evidence !== null) found.set(entry.path, evidence.detail);
	}
	return found;
}

/**
 * Fill `cache` with a verdict for each path not seen yet: the path rules first, then the shape of the blob at `rev` for the paths
 * that survive them. A verdict is decided once per path, from the first revision that names it.
 */
export function resolveVerdicts(cwd: string, entries: ReadonlyArray<{ path: string; rev: string }>, cache: Map<string, HistoryVerdict>): void {
	const probe: Array<{ path: string; rev: string }> = [], fresh = new Set<string>();
	const excludes = loadRepoEvidence(cwd);
	for (const entry of entries) {
		if (!fresh.has(entry.path)) {
			if (cache.has(entry.path)) continue;
			cache.set(entry.path, classifyHistoryPath(entry.path, excludes));
			fresh.add(entry.path);
		}
		if (cache.get(entry.path)?.kind !== "set-aside") probe.push(entry);
	}
	for (const path of blobShapes(cwd, probe).keys()) cache.set(path, { kind: "set-aside", reason: "generated (shape)" });
}
