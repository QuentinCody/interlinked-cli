// ===========================================
// File Discovery (git-based with fallback)
// ===========================================
// Prefers `git ls-files` so .gitignore + .interlinked/.claude/dist filters are
// respected. Falls back to a filesystem walk for non-git directories.
//
// The discovery surface is intentionally wide: every tracked text file in the
// repo enters the scan, and each individual check filters to the extensions
// it cares about (tsc → .ts/.tsx, biome → .ts/.tsx/.js/.json, secrets → all
// text, etc.). Keeping discovery broad fixes a long-standing summary-line
// bug where a config file like `tsconfig.json` was flagged by an external
// tool but not counted in the "files scanned" denominator, and it ensures
// the /interlinked verify/ surface covers everything a human would expect
// it to cover — not just a hard-coded source-extension allowlist.

import { execSync, type ExecSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { INTERLINKED_DIR } from "../../lib/interlinked-path.js";
import { recordVerifyInputDeferral } from "./check-timing.js";

/** Public API — the language-source extensions. Consumed by `verify.ts`,
 *  individual checks as their applicability filter, and tests. Do not widen
 *  this to include config/markup types — callers treat it as "is this source
 *  code?". For the scan universe, `discoverFiles()` uses a broader rule. */
export const CODE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
	".py",
	".rs",
	".go",
	".c",
	".cpp",
	".cc",
	".cxx",
	".h",
	".hpp",
	".java",
]);

// Binary content is never meaningfully text-scanned. Keep this list
// maintained alongside the content-scanner's binary-detection logic.
const BINARY_EXTENSIONS = new Set([
	// images
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".tiff", ".heic",
	// media
	".mp3", ".mp4", ".wav", ".ogg", ".webm", ".m4a", ".mov", ".flac", ".avi", ".mkv",
	// fonts
	".woff", ".woff2", ".ttf", ".otf", ".eot",
	// archives
	".zip", ".tar", ".gz", ".tgz", ".bz2", ".7z", ".rar", ".xz", ".lz4", ".zst",
	// compiled artifacts & binaries
	".exe", ".dll", ".so", ".dylib", ".bin", ".class", ".pyc", ".pyo", ".wasm",
	".a", ".lib", ".obj", ".o", ".node",
	// other heavy binaries
	".pdf", ".psd", ".ai", ".sketch", ".fig", ".iso", ".dmg", ".img",
]);

// Lock files and giant generated manifests — structure is valuable for a
// humans but re-scanning them on every verify run is wasteful noise.
const BLOCKED_BASENAMES = new Set([
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"npm-shrinkwrap.json",
	"Cargo.lock",
	"poetry.lock",
	"Pipfile.lock",
	"composer.lock",
	"Gemfile.lock",
	"go.sum",
]);

const WALK_SKIP = new Set([
	".git", INTERLINKED_DIR, ".claude", "node_modules", "dist", "build",
	"coverage", "target", "__pycache__", ".venv", "venv",
]);

export interface DiscoveryOptions { onUnavailable?: (input: { file: string; reason: string }) => void; }

function gitFileList(root: string, options: DiscoveryOptions = {}): string[] | null {
	const env = { ...process.env };
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[name];
	const gitOptions: ExecSyncOptionsWithStringEncoding = {
		cwd: root, env, encoding: "utf-8", maxBuffer: Infinity, stdio: ["ignore", "pipe", "ignore"],
	};
	try {
		const output = execSync("git -c core.fsmonitor=false ls-files --cached --others --exclude-standard -z", gitOptions);
		const files = output.split("\0").filter(Boolean);
		if (files.length === 0 && selectedIgnoredDirectory(root, gitOptions, options)) return null;
		return files;
	} catch (error) {
		if (existsSync(join(root, ".git"))) discoveryUnavailable(root, root, error, options);
		return null;
	}
}

/** Explicitly selecting an ignored subtree gives it the non-Git walk contract. */
function selectedIgnoredDirectory(root: string, gitOptions: ExecSyncOptionsWithStringEncoding, options: DiscoveryOptions): boolean {
	try {
		if (!execSync("git -c core.fsmonitor=false rev-parse --show-prefix", gitOptions).trim()) return false;
		execSync("git -c core.fsmonitor=false check-ignore --quiet -- .", gitOptions);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "status" in error && error.status === 1) return false;
		discoveryUnavailable(root, root, error, options);
		return false;
	}
}

/** Decides whether a relative path (from the repo root) should enter the
 *  discovery universe. Keeps the filter centralized so the git-based path
 *  and the manual-walk fallback agree. */
function shouldDiscover(relPath: string): boolean {
	const segments = relPath.split("/");
	if (segments[0] === "scratch" || segments.slice(0, -1).some(segment => WALK_SKIP.has(segment))) return false;
	const ext = extname(relPath).toLowerCase();
	if (BINARY_EXTENSIONS.has(ext)) return false;
	const base = basename(relPath);
	if (BLOCKED_BASENAMES.has(base)) return false;
	return true;
}

/** Public API — consumed by `verify.ts` (entry point for verify's file set). */
export function discoverFiles(root: string, options: DiscoveryOptions = {}): string[] {
	// Try git ls-files first (respects .gitignore)
	const gitFiles = gitFileList(root, options);
	if (gitFiles !== null) {
		return gitFiles.filter(shouldDiscover).map((file) => join(root, file)).filter(file => discoveredKind(root, file, true, options) === "file");
	}
	return filesystemFiles(root, shouldDiscover, WALK_SKIP, options);
}

function discoveryUnavailable(root: string, file: string, error: unknown, options: DiscoveryOptions = {}): void {
	const code = error instanceof Error && "code" in error ? `${String(error.code)}: ` : "";
	const input = {
		file: relative(root, file) || ".", reason: code + (error instanceof Error ? error.message : String(error)),
	};
	options.onUnavailable?.(input);
	recordVerifyInputDeferral("file_discovery_unavailable", input);
}

/** Preserve regular file aliases while refusing cycles, directory aliases and streams. */
function discoveredKind(root: string, file: string, includeFile = true, options: DiscoveryOptions = {}): "file" | "directory" | null {
	try {
		const stat = lstatSync(file);
		if (stat.isDirectory()) return "directory";
		if (!includeFile) return null;
		if (stat.isFile()) return "file";
		if (stat.isSymbolicLink()) return containedFileAlias(root, file, options);
		discoveryUnavailable(root, file, new Error("Input is not a regular file"), options);
	} catch (error) { discoveryUnavailable(root, file, error, options); }
	return null;
}

function containedFileAlias(root: string, file: string, options: DiscoveryOptions): "file" | null {
	const target = realpathSync(file);
	const rel = relative(realpathSync(root), target);
	if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
		discoveryUnavailable(root, file, new Error("The symbolic link target lies outside the project root"), options);
		return null;
	}
	if (statSync(target).isFile()) return "file";
	discoveryUnavailable(root, file, new Error("The symbolic link target is a directory or another non-regular input"), options);
	return null;
}

function filesystemFiles(root: string, include: (path: string) => boolean, skip = WALK_SKIP, options: DiscoveryOptions = {}): string[] {
	const files: string[] = [], directories = [root];
	while (directories.length) {
		const dir = directories.pop();
		if (dir === undefined) break;
		let entries: string[];
		try {
			entries = readdirSync(dir).sort((a, b) => Number(b === "src") - Number(a === "src") || a.localeCompare(b));
		} catch (error) { discoveryUnavailable(root, dir, error, options); continue; }
		const children: string[] = [];
		for (const entry of entries) {
			if (skip.has(entry) || (dir === root && entry === "scratch")) continue;
			const file = join(dir, entry);
			const kind = discoveredKind(root, file, include(relative(root, file)), options);
			if (kind === "directory") children.push(file);
			else if (kind === "file") files.push(file);
		}
		for (const child of children.reverse()) directories.push(child);
	}
	return files;
}

/**
 * Broader discovery for the function-token census. Git repositories return
 * every tracked/unignored path and let the shared cappable-file policy decide
 * scope. Both inventories retain complete files and populations. The fallback
 * excludes known generated/runtime directories and root-local scratch copies.
 */
export function discoverFunctionTokenFiles(root: string, options: DiscoveryOptions = {}): string[] {
	const gitFiles = gitFileList(root, options);
	// Metric callers own canonicalization and unreadable-source receipts. Keep
	// missing tracked paths available to that existing reporting boundary.
	if (gitFiles !== null) return gitFiles.map((file) => join(root, file));
	return filesystemFiles(root, () => true, new Set([...WALK_SKIP, ".codex"]), options);
}
