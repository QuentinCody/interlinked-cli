// ===========================================
// Tool-Check Loop — config-driven per-check dispatch
// ===========================================
// The main PostToolUse pass: iterate every enabled QualityCheckConfig and run
// its branch (inline content scan, parser-driven file-state check, or a
// subprocess tool via the check engine). Extracted from runQualityChecks so
// the orchestrator stays a thin sequencer. Check order, the per-check
// event-loop yields, and the onCheckBoundary / outToolMetrics instrumentation
// are preserved exactly — this is the PostToolUse pipeline, so behavior must
// not drift.
//
// Each named check branch is a standalone handler returning the findings it
// produced, or `null` to signal "skip the rest of this iteration" — the exact
// equivalent of the original inline `continue`, which skipped the trailing
// onCheckBoundary(`inline_<name>`). A handler returning an array (even empty)
// falls through to the boundary, matching a branch that ran to completion.

import { extname, isAbsolute, resolve, sep } from "node:path";
import { parseNpmAuditJson, parseOsvScannerJson } from "../check-engine/output-parsers.js";
import { runProcessAsync } from "../check-engine/spawn-async.js";
import { isGeneratedFile, isTestFile } from "../checks/shared.js";
import { listWithOverflow } from "../finding-overflow.js";
import { getProfileForFile } from "../language-profiles.js";
import { isOperationalCheckDeferral } from "../operational-check-deferrals.js";
import { tryAcquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";
import type { HarnessEvent, QualityCheckConfig } from "../types.js";
import { resolveDependencyAuditCommandAsync } from "./dependency-audit.js";
import { runInlineLanguageChecks } from "./inline-language-checks.js";
import { MULTI_FILE_NAMED_EXTERNAL_CHECKS } from "./change-set-external.js";
import { findProjectRoot } from "./project-root.js";
import type { QualityCheckResult, ToolBreakdownEntry } from "./result-types.js";
import { containsSecrets } from "./secret-detection.js";
import { collectSoftwareVersionReferences } from "./software-version-regression.js";
import { findAnyTypes } from "./strong-typing.js";
import { isLikelyTestFile } from "./test-classifier.js";
import {
	TEST_DISPATCHERS,
	type TestDispatcher,
} from "./test-dispatchers.js";
import {
	runLockfileDriftCheck,
	runPackageJsonConsistencyCheck,
	runSoftwareVersionChecks,
} from "./tool-check-loop-manifest-checks.js";
import { deferredExternalCheck, runCommandCheck } from "./tool-command-check.js";
import { resolveToolCommand } from "../check-engine/tool-commands.js";

/**
 * Yield the Node event loop so other socket connections in the daemon can
 * be serviced between heavy synchronous check phases. Without this, a
 * single PostToolUse evaluation that spends 20s in pure-JS regex passes
 * starves every concurrent connection — Node only services one request
 * at a time while the main thread is busy. Adding `await yieldEventLoop()`
 * at each loop boundary lets interleaved requests make progress and is
 * what closes the ~23s queue gap measured between
 * `guard_harness_ms` (hook-observed RTT) and `checks_timing_ms` (daemon
 * pipeline wall).
 */
export function yieldEventLoop(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Context the tool-check loop needs from the orchestrator (mostly the
 *  shared file-content accessors so the loop reuses one disk read). */
export interface ToolCheckLoopContext {
	event: HarnessEvent;
	checks: Record<string, QualityCheckConfig>;
	cwd: string;
	filePath: string;
	/** Absolute path used by the skip_test_files guard. */
	absForTestCheck: string;
	/** Basename (no extension) used by the skip_test_files guard. */
	testCheckBaseName: string;
	/** Shared post-edit content accessor (memoized read). */
	getSharedContent: () => string | null;
	/** Memoized collectSoftwareVersionReferences for the post-edit content. */
	getAfterRefs: (content: string) => ReturnType<typeof collectSoftwareVersionReferences>;
	tscFilterFile: string | undefined;
	baseline: { softwareVersions?: ReturnType<typeof collectSoftwareVersionReferences> } | undefined;
	/** Out-parameter — one entry per subprocess tool invocation. */
	outToolMetrics: ToolBreakdownEntry[] | undefined;
	/** Out-parameter — check names that reached a real verdict. Skipped,
	 *  deferred, and thrown handlers never enter this list. */
	outChecksRan?: string[] | undefined;
	/** True when one request-owned ChangeSet batch is responsible for command
	 * checks and named handlers that spawn external processes. */
	skipMultiFileExternalChecks?: boolean | undefined;
	/** False when the edited file is outside the harness's own project. */
	editedFileInRepo: boolean | undefined;
	/** Diagnostic per-check boundary callback. */
	onCheckBoundary: ((name: string) => void) | undefined;
}

/**
 * A per-check handler. Returns the findings it produced (possibly empty), or
 * `null` to skip the trailing per-check boundary — the structural equivalent
 * of the original inline `continue`.
 */
type NamedCheckHandler = (
	ctx: ToolCheckLoopContext,
	name: string,
	check: QualityCheckConfig,
) => QualityCheckResult[] | null | Promise<QualityCheckResult[] | null>;

/** secrets_in_source — inline content scan of the edit payload. */
function runSecretsCheck(
	ctx: ToolCheckLoopContext,
	name: string,
	check: QualityCheckConfig,
): QualityCheckResult[] | null {
	// Skip test files (synthetic fixture secrets) and the harness's
	// own security-pattern definitions (secret-shaped strings as
	// data) — both yield only false positives on a per-edit scan.
	// `isTestFile` bundles both exemptions; its harness-internals
	// block is scoped to interlinked-cli's own package. gitleaks in
	// `interlinked verify` stays the repo-wide backstop.
	if (isTestFile(ctx.absForTestCheck)) return null;
	// Inline check — examine file content from the event
	const content =
		(ctx.event.tool_input?.content as string) ||
		(ctx.event.tool_input?.new_string as string) ||
		"";
	if (content) {
		const found = containsSecrets(content);
		if (found.length > 0) {
			return [
				{
					name,
					severity: check.severity,
					message: `Secrets detected in ${ctx.filePath}: ${found.length} pattern(s) matched`,
					file: ctx.filePath,
				},
			];
		}
	}
	return [];
}

/** strong_typing — scan the whole file for `any`/`unknown`. */
function runStrongTypingCheck(
	ctx: ToolCheckLoopContext,
	name: string,
	check: QualityCheckConfig,
): QualityCheckResult[] | null {
	// Skip test files — tests legitimately use casts for edge case testing
	const fileBase = ctx.filePath.replace(/\.[^.]+$/, "");
	if (fileBase.endsWith(".test") || fileBase.endsWith(".spec")) return null;

	// Inline check — scan the ENTIRE file content for `any`/`unknown`.
	// Uses the shared content snapshot to avoid re-reading the file.
	const content = ctx.getSharedContent();
	if (content === null) return [];
	// 139-repo audit: generator output (OpenAPI, protoc,
	// @generated) routinely uses `any` extensively by
	// design. Supermodel's sdk/DefaultApi.ts produced 290
	// FPs in one file. The fix is to change generator
	// config, not the file.
	if (isGeneratedFile(content)) return null;
	const anyMatches = findAnyTypes(content);
	if (anyMatches.length === 0) return [];
	const anyCount = anyMatches.filter((m) => m.kind === "any").length;
	const unknownCount = anyMatches.filter((m) => m.kind === "unknown").length;
	const parts: string[] = [];
	if (anyCount > 0) parts.push(`${anyCount} \`any\``);
	if (unknownCount > 0) parts.push(`${unknownCount} \`unknown\``);
	return [
		{
			name,
			severity: check.severity,
			message: `${parts.join(" + ")} type(s) in ${ctx.filePath} — prefer strong types (interfaces, generics, branded types)`,
			file: ctx.filePath,
			// Cap 8, above the default: a file with pervasive `any` needs enough
			// lines to show the shape of the problem, not just its first few.
			detail: listWithOverflow(anyMatches, (m) => `  L${m.line}: ${m.text}`, 8),
		},
	];
}

/** dependency_audit — SCA over edited package/lock files. */
async function runDependencyAudit(
	ctx: ToolCheckLoopContext,
	name: string,
	check: QualityCheckConfig,
): Promise<QualityCheckResult[] | null> {
	// SCA: run dependency audit when package/lock files are edited.
	// Detects known CVEs in project dependencies.
	const checkCwd = findProjectRoot(ctx.filePath, ctx.cwd) || ctx.cwd;
	const fileName = ctx.filePath.split("/").pop() || "";
	const release = tryAcquireProjectHeavyProcessLease(checkCwd);
	if (!release) {
		return deferredExternalCheck(
			ctx.filePath,
			name,
			"heavy-process capacity is busy; dependency audit did not run",
		);
	}
	try {
		// Resolution may version-probe osv-scanner, so it belongs inside the same
		// admission lease as the audit itself.
		const resolved = await resolveDependencyAuditCommandAsync(fileName, {
			useOsvScanner: check.use_osv_scanner,
			offline: check.offline,
		});
		if (!resolved) return null;
		const command = resolved.cmd[0];
		if (!command) {
			return deferredExternalCheck(ctx.filePath, name, "audit command was unavailable");
		}

		const auditResult = await runProcessAsync(command, resolved.cmd.slice(1), {
			timeout: check.timeout_ms,
			cwd: checkCwd,
		});
		if (auditResult.timedOut) {
			return deferredExternalCheck(ctx.filePath, name, "dependency audit timed out");
		}
		if (auditResult.killed || (auditResult.code !== null && auditResult.code >= 128)) {
			return deferredExternalCheck(ctx.filePath, name, "dependency audit was interrupted");
		}
		if (auditResult.code === null) {
			return deferredExternalCheck(ctx.filePath, name, "dependency audit runner was unavailable");
		}

		// Every supported tool exits non-zero when vulnerabilities are found.
		if (auditResult.code === 0) return [];

		const stdout = auditResult.stdout.trim();
		let detail = "";
		if (resolved.parser === "osv-scanner") {
			const summary = parseOsvScannerJson(stdout);
			if (!summary) {
				return deferredExternalCheck(
					ctx.filePath,
					name,
					"dependency audit exited non-zero without a parseable report",
				);
			}
			detail = summary.detail;
		} else if (resolved.parser === "npm-audit") {
			const summary = parseNpmAuditJson(stdout);
			if (!summary) {
				return deferredExternalCheck(
					ctx.filePath,
					name,
					"npm audit exited non-zero without a parseable report",
				);
			}
			detail = summary.detail;
		} else {
			// pip-audit / cargo-audit / govulncheck: surface raw stderr tail.
			detail =
				auditResult.stderr.split("\n").slice(0, 5).join("\n") ||
				"vulnerabilities found";
		}

		return [
			{
				name,
				severity: check.severity,
				message: `Dependency vulnerabilities found after editing ${ctx.filePath}`,
				file: ctx.filePath,
				detail: detail || `Run \`${command}\` for details (parser: ${resolved.parser})`,
			},
		];
	} finally {
		release();
	}
}

/** inline_language_checks — data-driven per-language inline pattern checks. */
function runInlineLanguageChecksBranch(
	ctx: ToolCheckLoopContext,
	_name: string,
	_check: QualityCheckConfig,
): QualityCheckResult[] | null {
	// Data-driven per-language inline pattern checks. Reads the
	// inline_checks array declared in the file's LanguageProfile
	// and runs each regex after a language-aware comment + string
	// stripping pass. Replaces what was previously dead config.
	const profile = getProfileForFile(ctx.filePath);
	if (!profile || profile.inline_checks.length === 0) return null;
	const content = ctx.getSharedContent();
	if (content === null) return null;
	const findings = runInlineLanguageChecks(ctx.filePath, content, profile);
	return findings.map((f) => ({
		name: f.name,
		severity: f.severity,
		message: f.message,
		file: f.file,
		detail: f.detail,
	}));
}

/** affected_tests — dispatch per-language test invocation. */
async function runAffectedTests(
	ctx: ToolCheckLoopContext,
	name: string,
	check: QualityCheckConfig,
): Promise<QualityCheckResult[] | null> {
	// Dispatch per-language test invocation. Dispatchers own their own
	// runner shape and scoping (file-level, package-level, or
	// project-wide).
	const absPath = isAbsolute(ctx.filePath) ? ctx.filePath : resolve(ctx.cwd, ctx.filePath);
	const extForTests = extname(absPath);
	const baseForTests = absPath.slice(absPath.lastIndexOf(sep) + 1, -extForTests.length || undefined);
	const profile = getProfileForFile(ctx.filePath);
	if (!profile) return null;
	if (isLikelyTestFile(baseForTests, absPath)) return null;

	// Keep the public registry as the lookup seam. Tests and downstream
	// embedders replace registry entries to supply their own runner, while the
	// widened view accounts for languages that deliberately have no dispatcher.
	const dispatcher = (TEST_DISPATCHERS as Partial<Record<string, TestDispatcher>>)[profile.id];
	if (!dispatcher) return null;

	const checkCwd = findProjectRoot(ctx.filePath, ctx.cwd) || ctx.cwd;
	// Resolve the project's `go_test` command override so the touched-package
	// run carries the configured tags/flags from .interlinked/tool-commands*.json.
	const goTestOverride = resolveToolCommand(checkCwd, "go_test", ["go", "test"], ["./..."]);
	const dispatched = await dispatcher({
		filePath: ctx.filePath,
		absPath,
		profile,
		checkCwd,
		timeoutMs: check.timeout_ms,
		severity: check.severity,
		checkName: name,
		...(check.max_dependent_tests !== undefined
			? { maxDependentTests: check.max_dependent_tests }
			: {}),
		...(goTestOverride ? { commandOverride: goTestOverride } : {}),
	});
	return dispatched.map((r) => ({
		name: r.name,
		severity: r.severity,
		message: r.message,
		file: r.file,
		detail: r.detail,
	}));
}

/** name → handler. Two names (software_version_regression,
 *  freshness_sensitive_reference) share one handler that selects by name. */
const NAMED_CHECK_HANDLERS: Record<string, NamedCheckHandler> = {
	secrets_in_source: runSecretsCheck,
	strong_typing: runStrongTypingCheck,
	dependency_audit: runDependencyAudit,
	inline_language_checks: runInlineLanguageChecksBranch,
	affected_tests: runAffectedTests,
	lockfile_drift: runLockfileDriftCheck,
	package_json_consistency: runPackageJsonConsistencyCheck,
	software_version_regression: runSoftwareVersionChecks,
	freshness_sensitive_reference: runSoftwareVersionChecks,
};

/**
 * Run the config-driven per-check loop and return the findings in push order.
 * Mirrors the original inline loop: same branches, same skip guards, same
 * yields and instrumentation hooks. Per-check bodies live in the
 * NAMED_CHECK_HANDLERS map (and runCommandCheck for the `command` fallback);
 * a handler returning `null` reproduces the original inline `continue` that
 * skipped the trailing onCheckBoundary.
 */
export async function runToolCheckLoop(ctx: ToolCheckLoopContext): Promise<QualityCheckResult[]> {
	const results: QualityCheckResult[] = [];
	const { checks, filePath, absForTestCheck, testCheckBaseName, onCheckBoundary } = ctx;

	for (const [name, check] of Object.entries(checks)) {
		if (!check.enabled) continue;
		if (!check.file_types.some((t) => filePath.endsWith(t))) continue;
		if (
			ctx.skipMultiFileExternalChecks &&
			(check.command || MULTI_FILE_NAMED_EXTERNAL_CHECKS.has(name))
		) {
			continue;
		}

		// Yield to the event loop between checks so concurrent socket
		// connections can be serviced. The cost is one microtask boundary
		// per check; the saving is that an in-flight 20s pipeline no
		// longer starves other connections (closing the ~23s
		// `guard_harness_ms` vs `checks_timing_ms` gap measured in 24h
		// of production telemetry).
		await yieldEventLoop();
		// Diagnostic: close the yield window into a separate bucket so the
		// check body's own time isn't conflated with whatever the event loop
		// serviced during the yield. If `yield_<name>` is large while
		// `inline_<name>` is small, the time was event-loop contention,
		// not the check's regex/AST work.
		onCheckBoundary?.(`yield_${name}`);

		// Skip test files for checks that opt in (e.g., semgrep, gitleaks)
		if (check.skip_test_files && isLikelyTestFile(testCheckBaseName, absForTestCheck)) continue;

		// Skip subprocess / tree-walking `command`-based checks (tsc, biome,
		// semgrep, gitleaks) when the edited file is outside the harness's
		// own project. The `command` fallback below resolves a project
		// root and runs the check engine project-wide; for a foreign file
		// `findProjectRoot` falls back to `cwd`, which would run THIS
		// project's tooling against an unrelated file (wrong result) and
		// pay the project-tree-walk cost. Inline content checks (secrets,
		// strong_typing, software_version_regression, the inline-checks
		// block) carry no `command` and still run for out-of-tree files.
		if (ctx.editedFileInRepo === false && check.command) continue;

		try {
			const handler = NAMED_CHECK_HANDLERS[name];
			let outcome: QualityCheckResult[] | null;
			if (handler) {
				outcome = await handler(ctx, name, check);
			} else if (check.command) {
				outcome = await runCommandCheck(ctx, name, check);
			} else {
				outcome = [];
			}
			// `null` reproduces the original inline `continue`: skip the
			// per-check boundary below. An array (even empty) falls through.
			if (outcome === null) continue;
			results.push(...outcome);
			if (outcome.some((result) => isOperationalCheckDeferral(result.name))) {
				onCheckBoundary?.(`deferred_${name}`);
				continue;
			}
			// Unknown config entries have neither a handler nor a command and do
			// not represent a check execution, even though their no-op iteration is
			// retained for backwards-compatible boundary timing.
			if (handler || check.command) ctx.outChecksRan?.push(name);
		} catch (err) {
			// A handler failure is not clean. Keep the pipeline fail-open, but
			// surface an explicit no-verdict row and classify its timing as
			// deferred rather than completed.
			const msg = err instanceof Error ? err.message : String(err);
			results.push(
				...deferredExternalCheck(ctx.filePath, name, `check handler threw: ${msg}`),
			);
			onCheckBoundary?.(`deferred_${name}`);
			continue;
		}
		// Per-check phase boundary for diagnostic instrumentation. Fires
		// when the check completed (or the config entry was an unknown no-op).
		// Deferred attempts use `deferred_<name>` above so timing telemetry never
		// labels a no-verdict attempt as completed.
		onCheckBoundary?.(`inline_${name}`);
	}

	return results;
}
