// ===========================================
// Decision Surface Detector — descriptive metric
// ===========================================
// Reports which competing tools / libraries a repo already uses, per
// category. A repo with one entry per category has a narrow surface; one
// with N entries per category forces the agent to navigate N parallel
// choices on every edit.
//
// Descriptive only. The detector does not declare any tool "correct" or
// the repo's choice "wrong". It surfaces what's there so the agent — and
// the user — can see the shape of the decision landscape.
//
// Categorization map: `decision-surface-map.ts`. Sources scanned:
//   1. `package.json` dependencies / devDependencies / peerDependencies
//      / optionalDependencies, matched against `PACKAGE_ENTRIES`.
//   2. Top-level lockfile presence, matched against
//      `LOCKFILE_TO_PACKAGE_MANAGER`.
//   3. Top-level config file basenames, matched against
//      `CONFIG_FILE_ENTRIES`.
//
// Imports are NOT scanned in this pass — see
// `docs/design/decision-surface-metric.md` for the deferred design
// question on whether to add them and how.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import {
	CONFIG_FILE_ENTRIES,
	DECISION_SURFACE_CATEGORIES,
	type DecisionSurfaceCategory,
	LOCKFILE_TO_PACKAGE_MANAGER,
	PACKAGE_ENTRIES,
} from "./decision-surface-map.js";

export interface DecisionSurfaceReport {
	/** Per-category sorted list of distinct canonical tool names detected.
	 *  Always contains an entry for every category in
	 *  `DECISION_SURFACE_CATEGORIES`, even when empty. */
	byCategory: Record<DecisionSurfaceCategory, string[]>;
	/** Sum of distinct tools across all categories. A repo with `vitest`
	 *  + `eslint` + `prettier` + `npm` reports total 4. A repo that adds
	 *  `jest` to the same set reports total 5 — the agent now has to
	 *  pick between vitest and jest on every test-related edit. */
	totalSurface: number;
	/** Project root scanned. */
	projectRoot: string;
}

export interface DetectDecisionSurfaceOptions {
	/** Override file read — for tests. Returns null on missing/error. */
	readFile?: (path: string) => string | null;
	/** Override existence check — for tests. */
	exists?: (path: string) => boolean;
	/** Override top-level directory listing — for tests. Returns [] on error. */
	readdir?: (path: string) => string[];
}

/**
 * Public API — descriptive decision-surface metric.
 *
 * Reports per-category distinct tool counts. Pure function over the
 * project root; safe to call repeatedly. All FS errors are absorbed
 * (missing package.json, unreadable directory) — the relevant signal
 * source is silently dropped, the rest still run.
 */
export function detectDecisionSurface(
	projectRoot: string,
	options: DetectDecisionSurfaceOptions = {},
): DecisionSurfaceReport {
	const exists = options.exists ?? defaultExists;
	const readFile = options.readFile ?? defaultReadFile;
	const readdir = options.readdir ?? defaultReaddir;

	const buckets = makeEmptyBuckets();

	addPackageJsonSignals(projectRoot, readFile, buckets);
	addLockfileSignals(projectRoot, exists, buckets);
	addConfigFileSignals(projectRoot, readdir, buckets);

	const byCategory = Object.fromEntries(
		DECISION_SURFACE_CATEGORIES.map((c) => [c, [...buckets[c]].sort()]),
	) as Record<DecisionSurfaceCategory, string[]>;

	const totalSurface = Object.values(byCategory).reduce(
		(sum, arr) => sum + arr.length,
		0,
	);

	return { byCategory, totalSurface, projectRoot };
}

// ===========================================
// Signal extraction
// ===========================================

function addPackageJsonSignals(
	projectRoot: string,
	readFile: (path: string) => string | null,
	buckets: Record<DecisionSurfaceCategory, Set<string>>,
): void {
	const content = readFile(join(projectRoot, "package.json"));
	if (content === null) return;

	let parsed: JsonObject;
	try {
		const raw: unknown = JSON.parse(content);
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
		parsed = raw as JsonObject;
	} catch {
		return; // Malformed package.json — silently drop this source
	}

	for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
		const deps = parsed[section];
		if (deps === null || typeof deps !== "object" || Array.isArray(deps)) continue;
		for (const name of Object.keys(deps as JsonObject)) {
			const entry = PACKAGE_ENTRIES[name];
			if (!entry) continue;
			for (const cat of entry.categories) {
				buckets[cat].add(entry.canonical);
			}
		}
	}
}

function addLockfileSignals(
	projectRoot: string,
	exists: (path: string) => boolean,
	buckets: Record<DecisionSurfaceCategory, Set<string>>,
): void {
	for (const [filename, pm] of Object.entries(LOCKFILE_TO_PACKAGE_MANAGER)) {
		if (exists(join(projectRoot, filename))) {
			buckets.package_manager.add(pm);
		}
	}
}

function addConfigFileSignals(
	projectRoot: string,
	readdir: (path: string) => string[],
	buckets: Record<DecisionSurfaceCategory, Set<string>>,
): void {
	for (const basename of readdir(projectRoot)) {
		const entry = CONFIG_FILE_ENTRIES[basename];
		if (!entry) continue;
		for (const cat of entry.categories) {
			buckets[cat].add(entry.canonical);
		}
	}
}

// ===========================================
// Lockfile multiplicity — distinct hard signal
// ===========================================
// When more than one package-manager lockfile exists at the project root,
// installs are non-deterministic: which tool the next contributor runs
// decides which dependency versions land in node_modules. This is a
// configuration error, not a decision-surface count. Distinct from the
// `package_manager` bucket of `detectDecisionSurface` (which is
// descriptive); this is a binary "broken vs not" signal.
//
// Bun's two lockfile formats (`bun.lockb`, `bun.lock`) both resolve to
// the same canonical manager and do NOT count as multiplicity.

export interface LockfileMultiplicityResult {
	/** All lockfile basenames present at the project root, sorted. */
	lockfiles: string[];
	/** Distinct canonical package managers implied by `lockfiles`, sorted. */
	managers: string[];
	/** True when more than one distinct package manager is present. */
	multiplicity: boolean;
}

interface DetectLockfileMultiplicityOptions {
	/** Override existence check — for tests. */
	exists?: (path: string) => boolean;
}

/**
 * Public API — lockfile-multiplicity detector.
 *
 * Returns the set of lockfile basenames at the project root and whether
 * they imply more than one package manager. Two bun lockfile formats are
 * collapsed to a single manager (`bun`) — that's not multiplicity, it's
 * Bun's format migration.
 */
export function detectLockfileMultiplicity(
	projectRoot: string,
	options: DetectLockfileMultiplicityOptions = {},
): LockfileMultiplicityResult {
	const exists = options.exists ?? defaultExists;
	const found: string[] = [];
	const managers = new Set<string>();
	for (const [filename, pm] of Object.entries(LOCKFILE_TO_PACKAGE_MANAGER)) {
		if (exists(join(projectRoot, filename))) {
			found.push(filename);
			managers.add(pm);
		}
	}
	return {
		lockfiles: found.sort(),
		managers: [...managers].sort(),
		multiplicity: managers.size > 1,
	};
}

// ===========================================
// Defaults / utilities
// ===========================================

function makeEmptyBuckets(): Record<DecisionSurfaceCategory, Set<string>> {
	return Object.fromEntries(
		DECISION_SURFACE_CATEGORIES.map((c) => [c, new Set<string>()]),
	) as Record<DecisionSurfaceCategory, Set<string>>;
}

function defaultReadFile(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function defaultExists(path: string): boolean {
	return existsSync(path);
}

function defaultReaddir(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}
