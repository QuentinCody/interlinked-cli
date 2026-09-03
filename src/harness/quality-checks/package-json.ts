import type { JsonObject } from "../../lib/json-types.js";

// ===========================================
// Package.json Consistency Check
// ===========================================
// Detects duplicate dependencies (same package in both dependencies and
// devDependencies) and invalid semver version specifiers.

/** Loose check for valid semver-ish version specifier (npm/yarn/pnpm). */
const SEMVER_RE =
	/^(\*|latest|next|canary|workspace:\*|workspace:\^|workspace:~|link:.+|file:.+|https?:\/\/.+|git(\+https?|\+ssh)?:\/\/.+|github:.+|npm:.+|(?:[\^~]|>=?|<=?)?\.?\d+(\.\d+){0,2}(-[\w.]+)?(\+[\w.]+)?(\s*\|\|\s*(?:[\^~]|>=?|<=?)?\.?\d+(\.\d+){0,2}(-[\w.]+)?(\+[\w.]+)?)*)$/;

interface PkgConsistencyIssue {
	kind: "duplicate" | "invalid_semver";
	pkg: string;
	detail: string;
}

/** Packages listed in both dependencies and devDependencies. */
function findDuplicateDeps(
	deps: Record<string, string>,
	devDeps: Record<string, string>,
): PkgConsistencyIssue[] {
	const issues: PkgConsistencyIssue[] = [];
	for (const pkg of Object.keys(deps)) {
		if (pkg in devDeps) {
			issues.push({
				kind: "duplicate",
				pkg,
				detail: `"${pkg}" in both dependencies (${deps[pkg]}) and devDependencies (${devDeps[pkg]})`,
			});
		}
	}
	return issues;
}

/** Entries of one dependency section whose version specifier is not semver-ish. */
function findInvalidSemverInSection(
	section: string,
	sectionDeps: Record<string, string>,
): PkgConsistencyIssue[] {
	const issues: PkgConsistencyIssue[] = [];
	for (const [pkg, version] of Object.entries(sectionDeps)) {
		if (typeof version !== "string") continue;
		if (!SEMVER_RE.test(version.trim())) {
			issues.push({
				kind: "invalid_semver",
				pkg,
				detail: `"${pkg}": "${version}" in ${section} is not a valid version specifier`,
			});
		}
	}
	return issues;
}

/**
 * Public API — consumed by quality-checks.runQualityChecks and verify.ts.
 *
 * Parse package.json content and check for consistency issues:
 * - Same package in both dependencies and devDependencies
 * - Invalid semver version specifiers
 */
export function checkPackageJsonConsistency(content: string): PkgConsistencyIssue[] {
	const issues: PkgConsistencyIssue[] = [];

	let parsed: JsonObject;
	try {
		parsed = JSON.parse(content);
	} catch {
		return []; // Malformed JSON — JSON syntax checks handle this elsewhere
	}

	const deps = parsed.dependencies as Record<string, string> | undefined;
	const devDeps = parsed.devDependencies as Record<string, string> | undefined;
	const peerDeps = parsed.peerDependencies as Record<string, string> | undefined;
	const optDeps = parsed.optionalDependencies as Record<string, string> | undefined;

	// 1. Duplicate detection: same package in both deps and devDeps
	if (deps && devDeps) {
		issues.push(...findDuplicateDeps(deps, devDeps));
	}

	// 2. Invalid semver across all dependency sections
	const allSections: [string, Record<string, string> | undefined][] = [
		["dependencies", deps],
		["devDependencies", devDeps],
		["peerDependencies", peerDeps],
		["optionalDependencies", optDeps],
	];

	for (const [section, sectionDeps] of allSections) {
		if (!sectionDeps) continue;
		issues.push(...findInvalidSemverInSection(section, sectionDeps));
	}

	return issues;
}
