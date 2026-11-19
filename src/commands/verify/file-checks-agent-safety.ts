// ===========================================
// Per-file check battery — agent-safety group
// ===========================================
// Extracted from `file-checks.ts` to keep that orchestrator under the
// 1000-line file-size threshold. Covers the CRAP composite, the
// export/dead-export/cycle structural trio, and the first wave of
// "agent safety" detectors (comment-vs-behavior drift, TOCTOU, cleanup,
// promise hygiene, etc.).
//
// Behaviour-preserving: each helper runs the SAME checks in the SAME order
// as the inline block it replaced. Each `r.<bucket>` array is independent,
// so cross-helper ordering is invisible to output — only the per-bucket
// statement order matters, and that is preserved verbatim.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
	detectArrayIterateeVariadicBuiltin,
	detectReturnArrayPush,
} from "../../harness/checks/array-method-misuse.js";
import { checkRawControlBytes } from "../../harness/checks/control-bytes.js";
import { detectCommanderOptionAttribute } from "../../harness/checks/commander-option-attribute.js";
import { computeCrap } from "../../harness/checks/crap.js";
import { computeCyclomaticComplexity } from "../../harness/checks/cyclomatic.js";
import { detectDesignSlop } from "../../harness/checks/design-slop.js";
import { detectHomedirWriteEscape, detectWriteWithoutMkdir } from "../../harness/checks/fs-write-safety.js";
import { detectGitignoredWrites } from "../../harness/checks/gitignored-write.js";
import { maintainabilityCheck } from "../../harness/checks/maintainability.js";
import { detectNaNCoercionGuards } from "../../harness/checks/nan-coercion.js";
import { checkAnonymousRegistration } from "../../harness/checks/anonymous-registration.js";
import { detectPayloadFieldCasing } from "../../harness/checks/payload-casing.js";
import { detectPolicyConstantDrift } from "../../harness/checks/policy-constant-drift.js";
import { propertyCandidateCheck } from "../../harness/checks/property-candidate.js";
import {
	detectReadmeScriptDrift,
	resolveNearestPackageScripts,
} from "../../harness/checks/readme-script-drift.js";
import { detectSnapshotHygiene } from "../../harness/checks/snapshot-hygiene.js";
import { detectHandRolledLexer } from "../../harness/checks/hand-rolled-lexer.js";
import { detectTypePredicateDrift } from "../../harness/checks/type-predicate-drift.js";
import { checkSpecPathRef } from "../../harness/checks/spec-structure.js";
import { detectUnawaitedAsyncAssertions } from "../../harness/checks/test-async-assertions.js";
import {
	coverageForFile,
	loadCoverageFinal,
} from "../../harness/coverage-final-reader.js";
import {
	checkAccumulatingSpread,
	checkAsyncPromiseExecutor,
	checkAwaitStateToctou,
	checkBooleanTrap,
	checkBoundaryCopyNoRevalidation,
	checkBroadObjectTypes,
	checkCircularImports,
	checkCleanupReentrancy,
	checkCleanupSkippedOnEarlyExit,
	checkCodeClones,
	checkCommentClaimsIdempotentMutates,
	checkCommentClaimsLimitNoGuard,
	checkCommentClaimsNullThrowsInstead,
	checkCommentClaimsThrowsDoesnt,
	checkCommentClaimsValidationMissing,
	checkConstantCondition,
	checkDeadExports,
	checkDefaultExport,
	checkDiscriminatedUnionExhaustiveness,
	checkErrorDispatchByInstanceof,
	checkEvalUsage,
	checkExportRipple,
	checkExtraneousDependencies,
	checkFloatingPromises,
	checkFreshCollectionKeyLookup,
	checkImportFromOwnBarrel,
	checkIndexBoundsUnchecked,
	checkInnerHtmlUsage,
	checkIteratorInvalidation,
	checkLifecycleCleanup,
	checkLossyErrorRethrow,
	checkMagicLiteralInConditional,
	checkManualFieldCopy,
	checkManyOptionalParams,
	checkMisusedPromises,
	checkNanComparison,
	checkNonNullAssertions,
	checkNumberPrecisionLoss,
	checkPlaceholderRuntimeConstant,
	checkPositionalOptionalBoolean,
	checkPromiseRejectNonError,
	checkRequireAwait,
	checkRustUnsafeSpan,
	checkSameTypedPrimitiveParams,
	checkSelfImport,
	checkSilentPromiseSwallow,
	checkSuppressionSpan,
	checkTaintedToPrivilegedSink,
	checkThrowLiteral,
	checkUnsafeOptionalChaining,
	checkUntestedIdempotent,
	checkUntestedInversePair,
} from "../../harness/generic-checks.js";
import type { FileCheckContext } from "./file-checks-shared.js";
import { contentCheckRunner } from "./file-checks-content.js";
import { toIssues } from "./file-checks-shared.js";

/**
 * Build an `isIgnored(writtenPath)` predicate backed by `git check-ignore`.
 *
 * The written path is resolved relative to the directory of the file that
 * contains the write call (so a relative literal like `"a/b/c.json"` is
 * interpreted as the author would expect), then made repo-relative before the
 * git query. `git check-ignore <path>` exits 0 when the path is ignored (and
 * NO `!` negation rescues it) — that is the only "ignored" signal we trust.
 *
 * Fail-OPEN: any error (non-git repo, git missing, path outside cwd) returns
 * `false` so offline / non-git trees never false-fire. The `-q` flag keeps the
 * command quiet; we only read the exit status.
 */
function makeGitIgnoreResolver(
	cwd: string,
	containingFileAbs: string,
): (writtenPath: string) => boolean {
	const fileDir = resolve(containingFileAbs, "..");
	return (writtenPath: string): boolean => {
		try {
			const abs = isAbsolute(writtenPath) ? writtenPath : resolve(fileDir, writtenPath);
			const rel = relative(cwd, abs);
			// A path that escapes the repo root (`../…`) can't be matched against
			// this repo's .gitignore — treat as not-ignored.
			if (rel.startsWith("..") || isAbsolute(rel)) return false;
			execFileSync("git", ["check-ignore", "-q", "--", rel], {
				cwd,
				stdio: "ignore",
			});
			// Exit 0 → the path IS ignored.
			return true;
		} catch {
			// Exit 1 (not ignored) lands here too, alongside genuine errors — both
			// resolve to "not ignored", which is the fail-open behavior we want.
			return false;
		}
	};
}

/**
 * CRAP (Change Risk Anti-Patterns) — complexity × coverage composite.
 * Fail-open when coverage-final.json is absent: emits no findings.
 */
export function runCrapCheck(ctx: FileCheckContext): void {
	const { content, file, relPath, cwd, r } = ctx;
	const coveragePath = resolve(cwd, "coverage", "coverage-final.json");
	const covCache = loadCoverageFinal(coveragePath, cwd);
	const perFile = covCache ? coverageForFile(covCache, relPath) : undefined;
	if (perFile === undefined) return;
	const complexities = computeCyclomaticComplexity(content, file);
	const fileMtime = existsSync(file) ? statSync(file).mtimeMs : 0;
	const findings = computeCrap({
		complexities,
		coverage: perFile.functions,
		filePath: relPath,
		fileMtime,
		coverageMtime: perFile.mtime,
		threshold: 30,
		staleTolerance: "tag",
	});
	r.crap.push(
		...findings.map((f) => ({
			check: "crap",
			file: relPath,
			line: f.line,
			message: `${f.function}: CRAP=${f.crap_score.toFixed(0)} (cyc=${f.complexity}, cov=${f.coverage_pct.toFixed(0)}%)${f.stale ? " [stale coverage]" : ""}`,
		})),
	);
}

/**
 * Export-surface / dead-export / cycle structural trio plus the first wave of
 * agent-safety detectors. Mirrors the inline block at the head of the
 * `--- Agent safety checks ---` section.
 */
export function runAgentSafetyChecks(ctx: FileCheckContext): void {
	const { content, file, relPath, cwd, r } = ctx;
	const runCheck = contentCheckRunner(ctx);
	runCheck("commander_option_attribute", r.commanderOptionAttribute, detectCommanderOptionAttribute);

	r.exportRipple.push(
		...toIssues("export_ripple", relPath, checkExportRipple, content, file, cwd),
	);
	r.deadExports.push(...toIssues("dead_exports", relPath, checkDeadExports, content, file, cwd));
	r.circularImports.push(
		...toIssues("circular_imports", relPath, checkCircularImports, content, file, cwd),
	);
	r.untestedInversePair.push(
		...toIssues("untested_inverse_pair", relPath, checkUntestedInversePair, content, file, cwd),
	);
	r.untestedIdempotent.push(
		...toIssues("untested_idempotent", relPath, checkUntestedIdempotent, content, file, cwd),
	);
	runCheck("lifecycle_cleanup", r.lifecycleCleanup, checkLifecycleCleanup);
	runCheck("default_export", r.defaultExport, checkDefaultExport);
	runCheck("code_clones", r.codeClones, checkCodeClones);

	runSafetyPatterns(ctx);
	runRepositoryChecks(ctx);
	runCorrectnessChecks(ctx);
}

function runSafetyPatterns(ctx: FileCheckContext): void {
	const { r } = ctx;
	const runCheck = contentCheckRunner(ctx);
	runCheck("misused_promises", r.misusedPromises, checkMisusedPromises);
	runCheck("floating_promises", r.floatingPromises, checkFloatingPromises);
	runCheck("broad_object_types", r.broadObjectTypes, checkBroadObjectTypes);
	runCheck("boolean_trap", r.booleanTrap, checkBooleanTrap);
	runCheck("positional_optional_boolean", r.positionalOptionalBoolean, checkPositionalOptionalBoolean);
	runCheck("many_optional_params", r.manyOptionalParams, checkManyOptionalParams);
	runCheck("same_typed_primitive_params", r.sameTypedPrimitiveParams, checkSameTypedPrimitiveParams);
	// Comment-vs-behavior drift (Mythos Phase 2 verify-side wiring).
	runCheck("comment_claims_limit_no_guard", r.commentClaimsLimitNoGuard, checkCommentClaimsLimitNoGuard);
	runCheck("comment_claims_null_throws_instead", r.commentClaimsNullThrowsInstead, checkCommentClaimsNullThrowsInstead);
	runCheck("comment_claims_validation_missing", r.commentClaimsValidationMissing, checkCommentClaimsValidationMissing);
	runCheck("comment_claims_idempotent_mutates", r.commentClaimsIdempotentMutates, checkCommentClaimsIdempotentMutates);
	runCheck("comment_claims_throws_doesnt", r.commentClaimsThrowsDoesnt, checkCommentClaimsThrowsDoesnt);
	runCheck("iterator_invalidation", r.iteratorInvalidation, checkIteratorInvalidation);
	runCheck("fresh_collection_key_lookup", r.freshCollectionKeyLookup, checkFreshCollectionKeyLookup);
	runCheck("discriminated_union_exhaustiveness", r.discriminatedUnionExhaustiveness, checkDiscriminatedUnionExhaustiveness);
	runCheck("index_bounds_unchecked", r.indexBoundsUnchecked, checkIndexBoundsUnchecked);
	runCheck("cleanup_skipped_on_early_exit", r.cleanupSkippedOnEarlyExit, checkCleanupSkippedOnEarlyExit);
	runCheck("tainted_to_privileged_sink", r.taintedToPrivilegedSink, checkTaintedToPrivilegedSink);
	runCheck("await_state_toctou", r.awaitStateToctou, checkAwaitStateToctou);
	runCheck("cleanup_reentrancy", r.cleanupReentrancy, checkCleanupReentrancy);
	runCheck("boundary_copy_no_revalidation", r.boundaryCopyNoRevalidation, checkBoundaryCopyNoRevalidation);
	runCheck("magic_literal_in_conditional", r.magicLiteralInConditional, checkMagicLiteralInConditional);
	runCheck("nan_coercion_guard", r.nanCoercionGuard, detectNaNCoercionGuards);
	runCheck("unawaited_async_assertion", r.unawaitedAsyncAssertion, detectUnawaitedAsyncAssertions);
	runCheck("design_slop", r.designSlop, detectDesignSlop);
	runCheck("array_push_return_used", r.arrayPushReturnUsed, detectReturnArrayPush);
	runCheck("array_iteratee_variadic_builtin", r.arrayIterateeVariadicBuiltin, detectArrayIterateeVariadicBuiltin);
	runCheck("write_without_mkdir", r.writeWithoutMkdir, detectWriteWithoutMkdir);
	runCheck("homedir_write_escape", r.homedirWriteEscape, detectHomedirWriteEscape);
	runCheck("duplicated_policy_constant", r.duplicatedPolicyConstant, detectPolicyConstantDrift);
	runCheck("type_predicate_drift", r.typePredicateDrift, detectTypePredicateDrift);
	runCheck("snapshot_hygiene", r.snapshotHygiene, detectSnapshotHygiene);
	runCheck("hand_rolled_lexer", r.handRolledLexer, detectHandRolledLexer);
	runCheck("payload_field_casing", r.payloadFieldCasing, detectPayloadFieldCasing);
	runCheck("anonymous_registration", r.anonymousRegistration, checkAnonymousRegistration);
	// halstead_difficulty — verify-only. Pure, but a full TS parse plus a
	// per-token tally per file: measured, it pushed the determinism-conformance
	// suite (18 inputs x 3 runs) past its 30s budget on the inline path. An
	// advisory taste check that fires 17 times repo-wide does not earn per-edit
	// latency; deep audit is the right cadence.
	runCheck("halstead_difficulty", r.halsteadDifficulty, maintainabilityCheck);
	// type_smuggling is verify-only since 2026-08-22 (its per-file ts.Program
	// melted the daemon) — its verify invocation ALREADY lives in
	// file-checks-endpoint-laziness.ts; a second call here double-built the
	// ~1.9GB program per file (external review 2026-08-23, finding 5).
	// property_test_candidate — verify-only: the detector reads the module's
	// companion test files, so it is not the pure (content, filePath) function
	// the PostToolUse registry contract requires (and the determinism-conformance
	// test enforces). Same standing as the resolver-backed checks below.
	runCheck("property_test_candidate", r.propertyTestCandidate, propertyCandidateCheck);
}

function runRepositoryChecks({ content, file, relPath, r, cwd }: FileCheckContext): void {
	// gitignored_written_config — verify-only (3-arg detector needs git context).
	// Backed by a `git check-ignore` resolver; fails open to "not ignored" off-git.
	r.gitignoredWrittenConfig.push(
		...toIssues(
			"gitignored_written_config",
			relPath,
			() => (detectGitignoredWrites(content, file, makeGitIgnoreResolver(cwd, file))),
		),
	);
	// readme_script_drift — verify-only sibling of gitignored_written_config
	// (3-arg detector needs a package.json scripts resolver). Markdown files
	// enter the per-file battery via the broad discovery universe; the detector
	// self-filters to .md/.markdown, so every other file no-ops here. The
	// resolver walks up from the markdown file, stopping at the verify cwd.
	r.readmeScriptDrift.push(
		...toIssues(
			"readme_script_drift",
			relPath,
			() => (detectReadmeScriptDrift(content, file, (markdownPath) =>
				resolveNearestPackageScripts(markdownPath, cwd),
			)),
		),
	);
	// spec_path_ref — verify-only (3-arg detector needs a filesystem resolver).
	// Fires on present-tense claims that a path exists in-repo when it does not
	// (Sol D-3). The resolver checks the working tree relative to the verify cwd.
	r.specPathRef.push(
		...toIssues(
			"spec_path_ref",
			relPath,
			() => (checkSpecPathRef(content, file, (target) => existsSync(resolve(cwd, target)))),
		),
	);
}

function runCorrectnessChecks(ctx: FileCheckContext): void {
	const { r } = ctx;
	const runCheck = contentCheckRunner(ctx);
	// Bun-regression detector pack (2026-07-20): confessed stand-in constants +
	// escape-hatch span pair.
	runCheck("placeholder_runtime_constant", r.placeholderRuntimeConstant, checkPlaceholderRuntimeConstant);
	runCheck("rust_unsafe_span", r.rustUnsafeSpan, checkRustUnsafeSpan);
	runCheck("suppression_block_span", r.suppressionBlockSpan, checkSuppressionSpan);
	runCheck("async_promise_executor", r.asyncPromiseExecutor, checkAsyncPromiseExecutor);
	runCheck("self_import", r.selfImports, checkSelfImport);
	runCheck("extraneous_deps", r.extraneousDeps, checkExtraneousDependencies);
	runCheck("non_null_assertion", r.nonNullAssertions, checkNonNullAssertions);
	runCheck("eval_usage", r.evalUsage, checkEvalUsage);
	runCheck("inner_html", r.innerHtml, checkInnerHtmlUsage);
	runCheck("nan_comparison", r.nanComparison, checkNanComparison);
	runCheck("constant_condition", r.constantCondition, checkConstantCondition);
	runCheck("unsafe_optional_chaining", r.unsafeOptionalChaining, checkUnsafeOptionalChaining);
	runCheck("number_precision_loss", r.numberPrecisionLoss, checkNumberPrecisionLoss);
	runCheck("throw_literal", r.throwLiteral, checkThrowLiteral);
	runCheck("promise_reject_non_error", r.promiseRejectNonError, checkPromiseRejectNonError);
	runCheck("raw_control_bytes", r.rawControlBytes, checkRawControlBytes);
	runCheck("lossy_error_rethrow", r.lossyErrorRethrow, checkLossyErrorRethrow);
	runCheck("import_from_own_barrel", r.importFromOwnBarrel, checkImportFromOwnBarrel);
	runCheck("error_dispatch_by_instanceof", r.errorDispatchByInstanceof, checkErrorDispatchByInstanceof);
	runCheck("silent_promise_catch", r.silentPromiseSwallow, checkSilentPromiseSwallow);
	runCheck("require_await", r.requireAwait, checkRequireAwait);
	runCheck("accumulating_spread", r.accumulatingSpread, checkAccumulatingSpread);
	runCheck("manual_field_copy", r.manualFieldCopy, checkManualFieldCopy);
}
