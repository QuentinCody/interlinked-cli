// Test-file / harness-internal-data-file classification helpers extracted
// from shared.ts (no behavior change). Re-exported by shared.ts so existing
// importers keep resolving these from "./shared.js".

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the interlinked-cli package root once, lazily, by walking up from
 * this module's location until we hit a `package.json` whose `name` matches.
 * Used to scope harness-internal test-file exemptions to OUR files only —
 * a user repo that happens to have a `harness/rules/` directory must not
 * silently inherit the exemption.
 *
 * Returns `null` when the package root can't be located (unusual install
 * paths, broken layouts). Treated as fail-closed by callers: when null,
 * the exemption never fires.
 */
let _packageRootCache: string | null | undefined;
function resolveInterlinkedCliPackageRoot(): string | null {
	if (_packageRootCache !== undefined) return _packageRootCache;
	try {
		const moduleDir = dirname(fileURLToPath(import.meta.url));
		let dir = moduleDir;
		// Bound the walk so a runaway loop on weird filesystems can't hang.
		// 8 hops is comfortably more than any realistic install layout
		// (`<root>/dist/harness/checks/` is 4; npm/pnpm symlinked layouts
		// add a couple more).
		for (let i = 0; i < 8; i++) {
			const pkgPath = join(dir, "package.json");
			if (existsSync(pkgPath)) {
				try {
					// `JSON.parse` returns `any` — a malformed package.json (an array,
					// a bare string, or literal `null`) can genuinely produce a
					// non-object here, so the cast stays nullable and the `pkg &&`
					// guard below is load-bearing, not decorative.
					const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
						name?: unknown;
					} | null;
					if (pkg && pkg.name === "interlinked-cli") {
						_packageRootCache = dir;
						return dir;
					}
				} catch (e) {
					// Malformed package.json — keep walking. Swallowing here
					// matches the resolver's contract (returns null on
					// failure); callers fail-closed.
					void e;
				}
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch (e) {
		// `import.meta.url` resolution failure — extremely rare, but if it
		// happens we silently fall through to fail-closed (returns null).
		void e;
	}
	_packageRootCache = null;
	return null;
}

/**
 * Test-only override hook for the package-root cache. Lets unit tests
 * exercise both the "we are running on interlinked-cli source" and the
 * "we are running on a user repo" branches without filesystem mutation.
 */
export function __setPackageRootForTesting(root: string | null | undefined): void {
	_packageRootCache = root;
}

/**
 * Check if a file path looks like a test file.
 * Matches common conventions across languages:
 * - Python: `test_*.py`, `*_test.py`
 * - Go: `*_test.go`
 * - JS/TS: `*.test.ts`, `*.spec.ts`, `*.test.js`, `*.spec.js`
 * - Directories: `__tests__/`, `tests/`, `src/test/`
 *
 * Also returns true for our own harness rule-definition and check-registry
 * files. Those files contain dangerous-looking patterns AS DATA (regex
 * strings about shell commands, registry of patterns we want to detect,
 * `chmod 777` examples in rule descriptions) — content-quality scans on
 * them produce only false positives. Treating them as test-equivalents
 * means every detector that already exempts test files also exempts the
 * rules registry without each one having to re-implement the check.
 *
 * The harness-internals exemption is scoped to interlinked-cli's own
 * package via `resolveInterlinkedCliPackageRoot()`. A user project whose
 * source happens to live under `harness/rules/` or `harness/check-registry/`
 * does NOT inherit the exemption.
 */
/** interlinked-cli's OWN detector / data source files, where dangerous-looking
 *  or test-like patterns appear AS DATA (regex catalogs, rule descriptions,
 *  secret-shaped example strings, the STUB_PATTERNS regexes). Scoped to the
 *  package's own root (resolved once via `resolveInterlinkedCliPackageRoot`) so
 *  a user repo with its own `harness/rules/` directory is unaffected.
 *  Fail-closed: when the resolver returns null, the exemption never fires.
 *
 *  Content scans gate `if (isTestFile) return []`, so routing these files
 *  through the broad `isTestFile` makes those scans skip them. But test-hygiene
 *  checks gate the OPPOSITE way (`if (!isStrictTestFile) return []`), so they
 *  must NOT see these as test files — that conflation is what made
 *  `duplicate_test_names` fire on the `it.skip(` examples inside
 *  verification-stop-checks.ts. Hence the strict/broad split. */
function isHarnessInternalDataFile(filePath: string): boolean {
	const raw = filePath.replace(/\\/g, "/");
	// Resolve a RELATIVE path against cwd before prefix-matching. Without this,
	// the exemption only ever fired for an ABSOLUTE caller — measured (plan
	// `docs/plans/16-monotonic-quality-enforcement.md` §11.3): 217 harness-
	// internal files exempt when addressed absolutely, 0 when addressed
	// relatively, so a relative-path caller silently lost the exemption. A
	// relative path here is only ever meaningful relative to THIS package's
	// own checkout (the exemption concerns interlinked-cli's own source), so
	// cwd is the correct base. Absolute inputs are left untouched.
	const normalized = isAbsolute(raw) ? raw : resolve(raw).replace(/\\/g, "/");
	const pkgRoot = resolveInterlinkedCliPackageRoot();
	if (!pkgRoot || !normalized.startsWith(`${pkgRoot.replace(/\\/g, "/")}/`)) {
		return false;
	}
	return (
		normalized.includes("/harness/rules/") ||
		normalized.includes("/harness/check-registry/") ||
		normalized.includes("/harness/check-metadata") ||
		// The whole checks/ tree is detector implementations: each file holds
		// the very patterns it detects (test-card numbers, fake-data strings,
		// chmod/SQL/ReDoS examples) AS DATA, so the regex-driven content-quality
		// scans only ever false-positive on them. Covers shared.ts (home of
		// this very exemption) too.
		normalized.includes("/harness/checks/") ||
		// `write-content-guards.ts` was decomposed into `write-content-guards-*.ts`
		// siblings (e.g. `-content-quality`). Match the whole family (no trailing
		// dot) so every guard module — each holding chmod / CORS / eval / JSON.parse
		// patterns AS DATA — is exempt, not just the orchestrator. Without this, the
		// decomposed `-content-quality.ts` self-FPs on its own detection literals.
		normalized.includes("/harness/evaluator/write-content-guards") ||
		// signatures.ts re-exports the rule tables; signatures-patterns.ts is
		// where the PI regexes + descriptions actually live (e.g. the
		// `/ignore (all )?(previous|prior|above) (instructions?...)/` literal
		// and the `sig-pi-system-override` text). Both hold the very patterns
		// the daemon's PI content scan matches AS DATA — editing
		// signatures-patterns.ts would otherwise trip the scan on its own
		// detection literals and block the write.
		normalized.includes("/harness/signatures-patterns.") ||
		normalized.includes("/harness/signatures.") ||
		// secret-detection.ts is the secret detector itself — its regex literals
		// and example-key references are secret-shaped strings AS DATA.
		normalized.includes("/harness/quality-checks/secret-detection.") ||
		// verification-stop-checks.ts defines STUB_PATTERNS — regexes that hold
		// "TODO" / "FIXME" / "not implemented" / "stub" as detection DATA, plus
		// `it.skip(` / `test.skip(` example strings in comments.
		normalized.includes("/harness/verification-stop-checks.") ||
		// guards-inline.ts is the inline-fallback guard TEMPLATE: its body is the
		// generated hook script and holds chmod/rm/kill regexes as DATA.
		normalized.includes("/hook-template-chunks/guards-inline.")
	);
}

/**
 * QUESTION 1 — "is this file a TEST, an oracle the runner executes?" THE
 * canonical answer (plan `docs/plans/16-monotonic-quality-enforcement.md`
 * §11.3, Audit B, "path-domain predicates — one question, N answers"). Before
 * this, three implementations answered the same question independently and
 * disagreed on corpus + synthetic-convention measurement:
 * `coverage-test-selector.ts::isTestPath` (mutation gate + manifest choke
 * point), `large-file-policy.ts::isTestOrSpecPath` (the line-cap's test
 * clause), and this file's `isStrictTestFile` (test-hygiene checks). This is
 * the UNION of all three convention lists. Widening is the SAFE direction for
 * an oracle question — excluding more files from mutation targeting /
 * baselining / the line cap only ever removes files that genuinely are test
 * files by convention; none of the three lists' conventions names product
 * code. `isTestPath` and `isTestOrSpecPath` now delegate here as thin
 * re-exports.
 *
 * `isStrictTestFile` is DELIBERATELY NOT folded into this union (unlike the
 * other two) — see its docstring below. Its ~9 consumers are test-hygiene
 * checks; unioning would also fix its real directory-anchor bug (tracked in
 * the plan) but the combined blast radius across those consumers was not
 * verified safe within this consolidation's scope, so it stays a separate,
 * open follow-up rather than a silent behavior change bundled in here.
 *
 * Directory match is anchored `(?:^|\/)`, so a TOP-LEVEL `tests/`/`test/`/
 * `__tests__/` directory addressed via a repo-relative path (no leading
 * slash) still matches — `isStrictTestFile`'s `.includes("/tests/")`
 * substring check does not anchor start-of-string, so it misses exactly this
 * case (verified against the corpus: `tests/README.md` flips purely on
 * absolute-vs-relative spelling there). The filename match accepts ANY
 * extension after `.test.`/`.spec.` (the broadest of the three original
 * lists — `isTestPath`'s convention), not just the JS/TS extension set the
 * other two restrict to.
 */
export function isTestSourcePath(relPath: string): boolean {
	const norm = relPath.replace(/\\/g, "/");
	if (/(?:^|\/)(?:__tests__|tests?)\//.test(norm)) return true;
	const name = norm.split("/").pop() ?? "";
	if (/\.(?:test|spec)\.[^/]+$/.test(name)) return true;
	if (name.startsWith("test_") && (name.endsWith(".py") || name.endsWith(".swift"))) return true;
	if (/_test\.(?:py|go)$/.test(name)) return true;
	if (/Tests?\.(?:java|swift)$/.test(name)) return true;
	return false;
}

/** STRICT test-file detection — directory + filename conventions ONLY, no
 *  harness-internal-data exemption. Use this when a check should run *only* on
 *  genuine test files (every test-hygiene / test-quality check). The broad
 *  `isPatternDataFile` (formerly `isTestFile`) additionally returns true for
 *  interlinked-cli's own data files so content scans skip them — but that
 *  exemption must NOT make a test-hygiene check fire on a data file.
 *
 *  NOT a re-export of `isTestSourcePath` above, even though both answer
 *  "is this a test file" — see that function's docstring for why the merge
 *  was deliberately deferred (known anchor bug + unverified blast radius
 *  across this function's ~9 consumers, plan §11.3). */
export function isStrictTestFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");

	// Directory-based detection
	if (
		normalized.includes("/__tests__/") ||
		normalized.includes("/tests/") ||
		normalized.includes("/src/test/")
	) {
		return true;
	}

	// Filename-based detection
	const fileName = normalized.split("/").pop() || "";

	// Python: test_*.py or *_test.py
	if (fileName.startsWith("test_") && fileName.endsWith(".py")) return true;
	if (fileName.endsWith("_test.py")) return true;

	// Go: *_test.go
	if (fileName.endsWith("_test.go")) return true;

	// JS/TS: *.test.ts, *.spec.ts, *.test.js, *.spec.js, *.test.tsx, *.spec.tsx, etc.
	if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(fileName)) return true;

	// Java: *Test.java, *Tests.java
	if (/Tests?\.java$/.test(fileName)) return true;

	// Swift: *Tests.swift, *Test.swift, test_*.swift
	if (/Tests?\.swift$/.test(fileName)) return true;
	if (fileName.startsWith("test_") && fileName.endsWith(".swift")) return true;

	return false;
}

/**
 * QUESTION 3 — "does this file hold detection patterns as DATA, so a
 * regex-driven content scan can only false-positive on it?" (plan §11.3,
 * Audit B, recommendation 3 — this is the rename that fix calls for). True
 * for genuine test files (fixtures legitimately contain test-shaped strings)
 * AND for interlinked-cli's own detector/registry source (which legitimately
 * contains dangerous-shaped strings AS DATA — pattern catalogs, rule
 * descriptions, secret-shaped examples). Content scans gate
 * `if (isPatternDataFile) return []` on this so they skip both. Checks that
 * must run ONLY on genuine test files use `isStrictTestFile` instead, so the
 * data-file exemption can't make them fire (the
 * `duplicate_test_names`-on-`verification-stop-checks` FP).
 *
 * Defined as `isStrictTestFile(p) || isHarnessInternalDataFile(p)` — NOT
 * `isTestSourcePath(p) || isHarnessInternalDataFile(p)`, even though the
 * plan's recommendation names the latter. Widening the test-half to the
 * full cross-question union would newly exempt real, currently-scanned
 * files across this predicate's ~100 content-scan call sites (concretely:
 * `test/agent-driven/run-scenario.ts` today, and any future top-level
 * `test/`/`tests/`-directory source file) — the DANGEROUS direction for a
 * security-relevant "skip this file" predicate, unlike widening a
 * test-DISCOVERY (`isTestPath`) or line-cap-exemption (`isTestOrSpecPath`)
 * question, where over-inclusion only ever drops files that are genuinely
 * test files. Auditing all ~100 callers to confirm that widening is safe
 * is out of this consolidation's scope; left as an explicit, tracked
 * follow-up rather than folded in silently.
 */
export function isPatternDataFile(filePath: string): boolean {
	return isStrictTestFile(filePath) || isHarnessInternalDataFile(filePath);
}

/**
 * @deprecated Compat alias for {@link isPatternDataFile} — the name
 * `isTestFile` is what made this predicate read as a third copy of "is this
 * a test file" (question 1) instead of the deliberately different question
 * 3 it actually answers, which is exactly the confusion that invited past
 * near-misses (the `duplicate_test_names` FP referenced above). Kept,
 * unchanged, for this predicate's ~100 existing call sites across
 * `checks/*.ts` so this consolidation does not force a tree-wide mechanical
 * rename as a side effect. New call sites should import `isPatternDataFile`
 * directly.
 */
export function isTestFile(filePath: string): boolean {
	return isPatternDataFile(filePath);
}
