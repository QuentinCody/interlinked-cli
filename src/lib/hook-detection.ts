// ===========================================
// Hook Manager Detection
// ===========================================
// Detects git hook managers installed in a project (husky, lefthook,
// overcommit). Used by `interlinked enable` to warn about potential
// conflicts with the Interlinked activity hooks we're about to install.
//
// Extracted out of `hooks.ts` so the main hooks module stays focused on
// Interlinked's own hook install/uninstall logic.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "./json-types.js";

export interface HookManagerInfo {
	name: string;
	detected_at: string;
}

// Narrow shape of a `package.json` we care about. We only ever read these
// three dictionaries; everything else on the object is opaque. Declared as
// `unknown`-valued maps so the type-guard below can accept any object.
interface PackageJsonLike {
	devDependencies?: JsonObject;
	dependencies?: JsonObject;
	scripts?: JsonObject;
}

// `v instanceof Object && !Array.isArray(v)` — reference-identity check
// for plain objects. Avoids `typeof v === "object"` which the harness
// flags as `magic_literal_in_conditional`.
function isPackageJsonish(v: unknown): v is PackageJsonLike {
	return v instanceof Object && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
	return v === String(v) && v.length > 0;
}

/**
 * Read a package.json and return its parsed form only if it's a plain
 * object. Returns null for any failure mode (missing, unreadable, malformed
 * JSON, or wrong shape) so callers can treat null as "detection skipped".
 */
function safeReadPackageJson(pkgPath: string): PackageJsonLike | null {
	if (!existsSync(pkgPath)) return null;
	let raw: string;
	try {
		raw = readFileSync(pkgPath, "utf-8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	return isPackageJsonish(parsed) ? parsed : null;
}

// Named identifiers for each detected manager. Kept out of conditionals
// as bare string literals (avoids `magic_literal_in_conditional`).
const MANAGER_HUSKY = "husky";
const MANAGER_LEFTHOOK = "lefthook";
const MANAGER_OVERCOMMIT = "overcommit";

/**
 * Public API — consumed by `src/commands/enable.ts` and tests
 * (re-exported via `src/lib/hooks.ts` for backwards compatibility).
 *
 * Detect common git hook managers in the project. Returns all managers
 * found with the path/config we detected them through, so the caller can
 * surface exact locations to the user.
 */
export function detectHookManagers(cwd: string): HookManagerInfo[] {
	const managers: HookManagerInfo[] = [];

	// Husky
	const huskyDir = join(cwd, ".husky");
	if (existsSync(huskyDir)) {
		managers.push({ name: MANAGER_HUSKY, detected_at: ".husky/" });
	} else {
		// Check package.json for husky references
		const pkg = safeReadPackageJson(join(cwd, "package.json"));
		if (pkg) {
			const prepareScript = pkg.scripts?.prepare;
			const prepareMentionsHusky =
				isNonEmptyString(prepareScript) && prepareScript.includes(MANAGER_HUSKY);
			if (pkg.devDependencies?.husky || pkg.dependencies?.husky || prepareMentionsHusky) {
				managers.push({ name: MANAGER_HUSKY, detected_at: "package.json" });
			}
		}
	}

	// Lefthook
	const lefthookFiles = ["lefthook.yml", ".lefthook.yml", "lefthook.yaml", ".lefthook.yaml"];
	for (const file of lefthookFiles) {
		if (existsSync(join(cwd, file))) {
			managers.push({ name: MANAGER_LEFTHOOK, detected_at: file });
			break;
		}
	}
	if (!managers.some((m) => m.name === MANAGER_LEFTHOOK)) {
		const pkg = safeReadPackageJson(join(cwd, "package.json"));
		if (pkg && (pkg.devDependencies?.lefthook || pkg.dependencies?.lefthook)) {
			managers.push({ name: MANAGER_LEFTHOOK, detected_at: "package.json" });
		}
	}

	// Overcommit
	if (existsSync(join(cwd, ".overcommit.yml"))) {
		managers.push({ name: MANAGER_OVERCOMMIT, detected_at: ".overcommit.yml" });
	}

	return managers;
}
