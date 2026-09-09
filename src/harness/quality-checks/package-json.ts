import { isJsonObject } from "../../lib/json-types.js";
import { stringDependencies } from "../checks/package-dependencies.js";

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

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return []; // Malformed JSON — JSON syntax checks handle this elsewhere
	}

	if (!isJsonObject(parsed)) return [];
	const deps = stringDependencies(parsed.dependencies);
	const devDeps = stringDependencies(parsed.devDependencies);
	const peerDeps = stringDependencies(parsed.peerDependencies);
	const optDeps = stringDependencies(parsed.optionalDependencies);

	// 1. Duplicate detection: same package in both deps and devDeps
	issues.push(...findDuplicateDeps(deps, devDeps));

	// 2. Invalid semver across all dependency sections
	const allSections: [string, Record<string, string>][] = [
		["dependencies", deps],
		["devDependencies", devDeps],
		["peerDependencies", peerDeps],
		["optionalDependencies", optDeps],
	];

	for (const [section, sectionDeps] of allSections) {
		issues.push(...findInvalidSemverInSection(section, sectionDeps));
	}

	return issues;
}
