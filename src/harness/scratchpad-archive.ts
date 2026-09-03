// ===========================================
// SessionEnd scratchpad archive sweep
// ===========================================
// The host provisions an ephemeral, session-scoped scratchpad
// (`<temp-root>/claude-<uid>/<cwd-slug>/<session-id>/scratchpad`) and its
// system prompt directs ALL temporary work there — probe scripts, analysis
// outputs, extracted packages. The OS purges that tree (reboot + periodic tmp
// cleaning), which throws away the session's lab notebook. This sweep runs on
// SessionEnd and copies what's worth keeping into
// `.interlinked/scratchpad-archive/` — content-addressed blobs plus a
// per-session manifest — so the artifacts join the rest of the local corpus
// (activity/collection JSONL, trajectories) for audit and training use.
//
// Contract: never blocks, never throws — any failure logs and returns null.
// Bounded work: per-file cap, total-bytes budget, file-count cap, dir and
// extension excludes (node_modules, package/, *.tgz, binaries). Everything
// skipped is recorded in the manifest — no silent truncation.

import { createHash } from "node:crypto";
import {
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesAnyGlob } from "../lib/path-glob.js";
import { sanitizeSessionId } from "./session-paths.js";
import type { GuardRulesConfig, ScratchpadArchiveConfig } from "./types.js";

export interface ScratchpadArchiveSkip {
	path: string;
	reason:
		| "excluded-dir"
		| "excluded-extension"
		| "too-large"
		| "binary"
		| "symlink"
		| "budget-exhausted"
		| "file-cap"
		| "unreadable"
		| "vendored-tree"
		| "excluded-glob";
}

export interface ScratchpadArchiveSummary {
	sessionId: string;
	sourceDir: string;
	manifestPath: string;
	fileCount: number;
	totalBytes: number;
	truncated: boolean;
	skipped: ScratchpadArchiveSkip[];
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_MAX_TOTAL_BYTES = 24 * 1024 * 1024; // 24 MiB
const DEFAULT_MAX_FILES = 2000;
/** Skip entries recorded in the manifest are capped so a pathological tree
 *  (extracted node_modules) can't bloat the manifest itself. */
const SKIP_LIST_CAP = 200;
/** Third-party bulk and build output — never the session's own work. The
 *  `package` entry is npm's tarball extraction root (`npm pack` + `tar xzf`). */
const EXCLUDED_DIR_NAMES = new Set([
	"node_modules",
	".git",
	"package",
	"dist",
	"build",
	".cache",
	".npm",
	".venv",
	"__pycache__",
]);
const EXCLUDED_EXT_RE = /\.(tgz|tar|gz|zip|br|7z|dmg|iso)$/i;
const BINARY_SNIFF_BYTES = 8192;
/** Marker files that make a scratchpad subdirectory a FOREIGN PROJECT ROOT — a
 *  cloned repo, an extracted package, a vendored checkout. Excluding the whole
 *  subtree (rather than just its `.git`/`node_modules`) is the difference
 *  between an archive of the session's own work and an archive of someone
 *  else's repo: a single 50k-file clone spends the entire file cap and evicts
 *  every agent-authored artifact, which is exactly what happened to the
 *  2026-08 sessions (both surviving manifests: file_count 2000, truncated). */
const FOREIGN_ROOT_MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml"];

/** True when `absDir` carries a foreign-project marker. Applied only to
 *  subdirectories — the scratchpad ROOT is never treated as foreign, so a
 *  session that drops a lone `package.json` at the top level to reproduce a
 *  manifest bug still gets archived. */
function isForeignProjectRoot(absDir: string): boolean {
	return FOREIGN_ROOT_MARKERS.some((m) => existsSync(join(absDir, m)));
}

/** Candidate scratchpad locations for this (cwd, session) pair, following the
 *  coding host's layout: `<temp-root>/claude-<uid>/<cwd-slug>/<session-id>/scratchpad`.
 *  Returns [] when no uid is available (non-POSIX host — the layout is
 *  uid-keyed, so there is nothing to derive). */
export function deriveScratchpadCandidates(opts: {
	cwd: string;
	sessionId: string;
	uid: number | undefined;
}): string[] {
	if (opts.uid === undefined) return [];
	const slug = opts.cwd.replace(/\//g, "-");
	const roots = new Set<string>();
	for (const base of [tmpdir(), "/tmp", "/private/tmp"]) {
		try {
			roots.add(realpathSync(base));
		} catch {
			roots.add(base);
		}
	}
	return [...roots].map((root) =>
		join(root, `claude-${opts.uid}`, slug, opts.sessionId, "scratchpad"),
	);
}

type WalkResult = { files: string[]; skipped: ScratchpadArchiveSkip[] };

/** Walk-wide inputs the per-entry classifier needs (kept as one object so the
 *  classifier's parameter list stays short). */
type WalkContext = { sourceDir: string; excludeGlobs: string[] };

/** Route one directory entry into the walk's files / skips / pending-dirs. */
function classifyWalkEntry(
	entry: Dirent,
	relPath: string,
	out: WalkResult,
	pending: string[],
	ctx: WalkContext,
): void {
	if (entry.isSymbolicLink()) {
		out.skipped.push({ path: relPath, reason: "symlink" });
		return;
	}
	if (ctx.excludeGlobs.length > 0 && matchesAnyGlob(relPath, ctx.excludeGlobs)) {
		out.skipped.push({ path: relPath, reason: "excluded-glob" });
		return;
	}
	if (entry.isDirectory()) {
		if (EXCLUDED_DIR_NAMES.has(entry.name)) {
			out.skipped.push({ path: relPath, reason: "excluded-dir" });
		} else if (isForeignProjectRoot(join(ctx.sourceDir, relPath))) {
			out.skipped.push({ path: relPath, reason: "vendored-tree" });
		} else {
			pending.push(relPath);
		}
		return;
	}
	if (entry.isFile()) out.files.push(relPath);
}

/** Enumerate archivable files (relative paths) under `sourceDir`, recording
 *  symlink / excluded-dir skips. Enumeration is bounded: it stops once the
 *  candidate list is comfortably past the file cap. */
function collectCandidateFiles(
	sourceDir: string,
	maxFiles: number,
	excludeGlobs: string[] = [],
): WalkResult {
	const out: WalkResult = { files: [], skipped: [] };
	const pending: string[] = [""];
	const ctx: WalkContext = { sourceDir, excludeGlobs };
	const scanCeiling = maxFiles + SKIP_LIST_CAP;
	while (pending.length > 0 && out.files.length <= scanCeiling) {
		const relDir = pending.pop() ?? "";
		for (const entry of readdirSync(join(sourceDir, relDir), { withFileTypes: true })) {
			const relPath = relDir ? join(relDir, entry.name) : entry.name;
			classifyWalkEntry(entry, relPath, out, pending, ctx);
		}
	}
	out.files.sort();
	return out;
}

type ArchiveBudget = {
	maxFileBytes: number;
	maxTotalBytes: number;
	maxFiles: number;
};

type ManifestEntry = { path: string; size: number; sha256: string };

/** Classify-and-copy one candidate file into the blob store. Returns the
 *  manifest entry, a skip record, or "stop" when the total budget is spent. */
function archiveOneFile(opts: {
	sourceDir: string;
	blobsDir: string;
	relPath: string;
	budget: ArchiveBudget;
	totalSoFar: number;
}): { entry?: ManifestEntry; skip?: ScratchpadArchiveSkip; stop?: boolean } {
	const { sourceDir, blobsDir, relPath, budget, totalSoFar } = opts;
	let size: number;
	try {
		size = statSync(join(sourceDir, relPath)).size;
	} catch {
		return { skip: { path: relPath, reason: "unreadable" } };
	}
	if (EXCLUDED_EXT_RE.test(relPath)) {
		return { skip: { path: relPath, reason: "excluded-extension" } };
	}
	if (size > budget.maxFileBytes) {
		return { skip: { path: relPath, reason: "too-large" } };
	}
	if (totalSoFar + size > budget.maxTotalBytes) {
		return { skip: { path: relPath, reason: "budget-exhausted" }, stop: true };
	}
	let content: Buffer;
	try {
		content = readFileSync(join(sourceDir, relPath));
	} catch {
		return { skip: { path: relPath, reason: "unreadable" } };
	}
	if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
		return { skip: { path: relPath, reason: "binary" } };
	}
	const sha256 = createHash("sha256").update(content).digest("hex");
	const blobPath = join(blobsDir, sha256);
	if (!existsSync(blobPath)) {
		writeFileSync(blobPath, content);
	}
	return { entry: { path: relPath, size, sha256 } };
}

/** Resolve one candidate path's outcome against the running file-count cap,
 *  then delegate to `archiveOneFile`. Keeps the file-cap check and the
 *  per-file archive decision behind one call so the caller loop only
 *  applies the result, rather than branching on both itself. */
function resolveCandidateOutcome(opts: {
	sourceDir: string;
	blobsDir: string;
	relPath: string;
	budget: ArchiveBudget;
	entriesCount: number;
	totalSoFar: number;
}): { entry: ManifestEntry | undefined; skip: ScratchpadArchiveSkip | undefined; truncate: boolean | undefined } {
	const { sourceDir, blobsDir, relPath, budget, entriesCount, totalSoFar } = opts;
	if (entriesCount >= budget.maxFiles) {
		return { entry: undefined, skip: { path: relPath, reason: "file-cap" }, truncate: true };
	}
	const result = archiveOneFile({ sourceDir, blobsDir, relPath, budget, totalSoFar });
	return { entry: result.entry, skip: result.skip, truncate: result.stop };
}

type CandidateOutcome = ReturnType<typeof resolveCandidateOutcome>;

/** Apply one candidate's outcome to the running manifest state: push a new
 *  entry or skip record into the caller's lists, and report how many bytes
 *  to add to the running total. `truncated` stays the caller's own flag —
 *  it's the only piece of state this doesn't own. */
function applyCandidateResult(opts: {
	result: CandidateOutcome;
	entries: ManifestEntry[];
	skipped: ScratchpadArchiveSkip[];
}): number {
	const { result, entries, skipped } = opts;
	if (result.entry) {
		entries.push(result.entry);
	}
	if (result.skip && (result.skip.reason === "file-cap" || skipped.length < SKIP_LIST_CAP)) {
		skipped.push(result.skip);
	}
	return result.entry ? result.entry.size : 0;
}

/** Archive one scratchpad directory into `destRoot` (blobs + manifest).
 *  Pure-ish core shared by the SessionEnd wiring and tests; returns null when
 *  the source doesn't exist or isn't a directory. `clock` is injectable for
 *  deterministic tests (defaults to the real time). */
export function archiveScratchpadDir(opts: {
	sourceDir: string;
	destRoot: string;
	sessionId: string;
	config?: ScratchpadArchiveConfig | undefined;
	clock?: () => string;
}): ScratchpadArchiveSummary | null {
	const { sourceDir, destRoot, sessionId, config } = opts;
	try {
		if (!statSync(sourceDir).isDirectory()) return null;
	} catch {
		return null;
	}
	const budget: ArchiveBudget = {
		maxFileBytes: config?.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES,
		maxTotalBytes: config?.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES,
		maxFiles: config?.max_files ?? DEFAULT_MAX_FILES,
	};
	const blobsDir = join(destRoot, "blobs");
	mkdirSync(blobsDir, { recursive: true });

	const walk = collectCandidateFiles(sourceDir, budget.maxFiles, config?.archive_excludes ?? []);
	const skipped: ScratchpadArchiveSkip[] = [...walk.skipped];
	const entries: ManifestEntry[] = [];
	let totalBytes = 0;
	let truncated = false;
	for (const relPath of walk.files) {
		const result = resolveCandidateOutcome({
			sourceDir,
			blobsDir,
			relPath,
			budget,
			entriesCount: entries.length,
			totalSoFar: totalBytes,
		});
		totalBytes += applyCandidateResult({ result, entries, skipped });
		if (result.truncate) truncated = true;
	}

	const safeId = sanitizeSessionId(sessionId) || "unknown-session";
	const manifestPath = join(destRoot, `${safeId}.manifest.json`);
	const manifest = {
		schema: "scratchpad-archive.v1",
		session_id: sessionId,
		source_dir: sourceDir,
		archived_at: (opts.clock ?? (() => new Date().toISOString()))(),
		file_count: entries.length,
		total_bytes: totalBytes,
		truncated,
		files: entries,
		skipped,
	};
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	return {
		sessionId,
		sourceDir,
		manifestPath,
		fileCount: entries.length,
		totalBytes,
		truncated,
		skipped,
	};
}

/** Locate this session's scratchpad (host layout) and archive it under
 *  `.interlinked/scratchpad-archive/`. Null when no scratchpad exists. */
function archiveSessionScratchpad(opts: {
	cwd: string;
	sessionId: string;
	config?: ScratchpadArchiveConfig | undefined;
}): ScratchpadArchiveSummary | null {
	const uid = process.getuid?.();
	const sourceDir = deriveScratchpadCandidates({
		cwd: opts.cwd,
		sessionId: opts.sessionId,
		uid,
	}).find((c) => existsSync(c));
	if (!sourceDir) return null;
	return archiveScratchpadDir({
		sourceDir,
		destRoot: join(opts.cwd, ".interlinked", "scratchpad-archive"),
		sessionId: opts.sessionId,
		config: opts.config,
	});
}

/** SessionEnd wiring: enabled-check + never-throw wrapper around
 *  {@link archiveSessionScratchpad}. Public API — consumed by
 *  server/lifecycle-events.ts on every SessionEnd. */
export function runSessionEndScratchpadArchive(opts: {
	cwd: string;
	sessionId: string;
	rules: GuardRulesConfig;
	log: (msg: string) => void;
}): void {
	if (opts.rules.scratchpad_archive?.enabled === false) return;
	try {
		const summary = archiveSessionScratchpad({
			cwd: opts.cwd,
			sessionId: opts.sessionId,
			config: opts.rules.scratchpad_archive,
		});
		if (summary) {
			opts.log(
				`Scratchpad archived: ${summary.fileCount} file(s), ${summary.totalBytes} bytes` +
					`${summary.truncated ? " (truncated)" : ""} → ${summary.manifestPath}`,
			);
		}
	} catch (err) {
		opts.log(
			`Scratchpad archive failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
