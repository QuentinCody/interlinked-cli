/**
 * Repo-profile detection — drives conditional enforcement for the TDD/coverage
 * gate family. The gates were written against this repo's colocated-vitest
 * workflow; on foreign-shaped repos (separate test trees, non-vitest/pytest
 * stacks) they misfire. This module detects the repo's actual shape with a
 * bounded filesystem scan so callers can scope enforcement.
 *
 * Guarantees:
 * - Pure detection: NEVER runs a test suite, never spawns a process.
 * - Bounded work: skips vendor dirs, depth-capped, entry-budgeted.
 * - Never throws: any fs error yields the fail-toward-enforcement profile
 *   (runners on, colocated) so enforcement never silently disables on a
 *   transient error. A bounded-scan truncation (depth/entry cap) is handled
 *   the same way — an otherwise-unknown layout resolves to the ENFORCING
 *   "colocated" (never "none") and sets `scanTruncated`, so enforcement is
 *   not silently disabled on the large/deep repos this scan exists for.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface RepoProfile {
	/** Supported test runner detectable. */
	runners: { js: boolean; python: boolean };
	/** Where tests live. */
	testLayout: "colocated" | "separate-tree" | "none";
	/** Repo-relative roots like ["test", "tests"] when separate-tree. */
	testDirRoots: string[];
	/** ISO timestamp of detection. */
	detectedAt: string;
	/**
	 * The bounded scan hit its depth/entry cap, so the walk was partial. When
	 * set, `testLayout` was resolved TOWARD enforcement ("colocated", never
	 * "none") because a partial scan cannot prove the repo is test-free.
	 */
	scanTruncated?: boolean;
}

/** Directories never descended into (vendor/build output — huge and irrelevant). */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor"]);
/** Top-level directory names treated as separate test trees. */
const TEST_DIR_ROOTS = ["test", "tests", "__tests__"];
/** Depth cap for the directory walk (root = depth 0). */
const MAX_WALK_DEPTH = 6;
/** Total dirent budget so giant repos stay fast. */
const MAX_WALK_ENTRIES = 2000;

const JS_TEST_FILE = /\.(test|spec)\./;
const PY_TEST_FILE = /^test_.*\.py$/;

const JS_RUNNER_CONFIG_FILES = [
	"vitest.config.ts",
	"vitest.config.js",
	"vitest.config.mts",
	"vitest.config.mjs",
	"vitest.config.cts",
	"vitest.config.cjs",
	"vitest.workspace.ts",
	"jest.config.ts",
	"jest.config.js",
	"jest.config.mjs",
	"jest.config.cjs",
	"jest.config.json",
];

interface WalkResult {
	/** A *.test.* / *.spec.* file exists outside every top-level test root. */
	colocatedTestFile: boolean;
	/** Top-level test roots that actually contain test files. */
	rootsWithTests: Set<string>;
	/** A test_*.py exists under a top-level test root (pytest layout signal). */
	pythonTestUnderTestRoot: boolean;
	/**
	 * The walk hit the depth or entry cap and returned partial results. A
	 * truncated walk that found no tests must NOT be reported as "none".
	 */
	truncated?: boolean;
}

function shouldSkipDir(name: string): boolean {
	return SKIP_DIRS.has(name) || name.startsWith(".");
}

function recordFile(name: string, testRoot: string | null, out: WalkResult): void {
	const isJsTest = JS_TEST_FILE.test(name);
	const isPyTest = PY_TEST_FILE.test(name);
	if (testRoot === null) {
		if (isJsTest) out.colocatedTestFile = true;
		return;
	}
	if (isJsTest || isPyTest) out.rootsWithTests.add(testRoot);
	if (isPyTest) out.pythonTestUnderTestRoot = true;
}

/**
 * Single bounded walk collecting every layout fact at once. Throws on fs
 * errors (unreadable root/subdir) — the caller maps that to the
 * fail-toward-enforcement profile. On a depth/entry-cap breach it sets
 * `out.truncated` (partial results) rather than throwing, so the caller can
 * fail toward enforcement instead of misreading a partial scan as "none".
 */
function walkForTests(projectRoot: string): WalkResult {
	const out: WalkResult = {
		colocatedTestFile: false,
		rootsWithTests: new Set<string>(),
		pythonTestUnderTestRoot: false,
	};
	const stack: Array<{ dir: string; depth: number; testRoot: string | null }> = [
		{ dir: projectRoot, depth: 0, testRoot: null },
	];
	let budget = MAX_WALK_ENTRIES;
	while (stack.length > 0) {
		const frame = stack.pop();
		if (frame === undefined) break;
		for (const entry of readdirSync(frame.dir, { withFileTypes: true })) {
			budget -= 1;
			if (budget < 0) {
				// Entry-budget exhausted: results are partial. Flag it so the
				// caller fails toward enforcement instead of reporting "none".
				out.truncated = true;
				return out;
			}
			if (entry.isDirectory()) {
				// Vendor/build/dot dirs are excluded BY DESIGN — not truncation.
				if (shouldSkipDir(entry.name)) continue;
				// Depth cap prunes this subtree: whatever is below is unseen, so
				// the walk is partial. Flag it (distinct from the skip above).
				if (frame.depth + 1 > MAX_WALK_DEPTH) {
					out.truncated = true;
					continue;
				}
				const enteringTestRoot =
					frame.depth === 0 && TEST_DIR_ROOTS.includes(entry.name) ? entry.name : frame.testRoot;
				stack.push({
					dir: join(frame.dir, entry.name),
					depth: frame.depth + 1,
					testRoot: enteringTestRoot,
				});
			} else if (entry.isFile()) {
				recordFile(entry.name, frame.testRoot, out);
			}
		}
	}
	return out;
}

function readDependencyNames(pkg: Record<string, unknown>, key: string): string[] {
	const section = pkg[key];
	if (typeof section !== "object" || section === null) return [];
	return Object.keys(section);
}

/** vitest or jest declared in package.json dependencies/devDependencies. */
function packageJsonDeclaresJsRunner(projectRoot: string): boolean {
	const pkgPath = join(projectRoot, "package.json");
	if (!existsSync(pkgPath)) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(pkgPath, "utf8"));
	} catch {
		// Unreadable/malformed package.json (possibly mid-edit): fail toward
		// enforcement — assume a JS runner rather than silently disabling gates.
		return true;
	}
	if (typeof parsed !== "object" || parsed === null) return false;
	const pkg = parsed as Record<string, unknown>;
	const names = [
		...readDependencyNames(pkg, "dependencies"),
		...readDependencyNames(pkg, "devDependencies"),
	];
	return names.includes("vitest") || names.includes("jest");
}

function detectJsRunner(projectRoot: string): boolean {
	if (packageJsonDeclaresJsRunner(projectRoot)) return true;
	return JS_RUNNER_CONFIG_FILES.some((f) => existsSync(join(projectRoot, f)));
}

function fileContains(path: string, needle: string): boolean {
	if (!existsSync(path)) return false;
	return readFileSync(path, "utf8").includes(needle);
}

function detectPythonRunner(projectRoot: string, pythonTestUnderTestRoot: boolean): boolean {
	if (pythonTestUnderTestRoot) return true;
	if (existsSync(join(projectRoot, "pytest.ini"))) return true;
	if (fileContains(join(projectRoot, "pyproject.toml"), "[tool.pytest")) return true;
	return fileContains(join(projectRoot, "setup.cfg"), "[tool:pytest]");
}

function resolveTestLayout(walk: WalkResult): RepoProfile["testLayout"] {
	if (walk.colocatedTestFile) return "colocated";
	if (walk.rootsWithTests.size > 0) return "separate-tree";
	// A truncated walk that saw no tests cannot prove the repo is test-free.
	// Fail TOWARD enforcement: resolve the unknown layout to "colocated" (which
	// keeps the TDD gate blocking) rather than "none" (which demotes it to
	// advisory) — the whole point of this bounded scan is large/deep repos.
	if (walk.truncated) return "colocated";
	return "none";
}

/**
 * Conservative profile returned on any fs error: enforcement must NEVER
 * silently disable on a transient failure, so fail toward current behavior
 * (all runners assumed present, colocated layout).
 */
function failTowardEnforcementProfile(detectedAt: string): RepoProfile {
	return {
		runners: { js: true, python: true },
		testLayout: "colocated",
		testDirRoots: [],
		detectedAt,
	};
}

/**
 * Detect the repo profile with one bounded scan. Pure detection — never runs
 * a test suite, never throws.
 */
export function detectRepoProfile(projectRoot: string): RepoProfile {
	const detectedAt = new Date().toISOString();
	try {
		const walk = walkForTests(projectRoot);
		return {
			runners: {
				js: detectJsRunner(projectRoot),
				python: detectPythonRunner(projectRoot, walk.pythonTestUnderTestRoot),
			},
			testLayout: resolveTestLayout(walk),
			testDirRoots: [...walk.rootsWithTests].sort(),
			detectedAt,
			scanTruncated: walk.truncated === true,
		};
	} catch {
		return failTowardEnforcementProfile(detectedAt);
	}
}

const profileCache = new Map<string, RepoProfile>();

/** Memoized per resolved root for the daemon lifetime. */
export function getRepoProfile(projectRoot: string): RepoProfile {
	const key = resolve(projectRoot);
	const cached = profileCache.get(key);
	if (cached !== undefined) return cached;
	const profile = detectRepoProfile(projectRoot);
	profileCache.set(key, profile);
	return profile;
}

/** Clear the memo (for tests). */
export function resetRepoProfileCache(): void {
	profileCache.clear();
}
