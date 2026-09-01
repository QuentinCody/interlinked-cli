// ===========================================
// Language Profiles — Multi-language support
// ===========================================
// Defines per-language toolchain profiles: type checkers, linters, test runners,
// and inline code-quality checks. Used by the harness evaluator to run the
// correct quality checks for whatever language a file belongs to.

import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { LANGUAGE_EXTENSION_MAP, LANGUAGE_PROFILES } from "./language-profiles-data.js";
import type { LanguageId, LanguageProfile } from "./types.js";

// ===========================================
// Helper Functions
// ===========================================

/**
 * Detect the language of a file by its extension.
 * Returns null if the extension is not recognised.
 */
function detectLanguage(filePath: string): LanguageId | null {
	const ext = extname(filePath).toLowerCase();
	return LANGUAGE_EXTENSION_MAP[ext] ?? null;
}

/**
 * Return the full language profile for a file, or null if unrecognised.
 */
export function getProfileForFile(filePath: string): LanguageProfile | null {
	const lang = detectLanguage(filePath);
	if (!lang) return null;
	return LANGUAGE_PROFILES[lang];
}

/**
 * Walk up the directory tree from `startPath` looking for any of the
 * profile's `project_root_markers`. Returns the first directory that
 * contains a marker, or null if none is found (stops at filesystem root).
 */
export function findProjectRootForLanguage(
	startPath: string,
	profile: LanguageProfile,
): string | null {
	let dir = resolve(startPath);

	// If startPath is a file, begin from its parent directory
	try {
		// extname returns "" for directories — quick heuristic
		if (extname(dir) !== "") {
			dir = dirname(dir);
		}
	} catch {
		// resolve/dirname failed — bail out
		return null;
	}

	const root = resolve("/");

	for (;;) {
		for (const marker of profile.project_root_markers) {
			if (existsSync(join(dir, marker))) {
				return dir;
			}
		}

		const parent = dirname(dir);
		if (parent === dir || parent === root) {
			// Reached filesystem root without finding a marker
			return null;
		}
		dir = parent;
	}
}
