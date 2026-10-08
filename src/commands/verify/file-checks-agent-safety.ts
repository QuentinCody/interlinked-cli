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

/** Content-only advisory detectors, kept out of `runAgentSafetyChecks` (over the token cap). */
function runContentHygieneChecks({ content, file, relPath, r }: FileCheckContext): void {
	r.snapshotHygiene.push(
		...toIssues("snapshot_hygiene", relPath, detectSnapshotHygiene(content, file)),
	);
	r.handRolledLexer.push(
		...toIssues("hand_rolled_lexer", relPath, detectHandRolledLexer(content, file)),
	);
}

/**
 * Export-surface / dead-export / cycle structural trio plus the first wave of
 * agent-safety detectors. Mirrors the inline block at the head of the
 * `--- Agent safety checks ---` section.
 */
export function runAgentSafetyChecks(ctx: FileCheckContext): void {
	const { content, file, relPath, cwd, r } = ctx;

	r.exportRipple.push(
		...toIssues("export_ripple", relPath, checkExportRipple(content, file, cwd)),
	);
	r.deadExports.push(...toIssues("dead_exports", relPath, checkDeadExports(content, file, cwd)));
	r.circularImports.push(
		...toIssues("circular_imports", relPath, checkCircularImports(content, file, cwd)),
	);
	r.untestedInversePair.push(
		...toIssues("untested_inverse_pair", relPath, checkUntestedInversePair(content, file, cwd)),
	);
	r.untestedIdempotent.push(
		...toIssues("untested_idempotent", relPath, checkUntestedIdempotent(content, file, cwd)),
	);
	r.lifecycleCleanup.push(
		...toIssues("lifecycle_cleanup", relPath, checkLifecycleCleanup(content, file)),
	);
	r.defaultExport.push(...toIssues("default_export", relPath, checkDefaultExport(content, file)));
	r.codeClones.push(...toIssues("code_clones", relPath, checkCodeClones(content, file)));

	// --- Agent safety checks ---
	r.misusedPromises.push(
		...toIssues("misused_promises", relPath, checkMisusedPromises(content, file)),
	);
	r.floatingPromises.push(
		...toIssues("floating_promises", relPath, checkFloatingPromises(content, file)),
	);
	r.broadObjectTypes.push(
		...toIssues("broad_object_types", relPath, checkBroadObjectTypes(content, file)),
	);
	r.booleanTrap.push(...toIssues("boolean_trap", relPath, checkBooleanTrap(content, file)));
	r.positionalOptionalBoolean.push(
		...toIssues(
			"positional_optional_boolean",
			relPath,
			checkPositionalOptionalBoolean(content, file),
		),
	);
	r.manyOptionalParams.push(
		...toIssues("many_optional_params", relPath, checkManyOptionalParams(content, file)),
	);
	r.sameTypedPrimitiveParams.push(
		...toIssues(
			"same_typed_primitive_params",
			relPath,
			checkSameTypedPrimitiveParams(content, file),
		),
	);
	// Comment-vs-behavior drift (Mythos Phase 2 verify-side wiring).
	r.commentClaimsLimitNoGuard.push(
		...toIssues(
			"comment_claims_limit_no_guard",
			relPath,
			checkCommentClaimsLimitNoGuard(content, file),
		),
	);
	r.commentClaimsNullThrowsInstead.push(
		...toIssues(
			"comment_claims_null_throws_instead",
			relPath,
			checkCommentClaimsNullThrowsInstead(content, file),
		),
	);
	r.commentClaimsValidationMissing.push(
		...toIssues(
			"comment_claims_validation_missing",
			relPath,
			checkCommentClaimsValidationMissing(content, file),
		),
	);
	r.commentClaimsIdempotentMutates.push(
		...toIssues(
			"comment_claims_idempotent_mutates",
			relPath,
			checkCommentClaimsIdempotentMutates(content, file),
		),
	);
	r.commentClaimsThrowsDoesnt.push(
		...toIssues(
			"comment_claims_throws_doesnt",
			relPath,
			checkCommentClaimsThrowsDoesnt(content, file),
		),
	);
	r.iteratorInvalidation.push(
		...toIssues("iterator_invalidation", relPath, checkIteratorInvalidation(content, file)),
	);
	r.freshCollectionKeyLookup.push(
		...toIssues(
			"fresh_collection_key_lookup",
			relPath,
			checkFreshCollectionKeyLookup(content, file),
		),
	);
	r.discriminatedUnionExhaustiveness.push(
		...toIssues(
			"discriminated_union_exhaustiveness",
			relPath,
			checkDiscriminatedUnionExhaustiveness(content, file),
		),
	);
	r.indexBoundsUnchecked.push(
		...toIssues(
			"index_bounds_unchecked",
			relPath,
			checkIndexBoundsUnchecked(content, file),
		),
	);
	r.cleanupSkippedOnEarlyExit.push(
		...toIssues(
			"cleanup_skipped_on_early_exit",
			relPath,
			checkCleanupSkippedOnEarlyExit(content, file),
		),
	);
	r.taintedToPrivilegedSink.push(
		...toIssues(
			"tainted_to_privileged_sink",
			relPath,
			checkTaintedToPrivilegedSink(content, file),
		),
	);
	r.awaitStateToctou.push(
		...toIssues("await_state_toctou", relPath, checkAwaitStateToctou(content, file)),
	);
	r.cleanupReentrancy.push(
		...toIssues("cleanup_reentrancy", relPath, checkCleanupReentrancy(content, file)),
	);
	r.boundaryCopyNoRevalidation.push(
		...toIssues(
			"boundary_copy_no_revalidation",
			relPath,
			checkBoundaryCopyNoRevalidation(content, file),
		),
	);
	r.magicLiteralInConditional.push(
		...toIssues(
			"magic_literal_in_conditional",
			relPath,
			checkMagicLiteralInConditional(content, file),
		),
	);
	r.nanCoercionGuard.push(
		...toIssues("nan_coercion_guard", relPath, detectNaNCoercionGuards(content, file)),
	);
	r.unawaitedAsyncAssertion.push(
		...toIssues("unawaited_async_assertion", relPath, detectUnawaitedAsyncAssertions(content, file)),
	);
	r.designSlop.push(...toIssues("design_slop", relPath, detectDesignSlop(content, file)));
	r.arrayPushReturnUsed.push(
		...toIssues("array_push_return_used", relPath, detectReturnArrayPush(content, file)),
	);
	r.arrayIterateeVariadicBuiltin.push(
		...toIssues(
			"array_iteratee_variadic_builtin",
			relPath,
			detectArrayIterateeVariadicBuiltin(content, file),
		),
	);
	r.writeWithoutMkdir.push(
		...toIssues("write_without_mkdir", relPath, detectWriteWithoutMkdir(content, file)),
	);
	r.homedirWriteEscape.push(
		...toIssues("homedir_write_escape", relPath, detectHomedirWriteEscape(content, file)),
	);
	r.duplicatedPolicyConstant.push(
		...toIssues(
			"duplicated_policy_constant",
			relPath,
			detectPolicyConstantDrift(content, file),
		),
	);
	r.typePredicateDrift.push(
		...toIssues("type_predicate_drift", relPath, detectTypePredicateDrift(content, file)),
	);
	runContentHygieneChecks(ctx);
	r.payloadFieldCasing.push(
		...toIssues("payload_field_casing", relPath, detectPayloadFieldCasing(content, file)),
	);
	r.anonymousRegistration.push(
		...toIssues("anonymous_registration", relPath, checkAnonymousRegistration(content, file)),
	);
	// halstead_difficulty — verify-only. Pure, but a full TS parse plus a
	// per-token tally per file: measured, it pushed the determinism-conformance
	// suite (18 inputs x 3 runs) past its 30s budget on the inline path. An
	// advisory taste check that fires 17 times repo-wide does not earn per-edit
	// latency; deep audit is the right cadence.
	r.halsteadDifficulty.push(
		...toIssues("halstead_difficulty", relPath, maintainabilityCheck(content, file)),
	);
	// type_smuggling is verify-only since 2026-08-22 (its per-file ts.Program
	// melted the daemon) — its verify invocation ALREADY lives in
	// file-checks-endpoint-laziness.ts; a second call here double-built the
	// ~1.9GB program per file (external review 2026-08-23, finding 5).
	// property_test_candidate — verify-only: the detector reads the module's
	// companion test files, so it is not the pure (content, filePath) function
	// the PostToolUse registry contract requires (and the determinism-conformance
	// test enforces). Same standing as the resolver-backed checks below.
	r.propertyTestCandidate.push(
		...toIssues("property_test_candidate", relPath, propertyCandidateCheck(content, file)),
	);
	// gitignored_written_config — verify-only (3-arg detector needs git context).
	// Backed by a `git check-ignore` resolver; fails open to "not ignored" off-git.
	r.gitignoredWrittenConfig.push(
		...toIssues(
			"gitignored_written_config",
			relPath,
			detectGitignoredWrites(content, file, makeGitIgnoreResolver(cwd, file)),
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
			detectReadmeScriptDrift(content, file, (markdownPath) =>
				resolveNearestPackageScripts(markdownPath, cwd),
			),
		),
	);
	// spec_path_ref — verify-only (3-arg detector needs a filesystem resolver).
	// Fires on present-tense claims that a path exists in-repo when it does not
	// (Sol D-3). The resolver checks the working tree relative to the verify cwd.
	r.specPathRef.push(
		...toIssues(
			"spec_path_ref",
			relPath,
			checkSpecPathRef(content, file, (target) => existsSync(resolve(cwd, target))),
		),
	);
	// Bun-regression detector pack (2026-07-20): confessed stand-in constants +
	// escape-hatch span pair.
	r.placeholderRuntimeConstant.push(
		...toIssues(
			"placeholder_runtime_constant",
			relPath,
			checkPlaceholderRuntimeConstant(content, file),
		),
	);
	r.rustUnsafeSpan.push(
		...toIssues("rust_unsafe_span", relPath, checkRustUnsafeSpan(content, file)),
	);
	r.suppressionBlockSpan.push(
		...toIssues("suppression_block_span", relPath, checkSuppressionSpan(content, file)),
	);
	r.asyncPromiseExecutor.push(
		...toIssues("async_promise_executor", relPath, checkAsyncPromiseExecutor(content, file)),
	);
	r.selfImports.push(...toIssues("self_import", relPath, checkSelfImport(content, file)));
	r.extraneousDeps.push(
		...toIssues("extraneous_deps", relPath, checkExtraneousDependencies(content, file)),
	);
	r.nonNullAssertions.push(
		...toIssues("non_null_assertion", relPath, checkNonNullAssertions(content, file)),
	);
	r.evalUsage.push(...toIssues("eval_usage", relPath, checkEvalUsage(content, file)));
	r.innerHtml.push(...toIssues("inner_html", relPath, checkInnerHtmlUsage(content, file)));
	r.nanComparison.push(...toIssues("nan_comparison", relPath, checkNanComparison(content, file)));
	r.constantCondition.push(
		...toIssues("constant_condition", relPath, checkConstantCondition(content, file)),
	);
	r.unsafeOptionalChaining.push(
		...toIssues(
			"unsafe_optional_chaining",
			relPath,
			checkUnsafeOptionalChaining(content, file),
		),
	);
	r.numberPrecisionLoss.push(
		...toIssues("number_precision_loss", relPath, checkNumberPrecisionLoss(content, file)),
	);
	r.throwLiteral.push(...toIssues("throw_literal", relPath, checkThrowLiteral(content, file)));
	r.promiseRejectNonError.push(
		...toIssues("promise_reject_non_error", relPath, checkPromiseRejectNonError(content, file)),
	);
	r.rawControlBytes.push(
		...toIssues("raw_control_bytes", relPath, checkRawControlBytes(content, file)),
	);
	r.lossyErrorRethrow.push(
		...toIssues("lossy_error_rethrow", relPath, checkLossyErrorRethrow(content, file)),
	);
	r.importFromOwnBarrel.push(
		...toIssues("import_from_own_barrel", relPath, checkImportFromOwnBarrel(content, file)),
	);
	r.errorDispatchByInstanceof.push(
		...toIssues(
			"error_dispatch_by_instanceof",
			relPath,
			checkErrorDispatchByInstanceof(content, file),
		),
	);
	r.silentPromiseSwallow.push(
		...toIssues("silent_promise_catch", relPath, checkSilentPromiseSwallow(content, file)),
	);
	r.requireAwait.push(...toIssues("require_await", relPath, checkRequireAwait(content, file)));
	r.accumulatingSpread.push(
		...toIssues("accumulating_spread", relPath, checkAccumulatingSpread(content, file)),
	);
	r.manualFieldCopy.push(
		...toIssues("manual_field_copy", relPath, checkManualFieldCopy(content, file)),
	);
}
