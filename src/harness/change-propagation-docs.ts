// interlinked-tdd: exempt
// ===========================================
// Change Propagation — Documentation category helpers + shared types
// ===========================================
// Extracted from change-propagation.ts to keep the orchestrator under the
// per-file line cap. Pure leaf helpers: each takes the shared PropagationCtx
// and returns the documentation propagation targets it found. No dependency on
// the orchestrator (no circular import).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ===========================================
// Types (shared with the orchestrator)
// ===========================================

export interface PropagationTarget {
	/** File that may need updating */
	file: string;
	/** Why this file may need updating */
	reason: string;
	/** Category of relationship */
	category:
		| "documentation"
		| "schema"
		| "test"
		| "config"
		| "contract"
		| "dependency"
		| "generated";
	/** How confident we are (high = definitely needs update, low = maybe check) */
	confidence: "high" | "medium" | "low";
}

/** Pre-computed path context shared by every category helper. */
export interface PropagationCtx {
	/** Absolute path of the file that was edited. */
	editedFile: string;
	/** Repo root the scan is relative to. */
	cwd: string;
	/** `relative(cwd, editedFile)`. */
	rel: string;
	/** `basename(editedFile)`. */
	name: string;
	/** `extname(editedFile)`. */
	ext: string;
	/** `dirname(editedFile)`. */
	dir: string;
	/** `basename(editedFile, ext)`. */
	nameNoExt: string;
}

// ===========================================
// 1. DOCUMENTATION category helpers
// ===========================================

/** 1. DOCUMENTATION — README in same dir / parent / root (one hit per name). */
export function docReadme(c: PropagationCtx): PropagationTarget[] {
	const targets: PropagationTarget[] = [];
	for (const readmeName of ["README.md", "readme.md", "README.rst", "README"]) {
		const sameDir = join(c.dir, readmeName);
		const parentDir = join(dirname(c.dir), readmeName);
		const rootDir = join(c.cwd, readmeName);
		for (const candidate of [sameDir, parentDir, rootDir]) {
			if (existsSync(candidate) && candidate !== c.editedFile) {
				targets.push({
					file: candidate,
					reason: `README may reference ${c.rel} — update if API, usage, or behavior changed`,
					category: "documentation",
					confidence: "low",
				});
				break; // One README per level is enough
			}
		}
	}
	return targets;
}

/** 1. DOCUMENTATION — first matching CHANGELOG at repo root. */
export function docChangelog(c: PropagationCtx): PropagationTarget[] {
	for (const changelogName of ["CHANGELOG.md", "changelog.md", "CHANGES.md", "HISTORY.md"]) {
		const changelog = join(c.cwd, changelogName);
		if (existsSync(changelog)) {
			return [
				{
					file: changelog,
					reason: `CHANGELOG should document this change to ${c.rel}`,
					category: "documentation",
					confidence: "low",
				},
			];
		}
	}
	return [];
}

/** 1. DOCUMENTATION — docs/ files that mention the module name or rel path. */
export function docDocsDir(c: PropagationCtx): PropagationTarget[] {
	const docsDir = join(c.cwd, "docs");
	if (!existsSync(docsDir)) return [];
	const targets: PropagationTarget[] = [];
	try {
		const docFiles = findFilesRecursive(docsDir, [".md", ".mdx", ".rst", ".txt"], 3);
		for (const docFile of docFiles) {
			try {
				const content = readFileSync(docFile, "utf-8");
				if (content.includes(c.nameNoExt) || content.includes(c.rel)) {
					targets.push({
						file: docFile,
						reason: `Documentation references "${c.nameNoExt}" — verify it's still accurate`,
						category: "documentation",
						confidence: "medium",
					});
				}
			} catch (e) {
				void e;
			}
		}
	} catch (e) {
		void e;
	}
	return targets;
}

/** 1. DOCUMENTATION — CLAUDE.md (root + same dir) that references the file. */
export function docClaudeMd(c: PropagationCtx): PropagationTarget[] {
	const targets: PropagationTarget[] = [];
	for (const claudeMd of [join(c.cwd, "CLAUDE.md"), join(c.dir, "CLAUDE.md")]) {
		if (existsSync(claudeMd)) {
			try {
				const content = readFileSync(claudeMd, "utf-8");
				if (content.includes(c.nameNoExt) || content.includes(c.rel)) {
					targets.push({
						file: claudeMd,
						reason: `CLAUDE.md references "${c.nameNoExt}" — update if behavior or API changed`,
						category: "documentation",
						confidence: "high",
					});
				}
			} catch (e) {
				void e;
			}
		}
	}
	return targets;
}

// ===========================================
// Shared helper
// ===========================================

function findFilesRecursive(
	dir: string,
	extensions: string[],
	maxDepth: number,
	depth = 0,
): string[] {
	if (depth >= maxDepth) return [];
	const results: string[] = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (
				entry.isDirectory() &&
				!entry.name.startsWith(".") &&
				entry.name !== "node_modules"
			) {
				results.push(...findFilesRecursive(full, extensions, maxDepth, depth + 1));
			} else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
				results.push(full);
			}
		}
	} catch (e) {
		void e;
	}
	return results;
}
