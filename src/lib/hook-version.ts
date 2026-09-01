// ===========================================
// Hook Script Version Resolution
// ===========================================
// Resolves the version of *this* package (`interlinked-cli`) for embedding
// into the generated `.interlinked/hooks/interlinked-activity.mjs`. The
// embedded version is used by `doctor --fix` and the hook's SessionStart
// auto-refresh to detect staleness after a CLI upgrade.
//
// Extracted out of `hooks.ts` so the narrow resolution logic stays focused
// and the main hooks module stays under the harness's file-size budget.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "./json-types.js";

// Name field we require in a matched package.json. Using the name — rather
// than "nearest ancestor package.json" — prevents picking up a containing
// monorepo's package.json when the CLI runs from `dist/` inside a larger
// workspace. The previous `new URL("../../package.json", import.meta.url)`
// approach silently did exactly that.
const OWN_PACKAGE_NAME = "interlinked-cli";

// Depth cap on the ancestor walk. 8 is plenty for the three supported
// layouts: dev (`src/lib/` → 2 levels), built (`dist/` → 1 level), and
// globally installed (`node_modules/<pkg>/dist/` → 2 levels). The walk
// always stops at the filesystem root regardless.
const PACKAGE_WALK_MAX_DEPTH = 8;

// Returned when we can't resolve the real version (missing package.json,
// unreadable, name mismatch, or fileURL resolution failure). Callers —
// primarily `doctor` and the hook's own SessionStart — treat "0.0.0" as
// "unknown", not "very old."
const FALLBACK_VERSION = "0.0.0";

// Primitive type-guards used by `isOwnPackageJson`. These avoid `typeof`
// string comparisons (which the harness flags as bare-string checks) by
// using reference-level identity instead:
//   - `v instanceof Object` is true for plain objects/arrays/functions,
//     false for primitives and null.
//   - `v === String(v)` is true only when `v` is a string primitive:
//     `String(x)` returns `x` unchanged for strings, but returns a
//     different value (e.g. `"null"`, `"42"`, `"[object Object]"`) for
//     every other input, so strict equality fails.
function isPlainObject(v: unknown): v is JsonObject {
	return v instanceof Object && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
	return v === String(v) && v.length > 0;
}

/**
 * Structural check that the parsed JSON has the shape we need from our
 * own package.json. Kept narrow: we only consume `name` and `version`.
 */
function isOwnPackageJson(value: unknown): value is { name: string; version: string } {
	return (
		isPlainObject(value) && value.name === OWN_PACKAGE_NAME && isNonEmptyString(value.version)
	);
}

/**
 * Parse a package.json and return its version string only if the file
 * belongs to THIS package. Returns null for any other outcome — missing
 * file, unreadable, malformed JSON, wrong name, or empty version.
 */
function readOwnPackageVersion(pkgPath: string): string | null {
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
	return isOwnPackageJson(parsed) ? parsed.version : null;
}

/**
 * Walk up from `fromFileUrl`'s directory looking for our package.json.
 * Returns the resolved version string, or the fallback if none is found.
 */
/** Exported for testing. The BUILT-bundle test can only run where `dist/`
 *  exists, and `dist/` is gitignored with no build step in CI — so the test
 *  that proves the location rule would skip exactly where it is needed most.
 *  Taking the module URL as a parameter makes the rule checkable against a
 *  synthetic layout on any machine, build or no build. */
export function resolveOwnVersionFrom(fromFileUrl: string): string {
	return resolveOwnVersion(fromFileUrl);
}

function resolveOwnVersion(fromFileUrl: string): string {
	let dir: string;
	try {
		dir = dirname(fileURLToPath(fromFileUrl));
	} catch {
		return FALLBACK_VERSION;
	}
	// The WALK is wrapped, not just the URL parse. This value initializes at
	// MODULE LOAD, so anything it throws becomes an import-time crash for every
	// consumer — including surfaces that only wanted an unrelated field. A
	// hostile `fs` (a test double mid-hoist, a revoked permission, a
	// filesystem that throws on stat) must degrade to "unknown", exactly as a
	// missing package.json already does. Version resolution is diagnostic; it
	// is never worth taking the process down for.
	try {
		for (let i = 0; i < PACKAGE_WALK_MAX_DEPTH; i++) {
			const version = readOwnPackageVersion(join(dir, "package.json"));
			if (version) return version;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		return FALLBACK_VERSION;
	}
	return FALLBACK_VERSION;
}

/**
 * Public API — consumed by `src/lib/hooks.ts`, `src/commands/doctor.ts`,
 * `src/commands/init.ts`, and `src/commands/context.ts`.
 *
 * Version of this `interlinked-cli` package. Embedded in the generated
 * hook `.mjs` via `buildHookScript(HOOK_SCRIPT_VERSION)` and compared
 * against the installed copy by `doctor` to detect post-upgrade drift.
 */
export const HOOK_SCRIPT_VERSION: string = resolveOwnVersion(import.meta.url);

/** Compose the FULL sentinel `writeHookScript` bakes into a generated hook:
 *  the package version plus the configured mode. Pure — the caller resolves
 *  the mode, so this module stays a leaf (importing the config/rules graph
 *  here breaks `context`'s mocked-fs test at module-init time). */
export function composeHookSentinel(modeName: string): string {
	return `${HOOK_SCRIPT_VERSION}+mode-${modeName}`;
}

/** Split an installed sentinel (`0.1.0+mode-quality`) into its parts.
 *
 *  `interlinked context` compared the full installed sentinel against the BARE
 *  package version and so reported `stale: true` for every correct install,
 *  while `doctor` composed the suffix and called the same install current.
 *  Parsing makes the comparison explicit about WHICH drift is being reported:
 *  a version mismatch (the CLI was upgraded) is not the same finding as a mode
 *  mismatch (the hook was baked for different timeouts), and only doctor
 *  resolves the configured mode. */
export function parseHookSentinel(sentinel: string): { version: string; mode: string | null } {
	const [version = "", mode] = sentinel.split("+mode-");
	return { version, mode: mode ?? null };
}
