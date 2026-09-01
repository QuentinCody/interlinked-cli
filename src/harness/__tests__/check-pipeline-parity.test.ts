// ===========================================
// Parity Test: verify command vs PostToolUse check pipeline
// ===========================================
// Ensures that every inline check wired into one pipeline is also wired
// into the other. Prevents drift where a new check is added to PostToolUse
// but forgotten in `interlinked verify` (or vice versa).
//
// This test reads source files as text and extracts check function names
// via regex — no imports needed, pure static analysis.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";

const CLI_ROOT = resolve(import.meta.dirname, "../..");

// Paths relative to cli/src/
const QUALITY_CHECKS_PATH = resolve(CLI_ROOT, "harness/quality-checks.ts");
// `quality-checks.ts` was decomposed into `harness/quality-checks/` to stay
// under the file-size cap: the config-driven tool-check loop, the inline-check
// block (which holds the `buildAgentSafetyChecks` call + the `check*` imports
// from generic-checks), the ratchet comparison, and the warning formatter now
// live in these siblings. They must be concatenated for the regex extraction to
// continue seeing `buildAgentSafetyChecks` and the generic-checks imports.
const QUALITY_CHECKS_SUBMODULE_DIR = resolve(CLI_ROOT, "harness/quality-checks");
const QUALITY_CHECKS_SUBMODULES = [
	"tool-check-loop.ts",
	"inline-block.ts",
	"ratchet-comparison.ts",
	"warning-formatter.ts",
];
const CHECK_REGISTRY_DIR = resolve(CLI_ROOT, "harness/check-registry");
const VERIFY_PATH = resolve(CLI_ROOT, "commands/verify.ts");
// `verify.ts` was split across `commands/verify/` during the 2026-04 refactor.
// The parity test needs to see the concatenated source so the regex
// extraction covers the full wiring even after the split.
const VERIFY_SUBMODULE_DIR = resolve(CLI_ROOT, "commands/verify");
const VERIFY_SUBMODULES = [
	"file-checks.ts",
	// `file-checks.ts` was itself decomposed into per-group helper modules to
	// stay under the file-size cap; the `toIssues(...)` call sites now live in
	// these siblings, so they must be concatenated for the regex extraction to
	// continue seeing every wired check.
	"file-checks-agent-safety.ts",
	"file-checks-react-test.ts",
	"file-checks-ubs.ts",
	"file-checks-endpoint-laziness.ts",
	"tool-results.ts",
	"tool-results-types.ts",
	"section-table.ts",
	// `section-table.ts` was decomposed into per-group fragment files to stay
	// under the file-size cap; the `key: "..."` SectionSpec literals now live in
	// these siblings, so they must be concatenated for the regex extraction to
	// continue seeing every streaming section.
	"section-table-core.ts",
	"section-table-agent-safety.ts",
	"section-table-agent-safety-taste.ts",
	"section-table-ubs.ts",
	"section-table-batches.ts",
	"output-json.ts",
	"streaming-output.ts",
	"suggestions.ts",
	"suppressions.ts",
];

function readFullVerifySource(): string {
	const top = readFileSync(VERIFY_PATH, "utf-8");
	const subs = VERIFY_SUBMODULES.map((f) =>
		readFileSync(resolve(VERIFY_SUBMODULE_DIR, f), "utf-8"),
	);
	return [top, ...subs].join("\n");
}

/**
 * Read the concatenation of `quality-checks.ts` and the per-phase submodules it
 * was decomposed into. Mirrors `readFullVerifySource` — the regex extraction
 * needs the orchestrator plus its siblings so `buildAgentSafetyChecks` and the
 * `check*` generic-checks imports are visible even though they now live in
 * `quality-checks/inline-block.ts` rather than the orchestrator.
 */
function readFullQualityChecksSource(): string {
	const top = readFileSync(QUALITY_CHECKS_PATH, "utf-8");
	const subs = QUALITY_CHECKS_SUBMODULES.map((f) =>
		readFileSync(resolve(QUALITY_CHECKS_SUBMODULE_DIR, f), "utf-8"),
	);
	return [top, ...subs].join("\n");
}

/**
 * Read the concatenation of all check-registry source files. The registry
 * was split across entries-errors/entries-warnings/entries-taste/entries-c-cpp
 * to keep individual files under the file-size threshold; the test still
 * needs a single string to run regex extraction over.
 *
 * `entries-warnings.ts` was itself decomposed into the `entries-warnings/`
 * subdirectory for the same reason — it is now a thin barrel, so its entry
 * blocks live in the five submodules listed below. They must be concatenated
 * here so the regex extraction continues to see every registry entry.
 */
function readRegistrySources(): string {
	return [
		"entries-errors.ts",
		"entries-warnings.ts",
		"entries-warnings/agent-clarity.ts",
		"entries-warnings/code-quality.ts",
		// `code-quality.ts` was itself decomposed: its React-hooks / test-hygiene /
		// SQL second half now lives in `code-quality-extra.ts` (spread back into
		// CODE_QUALITY_ENTRIES). Concatenate it so the regex extraction continues
		// to see those entry blocks and their generic-checks imports.
		"entries-warnings/code-quality-extra.ts",
		"entries-warnings/ubs-checks.ts",
		// `ubs-checks.ts` was itself decomposed: its crypto / unpickle-wrapper /
		// external-script-SRI / Go shell-injection / GitHub-Actions / DOM-XSS
		// second half now lives in `ubs-checks-extra.ts` (spread back into
		// UBS_ENTRIES). Concatenate it so the regex extraction continues to see
		// those entry blocks and their generic-checks imports.
		"entries-warnings/ubs-checks-extra.ts",
		"entries-warnings/agent-laziness.ts",
		"entries-warnings/test-and-demo.ts",
		"entries-warnings/endpoint-security.ts",
		// Quality-frontier wave (2026-07-06..08-10). Added to the visible set
		// 2026-08-10 when homedir_write_escape landed there WITH verify wiring —
		// the file's older checks are PostToolUse-only (deferred verify batch,
		// documented in POSTTOOLUSE_ONLY_CHECKS below).
		"entries-warnings/quality-frontier.ts",
		// Type-discipline wave (2026-08-14): ported from dmmulroy/anti-slop,
		// detection algorithm only. Shipped PostToolUse-enforced only (see
		// POSTTOOLUSE_ONLY_CHECKS below) — same "deferred verify-surface
		// wiring" precedent as the quality-frontier wave above.
		"entries-warnings/type-discipline.ts",
		// Plan 25 lanes 6-8 (2026-08-17): portability lint (dynamic_code_execution,
		// builtin_prototype_mutation, float_equality_comparison) + boundary/contract
		// wave (test_contract_annotation, unvalidated_input_boundary). Shipped
		// PostToolUse-enforced only (see POSTTOOLUSE_ONLY_CHECKS below) — same
		// "deferred verify-surface wiring" precedent as the type-discipline wave above.
		"entries-warnings/portability.ts",
		"entries-warnings/boundary-contracts.ts",
		"entries-taste.ts",
		"entries-c-cpp.ts",
		"builders.ts",
	]
		.map((f) => readFileSync(resolve(CHECK_REGISTRY_DIR, f), "utf-8"))
		.join("\n");
}

// ===========================================
// Helpers: Extract check names from source
// ===========================================

/** Extract `check*` function names imported from generic-checks in a file.
 *  If the file imports from check-registry.ts (which re-exports generic-checks),
 *  also include those transitive imports. */
function extractGenericCheckImports(source: string, transitiveSource?: string): Set<string> {
	const names = new Set<string>();
	const importRegex = /import\s*\{([^}]+)\}\s*from\s*["'][^"']*generic-checks[^"']*["']/gs;
	for (const m of source.matchAll(importRegex)) {
		for (const name of nonNull(m[1]).split(",")) {
			const trimmed = name.trim().replace(/^type\s+/, "");
			if (trimmed.startsWith("check")) {
				names.add(trimmed);
			}
		}
	}
	// If the source imports from check-registry, include the registry's generic-checks imports
	if (/from\s*["'][^"']*check-registry[^"']*["']/.test(source) && transitiveSource) {
		for (const m of transitiveSource.matchAll(importRegex)) {
			for (const name of nonNull(m[1]).split(",")) {
				const trimmed = name.trim().replace(/^type\s+/, "");
				if (trimmed.startsWith("check")) {
					names.add(trimmed);
				}
			}
		}
	}
	return names;
}

/** Extract check names used in the agentSafetyChecks array in quality-checks.ts.
 *  If agentSafetyChecks is built via buildAgentSafetyChecks() from check-registry,
 *  extract IDs from the registry source instead. */
function extractAgentSafetyCheckNames(source: string, registrySource?: string): Set<string> {
	const names = new Set<string>();

	// Strategy 1: inline array literal (legacy) — only matches when the assignment
	// contains an array literal `= [` (not a function call like buildAgentSafetyChecks)
	const arrayMatch = source.match(/const\s+agentSafetyChecks[^=]*=\s*\[[\s\S]*?\];/);
	if (arrayMatch) {
		for (const m of arrayMatch[0].matchAll(/name:\s*["'](\w+)["']/g)) {
			names.add(nonNull(m[1]));
		}
		return names;
	}

	// Strategy 2: registry-based (buildAgentSafetyChecks call detected)
	// The registry is split across multiple entries-*.ts files, each exporting
	// an ENTRIES array (ERROR_ENTRIES, WARNING_ENTRIES, TASTE_ENTRIES,
	// C_CPP_ENTRIES). Concatenate them and extract id/pipeline pairs by
	// scanning entry blocks.
	if (/buildAgentSafetyChecks/.test(source) && registrySource) {
		const entries = registrySource.split(/\{\s*\n/);
		for (const entry of entries) {
			const idMatch = entry.match(/id:\s*["'](\w+)["']/);
			const pipelineMatch = entry.match(/pipeline:\s*["'](\w+)["']/);
			if (idMatch && pipelineMatch && pipelineMatch[1] === "agent_safety") {
				names.add(nonNull(idMatch[1]));
			}
		}
	}
	return names;
}

/** Extract check names used in toIssues() calls in verify.ts */
function extractVerifyCheckNames(source: string): Set<string> {
	const names = new Set<string>();
	for (const m of source.matchAll(/toIssues\(\s*["'](\w+)["']/g)) {
		names.add(nonNull(m[1]));
	}
	return names;
}

/** Extract check names from streamCqSection calls and the declarative
 *  section table (`key: "propertyName"`) in the verify streaming pipeline. */
function extractStreamSectionNames(source: string): Set<string> {
	const names = new Set<string>();
	// Legacy inline call form
	for (const m of source.matchAll(
		/streamCqSection\(\s*\n?\s*["'][^"']+["'],\s*\n?\s*cq\.(\w+)/g,
	)) {
		names.add(nonNull(m[1]));
	}
	// Declarative table form (post-refactor): `key: "nameOfBucket"` inside a
	// SectionSpec whose sibling `label` marks the entry as a streaming section.
	for (const m of source.matchAll(/key:\s*["'](\w+)["']/g)) {
		names.add(nonNull(m[1]));
	}
	return names;
}

/** Extract property names from CodeQualityResults interface */
function extractResultsInterfaceProps(source: string): Set<string> {
	const names = new Set<string>();
	const interfaceMatch = source.match(/interface\s+CodeQualityResults\s*\{([\s\S]*?)\n\}/);
	if (!interfaceMatch) return names;
	for (const m of nonNull(interfaceMatch[1]).matchAll(/^\s*(\w+)\s*:/gm)) {
		names.add(nonNull(m[1]));
	}
	return names;
}

/** Extract property names consumed by outputJson — either via destructuring
 *  (legacy `const { ... } = cq;`) or via direct property access (post-refactor
 *  `cq.foo`, `summarize(cq.bar)`, etc.). */
function extractJsonOutputProps(source: string): Set<string> {
	const names = new Set<string>();
	const destructMatch = source.match(
		/function\s+outputJson[\s\S]*?const\s*\{([\s\S]*?)\}\s*=\s*cq;/,
	);
	if (destructMatch) {
		for (const m of nonNull(destructMatch[1]).matchAll(/(\w+)/g)) {
			names.add(nonNull(m[1]));
		}
	}
	// Post-refactor: outputJson reads `cq.X` directly across the build object.
	for (const m of source.matchAll(/\bcq\.(\w+)/g)) {
		names.add(nonNull(m[1]));
	}
	return names;
}

// ===========================================
// Intentional exceptions
// ===========================================

// Checks that only exist in verify (not PostToolUse) with documented reasons
const VERIFY_ONLY_CHECKS = new Set([
	// gitignored_written_config: the detector is 3-arg (content, filePath,
	// isIgnored) — it needs an `isIgnored` predicate backed by repo/git context
	// (`git check-ignore`), which the registry's uniform (content, filePath) =>
	// InlineMatch[] PostToolUse contract can't supply. Wired verify-only in
	// file-checks-agent-safety.ts (toIssues call) with the git-backed resolver;
	// no registry entry, hence this exception. Also in DEFAULT_ADVISORY_SKIPS.
	"gitignored_written_config",
	// property_test_candidate: the detector reads the module's companion test
	// files, so it is not the pure (content, filePath) function the registry's
	// PostToolUse contract requires — determinism-conformance runs the inline
	// pipeline twice and compares bit-for-bit, and an FS-dependent detector
	// flaps there. Wired verify-only in file-checks-agent-safety.ts.
	"property_test_candidate",
	// halstead_difficulty: pure, but a full TS parse + per-token tally per file.
	// Measured on the inline path it pushed determinism-conformance past its 30s
	// budget. Advisory taste check, 17 hits repo-wide — deep-audit cadence.
	"halstead_difficulty",
	// type_smuggling: the assignability test builds a full ts.Program per file,
	// and one file's Program pulls its whole import closure (~2,900 SourceFiles,
	// ~1.9GB of AST in this repo). On the inline path that ran per edit INSIDE
	// the daemon — heap-snapshot-attributed (2026-08-22) as the recurring
	// +1GB/tick RSS spikes and emergency-gc restarts. Deep audit runs it in the
	// CLI's own process, where the allocation dies with the run.
	"type_smuggling",
	// Import-name alias of type_smuggling for the import-parity sweep below
	// (the set is matched against both check ids and imported function names).
	"checkTypeSmuggling",
	// readme_script_drift: verify-only sibling of gitignored_written_config —
	// the detector is 3-arg (content, filePath, getScripts); it needs a
	// package.json `scripts` resolver walking up from the markdown file, which
	// the registry's uniform (content, filePath) => InlineMatch[] contract
	// can't supply. Wired in file-checks-agent-safety.ts with
	// resolveNearestPackageScripts; no registry entry. Also in
	// DEFAULT_ADVISORY_SKIPS.
	"readme_script_drift",
	// spec_path_ref: verify-only sibling — the detector is 3-arg (content,
	// filePath, pathExists); it needs a filesystem resolver for present-tense
	// path-existence claims, outside the registry's uniform (content, filePath)
	// contract. Wired in file-checks-agent-safety.ts with an existsSync-backed
	// resolver; no registry entry. Also in DEFAULT_ADVISORY_SKIPS.
	"spec_path_ref",
	// Cross-file checks that need full project scan
	"checkExportRipple",
	"checkProjectSetup",
	"checkTestRegressions",
	// Placeholder-test check: currently only wired into verify via its own
	// module (`harness/checks/placeholder-tests.ts`); quality-checks.ts is the
	// legacy single-file pipeline. Remove from this list once the check is
	// surfaced through the agentSafetyChecks registry.
	"checkPlaceholderTests",
	// Heuristics moved to scored suggestion pipeline (server.ts), not quality-checks.ts
	"checkSqlInjection",
	"checkQueryInLoop",
	"checkAwaitInLoop",
	"checkUnreachableCode",
	"checkSilentCatch",
	"checkRecursiveWalkerLstat",
	"checkConsoleDebug",
	// Codebase-wide analysis checks (too broad/slow for single-file PostToolUse)
	"checkPiiInSource",
	"checkMixedErrorStrategy",
	// Extraction helpers (not checks)
	"extractEnvReferences",
	"extractMockDefinitions",
	"parseEnvDocumentation",
]);

// Checks in PostToolUse only (not verify) with documented reasons
const POSTTOOLUSE_ONLY_CHECKS = new Set([
	// Binary/empty file checks — only relevant when agent writes a file
	"checkBinaryContent",
	"checkEmptyFile",
	// C/C++ checks — PostToolUse only, pending registry refactor (Improvement #2)
	// Function names (for import parity) and snake_case names (for toIssues parity)
	"checkCUnsafeFunctions",
	"checkCIncludeGuard",
	"checkCSprintfUsage",
	"c_unsafe_functions",
	"c_include_guard",
	"c_sprintf_usage",
	// UBS class-breadth (DW test-adoption P0.5, 2026-07-17): detectors shipped
	// PostToolUse-enforced now; their verify-surface wiring (interface + init +
	// push + streamCqSection) is a deferred batch, matching the c_* precedent
	// above. Function name (import parity) + snake_case id (toIssues parity).
	"checkArchiveExtractTraversal",
	"ubs_archive_extract_traversal",
	"checkPythonAssertTautology",
	"ubs_python_assert_tautology",
	"checkRustTestDeterminism",
	"rust_test_nondeterminism",
	"checkNaiveDatetime",
	"ubs_naive_datetime",
	"checkRedosCatastrophic",
	"redos_catastrophic",
	// Quality-frontier wave (entries-warnings/quality-frontier.ts): shipped
	// PostToolUse-enforced 2026-07; their verify-surface wiring (interface +
	// init + push + streamCqSection) is a deferred batch, matching the UBS
	// class-breadth precedent above. homedir_write_escape (2026-08-10) is the
	// exception — it landed WITH full verify wiring, so it is absent here.
	// Function name (import parity) + snake_case id (toIssues parity).
	"cognitiveComplexityCheck",
	"cognitive_complexity",
	"detectContradictoryNullnessChain",
	"contradictory_nullness_chain",
	"detectImplicitSwitchFallthrough",
	"implicit_switch_fallthrough",
	"detectNumericSortWithoutComparator",
	"numeric_sort_without_comparator",
	"detectCatchRewrapLosesCause",
	"catch_rewrap_loses_cause",
	"detectJsonStringifyError",
	"json_stringify_error",
	"detectResourceHandleLeak",
	"resource_handle_leak",
	"detectJsdocParamDrift",
	"jsdoc_param_drift",
	"detectTimeoutUnitMismatch",
	"timeout_unit_mismatch",
	// Effect second-look wave (2026-09-01): shipped PostToolUse-enforced;
	// verify-surface wiring deferred, matching the quality-frontier precedent.
	"checkFetchWithoutAbortSignal",
	"fetch_without_abort_signal",
	"checkPublicApiLeaksInternalType",
	"public_api_leaks_internal_type",
	// Type-discipline wave (2026-08-14): ported from dmmulroy/anti-slop,
	// detection algorithm only (docs/external-pulse/anti-slop.md). Shipped
	// PostToolUse-enforced now; their verify-surface wiring (interface +
	// init + push + streamCqSection) is a deferred batch, matching the
	// quality-frontier precedent above.
	"detectConditionalEmptyObjectSpread",
	"conditional_empty_object_spread",
	"detectUnknownTypeAlias",
	"unknown_type_alias",
	// tag_reflection_type_check (2026-08-22): new detector in the same
	// type-discipline family. Shipped PostToolUse-enforced only; verify-surface
	// wiring deferred to the same batch as its two siblings above.
	"detectTagReflectionTypeCheck",
	"tag_reflection_type_check",
	// Plan 25 lanes 6-8 (2026-08-17): portability lint + boundary/contract wave.
	// Shipped PostToolUse-enforced now; their verify-surface wiring (interface +
	// init + push + streamCqSection) is a deferred batch, matching the
	// type-discipline precedent above.
	"detectDynamicCodeExecution",
	"dynamic_code_execution",
	"detectBuiltinPrototypeMutation",
	"builtin_prototype_mutation",
	"detectFloatEqualityComparison",
	"float_equality_comparison",
	"python_portability_trap",
	"detectTestContractAnnotation",
	"test_contract_annotation",
	"detectUnvalidatedInputBoundary",
	"unvalidated_input_boundary",
	// Package publish invariants — needs pre-edit disk content to diff against
	// post-edit proposed content, so the check only makes sense at PreToolUse
	// where those two states differ. Running it during `interlinked verify`
	// would produce zero findings (pre == post on a committed file), and
	// wiring a verify-side entry would just add dead code.
	"checkPackageJsonPublishInvariants",
	"checkPackageJsonPublishInvariantsWithPublint",
	"package_json_publish_invariants",
	// Package JSON script paths — stateless check, would work in verify too,
	// but the verify-side wiring (interface + init + push + streamCqSection)
	// is deferred to a follow-up. Hook-time coverage is the load-bearing path.
	"checkPackageJsonScriptPaths",
	"package_json_script_paths",
	// Placeholder markdown-link check: a registry check that fires on every
	// PostToolUse markdown edit (its load-bearing path). The verify-side
	// full-scan wiring is a deferred follow-up — same rationale as the
	// checkPackageJsonScriptPaths note above.
	"checkPlaceholderMarkdownLinks",
	"placeholder_markdown_link",
	// Test-portability checks (finding 2026-06: env-divergent tests shipped a
	// red CI run): the load-bearing surface is WRITE TIME — the warning must
	// land while the agent is authoring the test, before it can reach CI. The
	// verify-side full-scan wiring is a deferred follow-up — same rationale as
	// checkPlaceholderMarkdownLinks above.
	"checkPlatformConditionalAssertion",
	"test_platform_conditional",
	"checkSilentDependencySkip",
	"test_silent_dependency_skip",
	// Coding-standards inline heuristics (2026-06): unjustified casts, scattered
	// process.env reads, top-level side effects. Load-bearing surface is WRITE TIME
	// (PostToolUse warning + the unjustified_cast net-new ratchet); verify-side full
	// scan wiring is a deferred follow-up, same rationale as checkPlaceholderMarkdownLinks.
	"findUnjustifiedCasts",
	"unjustified_cast",
	"findProcessEnvOutsideConfig",
	"process_env_outside_config",
	"findTopLevelSideEffects",
	"top_level_side_effect",
	// cjs_in_esm_module (CommonJS-in-ESM): a default-gate edit-time correctness
	// check. Load-bearing surface is WRITE TIME — the PostToolUse warning the
	// moment an agent writes require()/module.exports/__dirname into an ESM file.
	// Verify-side wiring (interface + init + push + streamCqSection) is a deferred
	// follow-up, same rationale as checkPlaceholderMarkdownLinks above.
	"cjs_in_esm_module",
]);

// ===========================================
// Tests
// ===========================================

describe("check pipeline parity: verify ↔ PostToolUse", () => {
	const qualitySource = readFullQualityChecksSource();
	const registrySource = readRegistrySources();
	const verifySource = readFullVerifySource();

	const qcImports = extractGenericCheckImports(qualitySource, registrySource);
	const verifyImports = extractGenericCheckImports(verifySource);
	const safetyCheckNames = extractAgentSafetyCheckNames(qualitySource, registrySource);
	const verifyCheckNames = extractVerifyCheckNames(verifySource);

	it("every check imported in quality-checks.ts is also imported in verify.ts (or documented as exception)", () => {
		const missing: string[] = [];
		for (const name of qcImports) {
			if (!verifyImports.has(name) && !POSTTOOLUSE_ONLY_CHECKS.has(name)) {
				missing.push(name);
			}
		}
		expect(
			missing,
			`These checks are imported in quality-checks.ts but NOT in verify.ts:\n${missing.join("\n")}\n\nEither add them to verify.ts or add to POSTTOOLUSE_ONLY_CHECKS with a reason.`,
		).toEqual([]);
	});

	it("every check imported in verify.ts is also imported in quality-checks.ts (or documented as exception)", () => {
		const missing: string[] = [];
		for (const name of verifyImports) {
			if (!qcImports.has(name) && !VERIFY_ONLY_CHECKS.has(name)) {
				missing.push(name);
			}
		}
		expect(
			missing,
			`These checks are imported in verify.ts but NOT in quality-checks.ts:\n${missing.join("\n")}\n\nEither add them to quality-checks.ts or add to VERIFY_ONLY_CHECKS with a reason.`,
		).toEqual([]);
	});

	it("every agentSafetyCheck has a corresponding toIssues call in verify.ts (or documented as exception)", () => {
		const missing: string[] = [];
		for (const name of safetyCheckNames) {
			// Convert snake_case safety check name to the verify toIssues name
			const verifyName = name; // toIssues uses the same snake_case name
			if (!verifyCheckNames.has(verifyName) && !POSTTOOLUSE_ONLY_CHECKS.has(name)) {
				missing.push(name);
			}
		}
		expect(
			missing,
			`These agentSafetyChecks have no matching toIssues() call in verify.ts:\n${missing.join("\n")}\n\nAdd the check to verify.ts's runCodeQualityChecks() function.`,
		).toEqual([]);
	});

	it("every toIssues call in verify.ts has a corresponding agentSafetyCheck (or documented as exception)", () => {
		// Build set of verify check names that correspond to agentSafetyChecks
		// (excluding checks that are wired differently, like complexity, large_file, etc.)
		const safetyCheckSet = new Set(safetyCheckNames);
		const verifyOnlyToIssueNames = new Set([
			// These are wired separately in quality-checks.ts (not via agentSafetyChecks array)
			"complexity",
			"no_test_file",
			"missing_return_types",
			"strong_typing",
			"console_statements",
			"silent_catches",
			"test_regressions",
			"phantom_imports",
			"unreachable_code",
			"sql_injection",
			"query_in_loop",
			"await_in_loop",
			"export_ripple",
			"large_files",
			"json_validity",
			"suppressions",
			"undocumented_env_vars",
			"mock_drift",
			"incomplete_renames",
			"css_syntax",
			"sql_syntax",
			"package_json_consistency",
			"schema_drift",
			"pii_detection",
			// Placeholder-test detector: see note in VERIFY_ONLY_CHECKS above.
			"placeholder_test",
		]);

		const missing: string[] = [];
		for (const name of verifyCheckNames) {
			if (
				!safetyCheckSet.has(name) &&
				!verifyOnlyToIssueNames.has(name) &&
				!VERIFY_ONLY_CHECKS.has(name)
			) {
				missing.push(name);
			}
		}
		expect(
			missing,
			`These verify toIssues() checks have no matching agentSafetyCheck:\n${missing.join("\n")}\n\nAdd to quality-checks.ts agentSafetyChecks array or document as exception.`,
		).toEqual([]);
	});

	it("verify.ts CodeQualityResults interface has a property for every toIssues check name", () => {
		const interfaceProps = extractResultsInterfaceProps(verifySource);
		const missing: string[] = [];
		const toIssuesNames = extractVerifyCheckNames(verifySource);

		// Some toIssues names map to non-standard camelCase property names
		const TOISSUES_TO_PROP: Record<string, string> = {
			self_import: "selfImports",
			non_null_assertion: "nonNullAssertions",
			extraneous_deps: "extraneousDeps",
			no_test_file: "noTestFile",
			// `silent_promise_catch` (registry id) maps to `silentPromiseSwallow`
			// (property name) — the property tracks the underlying detector
			// `checkSilentPromiseSwallow` rather than the registry id.
			silent_promise_catch: "silentPromiseSwallow",
			// UBS Plan 04 ids carry the `ubs_` prefix in registry/toIssues, but
			// per Plan 04 §"Phase matrix" the resultsPropName is the bare camel
			// form (e.g. `floatEquality` not `ubsFloatEquality`).
			ubs_js_loose_equality: "jsLooseEquality",
			ubs_float_equality: "floatEquality",
			ubs_java_optional_get: "javaOptionalGet",
			ubs_rust_debug_assert_side_effect: "rustDebugAssertSideEffect",
			// Bun-regression detector pack (2026-07-20)
			ubs_c_assert_side_effect: "cAssertSideEffect",
			ubs_python_assert_side_effect: "pythonAssertSideEffect",
			ubs_java_assert_side_effect: "javaAssertSideEffect",
			ubs_rust_unchecked_cast_slice: "rustUncheckedCastSlice",
			ubs_division_by_variable: "divisionByVariable",
			ubs_mutex_lock_unwrap: "mutexLockUnwrap",
			ubs_subprocess_shell_true: "subprocessShellTrue",
			ubs_tls_verify_disabled: "tlsVerifyDisabled",
			ubs_py_none_equality: "pyNoneEquality",
			ubs_weak_hash: "weakHash",
			// Plan 04 D.1 partial
			ubs_eval_input_tainted: "evalInputTainted",
			ubs_sql_string_concat: "sqlStringConcat",
			ubs_python_mutable_default_arg: "pyMutableDefaultArg",
			// Plan 04 D.1 backlog (17 of 20)
			ubs_tempfile_mktemp_race: "tempfileMktempRace",
			ubs_pickle_untrusted_load: "pickleUntrustedLoad",
			ubs_xml_external_entity: "xmlExternalEntity",
			ubs_os_system_tainted: "osSystemTainted",
			ubs_unsafe_format_string: "unsafeFormatString",
			ubs_unchecked_redirect: "uncheckedRedirect",
			ubs_goroutine_no_waitgroup: "goroutineNoWaitgroup",
			ubs_defer_in_loop: "deferInLoop",
			ubs_string_concat_in_loop: "ubsStringConcatInLoop",
			ubs_numeric_comparison_chain: "numericComparisonChain",
			ubs_print_debug_leak: "printDebugLeak",
			ubs_hardcoded_localhost: "ubsHardcodedLocalhost",
			ubs_magic_number_no_const: "magicNumberNoConst",
			ubs_large_function: "largeFunction",
			ubs_deeply_nested_callback: "deeplyNestedCallback",
			ubs_time_format_locale_dep: "timeFormatLocaleDep",
			ubs_regex_in_loop_no_compile: "regexInLoopNoCompile",
			// Plan 04 D.2 (2026-05) — pattern-parity expansion
			ubs_marshal_load: "marshalLoad",
			ubs_shelve_open: "shelveOpen",
			ubs_yaml_unsafe_load: "yamlUnsafeLoad",
			ubs_torch_unsafe_load: "torchUnsafeLoad",
			ubs_pickle_wrapper_load: "pickleWrapperLoad",
			ubs_aes_ecb_mode: "aesEcbMode",
			ubs_weak_random_security: "weakRandom",
			ubs_node_create_cipher: "nodeCreateCipher",
			ubs_script_without_sri: "scriptWithoutSri",
			ubs_go_shell_injection: "goShellInjection",
			ubs_github_actions_injection: "githubActionsInjection",
			ubs_document_write: "documentWrite",
			ubs_outer_html_assignment: "outerHtmlAssignment",
			ubs_insert_adjacent_html: "insertAdjacentHtml",
		};

		for (const name of toIssuesNames) {
			const override = TOISSUES_TO_PROP[name];
			const camelCase = override ?? name.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
			if (!interfaceProps.has(camelCase) && !interfaceProps.has(name)) {
				missing.push(`${name} (expected property: ${camelCase})`);
			}
		}
		expect(
			missing,
			`These toIssues checks have no matching CodeQualityResults property:\n${missing.join("\n")}`,
		).toEqual([]);
	});

	it("verify.ts streamCqSection covers every CodeQualityResults property", () => {
		const interfaceProps = extractResultsInterfaceProps(verifySource);
		const streamProps = extractStreamSectionNames(verifySource);

		// Some properties are rendered via custom logic, not streamCqSection
		const CUSTOM_RENDERED = new Set([
			"undocumentedEnvVars", // Rendered with special env-var grouping
			"suppressions", // Rendered in suppression summary section
		]);

		const missing: string[] = [];
		for (const prop of interfaceProps) {
			if (!streamProps.has(prop) && !CUSTOM_RENDERED.has(prop)) {
				missing.push(prop);
			}
		}
		expect(
			missing,
			`These CodeQualityResults properties have no streamCqSection() call:\n${missing.join("\n")}`,
		).toEqual([]);
	});

	it("verify.ts outputJson destructures every CodeQualityResults property", () => {
		const interfaceProps = extractResultsInterfaceProps(verifySource);
		const jsonProps = extractJsonOutputProps(verifySource);

		// Agent safety checks are currently aggregated under a single "agent_checks"
		// key in JSON output rather than destructured individually.
		// TODO: These should be individually included in JSON output for tooling.
		const AGGREGATED_IN_JSON = new Set([
			"anonymousRegistration",
			"cognitiveComplexity",
			"misusedPromises",
			"floatingPromises",
			"broadObjectTypes",
			"booleanTrap",
			"positionalOptionalBoolean",
			"manyOptionalParams",
			"sameTypedPrimitiveParams",
			"commentClaimsLimitNoGuard",
			"commentClaimsNullThrowsInstead",
			"commentClaimsValidationMissing",
			"commentClaimsIdempotentMutates",
			"commentClaimsThrowsDoesnt",
			"iteratorInvalidation",
			"freshCollectionKeyLookup",
			"discriminatedUnionExhaustiveness",
			"indexBoundsUnchecked",
			"cleanupSkippedOnEarlyExit",
			"taintedToPrivilegedSink",
			"awaitStateToctou",
			"cleanupReentrancy",
			"boundaryCopyNoRevalidation",
			"magicLiteralInConditional",
			"nanCoercionGuard",
			"unawaitedAsyncAssertion",
			"arrayPushReturnUsed",
			"arrayIterateeVariadicBuiltin",
			"writeWithoutMkdir",
			"homedirWriteEscape",
			"duplicatedPolicyConstant",
			"typePredicateDrift",
			"snapshotHygiene",
			"designSlop",
			"payloadFieldCasing",
			"gitignoredWrittenConfig",
			"propertyTestCandidate",
			"halsteadDifficulty",
			"readmeScriptDrift",
			"specPathRef",
			"asyncPromiseExecutor",
			"selfImports",
			"extraneousDeps",
			"nonNullAssertions",
			"evalUsage",
			"innerHtml",
			"nanComparison",
			"constantCondition",
			"unsafeOptionalChaining",
			"numberPrecisionLoss",
			"throwLiteral",
			"promiseRejectNonError",
			"lossyErrorRethrow",
			"silentPromiseSwallow",
			"unvalidatedJsonBoundary",
			"deadExports",
			"circularImports",
			"untestedInversePair",
			"untestedIdempotent",
			"lifecycleCleanup",
			"defaultExport",
			"codeClones",
			"requireAwait",
			"accumulatingSpread",
			"manualFieldCopy",
			"excessiveUseState",
			// C/C++ checks (PostToolUse only, pending registry refactor)
			"cUnsafeFunctions",
			"cIncludeGuard",
			"cSprintfUsage",
			// UBS Plan 04 — rows 22–30. Each is destructured into its own
			// summary key in outputJson (`ubs_*`), so the parity test does
			// not strictly require them in this set, but listing them keeps
			// the bookkeeping explicit when downstream tooling adds them as
			// individual JSON-output fields.
			"jsLooseEquality",
			"floatEquality",
			"javaOptionalGet",
			"rustDebugAssertSideEffect",
			// Bun-regression detector pack (2026-07-20)
			"cAssertSideEffect",
			"pythonAssertSideEffect",
			"javaAssertSideEffect",
			"rustUncheckedCastSlice",
			"unalignedReinterpret",
			"placeholderRuntimeConstant",
			"rustUnsafeSpan",
			"suppressionBlockSpan",
			"divisionByVariable",
			"mutexLockUnwrap",
			"subprocessShellTrue",
			"tlsVerifyDisabled",
			"pyNoneEquality",
			"weakHash",
			"evalInputTainted",
			"sqlStringConcat",
			"pyMutableDefaultArg",
			// D.1 backlog
			"tempfileMktempRace",
			"pickleUntrustedLoad",
			"xmlExternalEntity",
			"osSystemTainted",
			"unsafeFormatString",
			"uncheckedRedirect",
			"goroutineNoWaitgroup",
			"deferInLoop",
			"ubsStringConcatInLoop",
			"numericComparisonChain",
			"printDebugLeak",
			"ubsHardcodedLocalhost",
			"magicNumberNoConst",
			"largeFunction",
			"deeplyNestedCallback",
			"timeFormatLocaleDep",
			"regexInLoopNoCompile",
			// Plan 04 D.2 (2026-05) — pattern-parity expansion. Aggregated for
			// now under the same convention as the rest of the UBS family; can
			// be promoted to individual JSON destructuring when downstream
			// tooling needs per-rule filters.
			"marshalLoad",
			"shelveOpen",
			"yamlUnsafeLoad",
			"torchUnsafeLoad",
			"pickleWrapperLoad",
			"aesEcbMode",
			"nodeCreateCipher",
			"scriptWithoutSri",
			"goShellInjection",
			"githubActionsInjection",
			"documentWrite",
			"outerHtmlAssignment",
			"insertAdjacentHtml",
			"identicalConditionalBranches",
			// Phase B endpoint-security pack (2026-05) — aggregated under the
			// same convention as the rest of the warning families. Promoted to
			// individual JSON destructuring later if downstream tooling needs
			// per-rule filters.
			"endpointAuthMissing",
			"endpointIdorShape",
			"endpointMissingTenantFilter",
			"endpointSsrfShape",
			"endpointMassAssignment",
			// Batches 1, 2, 5, 8: now individually destructured in
			// outputJson; no longer aggregated. Kept here as a comment for
			// the bookkeeping trail.
		]);

		const missing: string[] = [];
		for (const prop of interfaceProps) {
			if (!jsonProps.has(prop) && !AGGREGATED_IN_JSON.has(prop)) {
				missing.push(prop);
			}
		}
		expect(
			missing,
			`These CodeQualityResults properties are not destructured in outputJson():\n${missing.join("\n")}\n\nAdd them to the outputJson destructuring and JSON output object.`,
		).toEqual([]);
	});

	it("no check functions are imported but unused in quality-checks.ts", () => {
		// Every imported check function should either:
		// 1. Appear in the agentSafetyChecks array (fn: () => checkXxx(...))
		// 2. Be called elsewhere in the file (e.g., checkFunctionComplexity, checkLargeFile)
		// 3. Be used transitively via check-registry.ts (imported there and wired into CHECK_REGISTRY)
		const unused: string[] = [];
		// Combined source: quality-checks.ts + check-registry.ts (for transitive usage)
		const combinedSource = `${qualitySource}\n${registrySource}`;
		for (const name of qcImports) {
			// Count occurrences beyond the import statement
			const importPattern = new RegExp(`\\b${name}\\b`, "g");
			const matches = combinedSource.match(importPattern);
			// Should appear at least twice: once in import, once in usage
			if (!matches || matches.length < 2) {
				unused.push(name);
			}
		}
		expect(
			unused,
			`These check functions are imported in quality-checks.ts but never used:\n${unused.join("\n")}\n\nRemove the unused import or wire the check into the pipeline.`,
		).toEqual([]);
	});

	it("no check functions are imported but unused in verify.ts", () => {
		const unused: string[] = [];
		for (const name of verifyImports) {
			const importPattern = new RegExp(`\\b${name}\\b`, "g");
			const matches = verifySource.match(importPattern);
			if (!matches || matches.length < 2) {
				unused.push(name);
			}
		}
		expect(
			unused,
			`These check functions are imported in verify.ts but never used:\n${unused.join("\n")}\n\nRemove the unused import or wire the check into the pipeline.`,
		).toEqual([]);
	});
});
