// ===========================================
// File Discovery (git-based with fallback)
// ===========================================
// Prefers `git ls-files` so .gitignore + .interlinked/.claude/dist filters are
// respected. Falls back to a bounded manual walk for non-git directories.
//
// The discovery surface is intentionally wide: every tracked text file in the
// repo enters the scan, and each individual check filters to the extensions
// it cares about (tsc → .ts/.tsx, biome → .ts/.tsx/.js/.json, secrets → all
// text, etc.). Keeping discovery broad fixes a long-standing summary-line
// bug where a config file like `tsconfig.json` was flagged by an external
// tool but not counted in the "files scanned" denominator, and it ensures
// the /interlinked verify/ surface covers everything a human would expect
// it to cover — not just a hard-coded source-extension allowlist.

import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { INTERLINKED_DIR } from "../../lib/interlinked-path.js";

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

const MAX_WALK_ENTRIES = 50_000;
const MAX_FILE_BYTES = 1_000_000;

function gitFileList(root: string): string[] | null {
	try {
		const output = execSync("git ls-files --cached --others --exclude-standard -z", {
			cwd: root,
			encoding: "utf-8",
			timeout: 15_000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return output.split("\0").filter(Boolean);
	} catch {
		return null;
	}
}

/** Decides whether a relative path (from the repo root) should enter the
 *  discovery universe. Keeps the filter centralized so the git-based path
 *  and the manual-walk fallback agree. */
function shouldDiscover(relPath: string): boolean {
	if (relPath.startsWith(".interlinked/") || relPath.includes("/.interlinked/")) return false;
	if (relPath.startsWith(".claude/") || relPath.includes("/.claude/")) return false;
	if (relPath.startsWith("dist/") || relPath.includes("/dist/")) return false;
	if (relPath.startsWith("node_modules/") || relPath.includes("/node_modules/")) return false;
	const ext = extname(relPath).toLowerCase();
	if (BINARY_EXTENSIONS.has(ext)) return false;
	const base = basename(relPath);
	if (BLOCKED_BASENAMES.has(base)) return false;
	return true;
}

/** Public API — consumed by `verify.ts` (entry point for verify's file set). */
export function discoverFiles(root: string): string[] {
	// Try git ls-files first (respects .gitignore)
	const gitFiles = gitFileList(root);
	if (gitFiles !== null) {
		return gitFiles.filter(shouldDiscover).map((file) => join(root, file));
	}

	// Fallback: manual walk (for non-git dirs)
	const files: string[] = [];
	const skip = new Set([
		"node_modules",
		".git",
		"dist",
		"build",
		"coverage",
		"target",
		"__pycache__",
		".venv",
		"venv",
	]);
	/** Recurses into a directory entry, or collects it when it is a discoverable
	 *  file. Throws whatever `statSync` throws — `walk` owns the catch. */
	function visitEntry(dir: string, entry: string, relPrefix: string): void {
		const full = join(dir, entry);
		const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
		const stat = statSync(full);
		if (stat.isDirectory()) {
			walk(full, rel);
			return;
		}
		if (stat.isFile() && stat.size < MAX_FILE_BYTES && shouldDiscover(rel)) {
			files.push(full);
		}
	}
	function walk(dir: string, relPrefix: string): void {
		if (files.length >= MAX_WALK_ENTRIES) return;
		try {
			for (const entry of readdirSync(dir)) {
				if (skip.has(entry) || entry.startsWith(".") || entry === INTERLINKED_DIR) continue;
				visitEntry(dir, entry, relPrefix);
			}
		} catch {
			/* intentional: fall back to a filesystem walk outside git worktrees */
		}
	}
	walk(root, "");
	return files;
}

const FUNCTION_TOKEN_WALK_SKIP = new Set([
	".git",
	".interlinked",
	".claude",
	".codex",
	"node_modules",
	"dist",
	"build",
	"coverage",
	"target",
	"__pycache__",
	".venv",
	"venv",
]);

/**
 * Broader discovery for the function-token census. Git repositories return
 * every tracked/unignored path and let the shared cappable-file policy decide
 * scope. The fallback keeps hidden source directories and files >=1 MB, which
 * the ordinary verify walk omits for cost control.
 */
export function discoverFunctionTokenFiles(root: string): string[] {
	const gitFiles = gitFileList(root);
	if (gitFiles !== null) return gitFiles.map((file) => join(root, file));

	const files: string[] = [];
	function walk(dir: string): void {
		if (files.length >= MAX_WALK_ENTRIES) return;
		try {
			for (const entry of readdirSync(dir)) {
				if (FUNCTION_TOKEN_WALK_SKIP.has(entry)) continue;
				const full = join(dir, entry);
				const stat = statSync(full);
				if (stat.isDirectory()) walk(full);
				else if (stat.isFile()) files.push(full);
			}
		} catch {
			/* unreadable paths are represented only when discovery can name them */
		}
	}
	walk(root);
	return files;
}
