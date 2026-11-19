// ===========================================
// External-tool specs + sequential runner
// ===========================================
// Owns the declarative table of external verifiers (oxlint / gitleaks /
// biome / eslint / tsc / semgrep / knip / docs-check) and the streaming
// runner that spawns them one at a time inside the shared host lane
// and renders their results to stderr.
//
// The orchestrator (`verify.ts`) calls `streamExternalTools` and passes the
// shared `allFlaggedFiles` set + `summary` accumulator through. The single
// available-tool fast path and the queued-with-spinner path both live here.

import { join } from "node:path";
import { TYPED_ESLINT_PROFILE } from "../../lib/lint-import/builtin-profiles.js";

import type { CheckEngine, CheckResult } from "../../harness/check-engine/index.js";
import { loadFileSuppressions } from "../../harness/suppressions.js";
import { nonNull } from "../../lib/non-null.js";
import { measureVerifyCheckAsync, recordVerifyInputDeferral, recordVerifyInputExclusion } from "./check-timing.js";
import { runGitleaksForeground } from "../../harness/check-engine/tool-runners/gitleaks-foreground.js";
import { runRustfmtCheckAsync } from "../../harness/check-engine/tool-runners/rust.js";
import type { ToolInputScope } from "../../harness/check-engine/types.js";
import { currentProcessSignal } from "../../harness/check-engine/process-cancellation.js";
import { projectToolInputMissing, selectApplicableTools } from "../../harness/check-engine/tool-applicability.js";
import { dependencyAuditRequested, runVerifyDependencyAudit, type VerifyAuditOutcome } from "./dependency-audit.js";
import { resolveVerifyToolIds } from "./tool-selection.js";
import { PartialToolReportError } from "../../harness/check-engine/tool-errors.js";
import { parseCompleteGitleaksReport, parseCompleteSemgrepReport } from "../../harness/check-engine/tool-runners/generic-process-verdict.js";
import { parseCompleteBiomeReport } from "../../harness/check-engine/tool-runners/biome-process-verdict.js";
import { biomeForegroundSizeArgs } from "../../harness/check-engine/tool-runners/biome-size-policy.js";
import {
	runToolSilent,
	runToolWithSpinner,
	SPINNER_FRAMES,
	type ToolRun,
} from "./streaming-output.js";

export interface ToolSpec {
	run?: (cwd: string, timeoutMs: number, gitleaksScope?: "working-tree" | "git-visible") => Promise<CheckResult[]>;
	id: import("../../harness/check-engine/types.js").ToolId;
	label: string;
	passLabel: string;
	noun: string;
	severity: string;
	cmd: string[];
}

export const TOOLS_TO_RUN: readonly ToolSpec[] = [
	{
		id: "rustfmt", label: "rustfmt", passLabel: "selected Rust scope is rustfmt-formatted",
		noun: "formatting differences", severity: "33", cmd: ["rustfmt", "--check"],
		run: (cwd, timeoutMs) => runRustfmtCheckAsync({ scope: { projectRoot: cwd, mode: "project" }, timeoutMs, resourcePolicy: "foreground-verify" }),
	},
	{
		id: "oxlint",
		label: "oxlint",
		passLabel: "no issues",
		noun: "issues",
		severity: "33",
		cmd: ["npx", "oxlint", "--format=json", "."],
	},
	{
		id: "gitleaks",
		run: (cwd, timeoutMs, gitleaksScope) => runGitleaksForeground(cwd, timeoutMs, displayToolInputScope, gitleaksScope),
		label: "gitleaks (secrets)",
		passLabel: "no secrets detected",
		noun: "secrets",
		severity: "31",
		cmd: [
			"gitleaks",
			"detect",
			"--no-git",
			"--no-banner",
			"--redact",
			"--report-format",
			"json",
			"--report-path",
			"-",
			"--source",
			".",
		],
	},
	{
		id: "biome",
		label: "biome",
		passLabel: "no issues",
		noun: "issues",
		severity: "33",
		cmd: [
			"npx",
			"--yes",
			"--package",
			"@biomejs/biome",
			"biome",
			"check",
			"--no-errors-on-unmatched",
			"--reporter=json",
			"--max-diagnostics=none",
			".",
		],
	},
	{
		id: "eslint",
		label: "eslint",
		passLabel: "no issues",
		noun: "issues",
		severity: "33",
		cmd: ["npx", "eslint", "--no-error-on-unmatched-pattern", "--format", "json", "."],
	},
	{
		// Type-checker-powered INERT-CODE scanner (2026-09-01): conditions the
		// types prove always-true/false (dead branches, impossible states),
		// inert `as` casts, redundant union members, pointless generics. Runs
		// a dedicated typed config so it never collides with the generic eslint
		// row. Its whole-project execution uses the caller's optional timeout.
		id: "tseslint-types",
		label: "tseslint-types (typed inert code)",
		passLabel: "no type-proven inert code",
		noun: "type-proven inert constructs",
		severity: "33",
		cmd: ["npx", TYPED_ESLINT_PROFILE.tool, "--config", TYPED_ESLINT_PROFILE.config, "--format", "json", TYPED_ESLINT_PROFILE.scope],
	},
	{
		id: "tsc",
		label: "typescript",
		passLabel: "no errors",
		noun: "errors",
		severity: "31",
		cmd: ["npx", "tsc", "--noEmit", "--pretty", "false"],
	},
	{
		id: "semgrep",
		label: "semgrep (SAST)",
		passLabel: "no findings",
		noun: "findings",
		severity: "31",
		cmd: [
			"semgrep",
			"scan",
			"--quiet",
			"--metrics",
			"off",
			"--config",
			"p/default",
			"--json",
			"--timeout", "0",
			"--timeout-threshold", "0",
			"--max-target-bytes", "0",
			".",
		],
	},
	{
		id: "knip",
		label: "knip (dead code)",
		passLabel: "no unused exports or files",
		noun: "issues",
		severity: "33",
		cmd: ["npx", "knip", "--no-progress", "--reporter", "json"],
	},
	{
		// docs:check validates that `gen:*` markers in landing/README/etc.
		// agree with the source-of-truth counts (rule_count, runner_count,
		// node_min_version, …). Mirrors the same step CI runs and the
		// pre-push hook. A drift here was the root cause of the red-CI
		// incident on commit 5452fac.
		id: "docs-check",
		label: "docs:check (gen-marker drift)",
		passLabel: "all gen markers agree with source",
		noun: "drifts",
		severity: "31",
		cmd: ["node", "scripts/check-docs.mjs"],
	},
];

const SPINNER_FRAME_MS = 80;
const MAX_LISTED_FILES = 20;
const MAX_FILE_DETAIL_LINES = 5;
const MESSAGE_MAX_LENGTH = 120;

type AuditResult = import("../../harness/check-engine/types.js").AuditResult;

interface VerifyToolOpts {
	only?: string;
	toolTimeout?: number;
	gitleaksScope?: "working-tree" | "git-visible";
}

interface StreamExternalToolsArgs {
	engine: Pick<CheckEngine, "discoverTools">;
	cwd: string;
	opts: VerifyToolOpts;
	skipChecks: Set<string>;
	summary: Array<{ label: string; count: number; color: string }>;
	allFlaggedFiles: Set<string>;
	details: boolean;
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Run every available external verifier and stream its results to stderr.
 * Single-tool runs use the inline spinner; multi-tool runs fan out and share
 * one aggregate progress line. Adds flagged files to `allFlaggedFiles` and
 * pushes one row per non-clean tool into `summary`.
 */
/** Per-tool output parsers (lazy-loaded so verify's cold start stays cheap).
 *  Extracted from streamExternalTools so that function can hold under the
 *  function-token cap while the tool table grows. */
async function buildToolParsers(cwd: string): Promise<{
	toolParsers: Record<string, (output: string) => CheckResult[]>;
}> {
	const {
		parseTscOutput,
		parseKnipJson,
		parseSemgrepJson,
		parseGitleaksJson,
		parseOxlintJson,
		parseDocsCheckOutput,
	} = await import("../../harness/check-engine/output-parsers.js");
	const { parseEslintJson } = await import("../../harness/check-engine/output-parsers-eslint-json.js");
	return {
		toolParsers: {
			tsc: (out) => parseTscOutput(out),
			eslint: (out) => parseEslintJson(out),
			"tseslint-types": (out) => parseEslintJson(out, "tseslint-types"),
			oxlint: (out) => parseOxlintJson(out),
			knip: (out) => parseKnipJson(out),
			semgrep: (out) => parseSemgrepJson(out, cwd),
			gitleaks: (out) => parseGitleaksJson(out),
			"docs-check": (out) => parseDocsCheckOutput(out),
		},
	};
}

function parseToolOutput(tool: ToolSpec, output: string, status: number | null, parsers: Record<string, (output: string) => CheckResult[]>, cwd: string): CheckResult[] {
	if (tool.id === "biome") {
		const results = parseCompleteBiomeReport(output, cwd);
		if (status !== 0 && status !== 1) throw new PartialToolReportError(`Biome exited ${status}; no complete verdict`, results);
		return results;
	}
	if (tool.id === "gitleaks") {
		const results = parseCompleteGitleaksReport(output);
		if (status !== 0 && status !== 1) throw new PartialToolReportError(`Gitleaks exited ${status}; no complete verdict`, results);
		return results;
	}
	if (tool.id === "knip" && status === 2) throw new PartialToolReportError("Knip could not complete its scan", []);
	if (tool.id === "semgrep") {
		const results = parseCompleteSemgrepReport(output, cwd);
		if (status !== 0 && status !== 1) throw new PartialToolReportError(`Semgrep exited ${status}; no complete verdict`, results);
		return results;
	}
	// Successful analyzers can still report findings (for example Semgrep).
	const parser = parsers[tool.id];
	return parser ? parser(output) : [];
}

function recoverPartialToolFindings(error: unknown): CheckResult[] | undefined {
	return error instanceof PartialToolReportError ? error.results : undefined;
}

function reportStream(tool: ToolSpec): "stdout" | "combined" {
	return ["tsc", "docs-check"].includes(tool.id) ? "combined" : "stdout";
}

export async function streamExternalTools(args: StreamExternalToolsArgs): Promise<void> {
	const { cwd, opts, skipChecks, summary, allFlaggedFiles, details } = args;
	const { toolParsers } = await buildToolParsers(cwd);
	streamUnknownToolProbes(args);
	streamProjectToolCoverage(args);

	const availableTools = availableToolSpecs(args);

	const runDepAudit = dependencyAuditRequested(opts.only, skipChecks) && !projectToolInputMissing("dep-audit", cwd);
	const interlinkedDir = join(cwd, ".interlinked");
	const toolsStart = Date.now();
	const toolCount = availableTools.length + (runDepAudit ? 1 : 0);

	function displayToolResult(
		tool: ToolSpec,
		rawResults: ToolRun<CheckResult>,
	): void {
		const unavailable = displayUnavailable(tool.id, tool.label, rawResults);
		const filteredItems = rawResults.items.filter((item) => {
			const fileSup = loadFileSuppressions(interlinkedDir, item.file);
			return !fileSup.has(tool.id);
		});
		const elapsed = rawResults.elapsedMs;

		if (filteredItems.length === 0) {
			if (unavailable) return;
			process.stderr.write(`\n  \x1b[1m${tool.label}\x1b[0m \x1b[2m${elapsed}\x1b[0m\n`);
			process.stderr.write(`    \x1b[32m✓\x1b[0m ${tool.passLabel}\n`);
			return;
		}
		const toolFiles = new Set(filteredItems.map((r) => r.file));
		for (const f of toolFiles) allFlaggedFiles.add(f);
		process.stderr.write(`\n  \x1b[1m${tool.label}\x1b[0m \x1b[2m${elapsed}\x1b[0m\n`);
		process.stderr.write(
			`    \x1b[${tool.severity}m✗\x1b[0m \x1b[${tool.severity}m${filteredItems.length}\x1b[0m ${tool.noun} in \x1b[${tool.severity}m${toolFiles.size}\x1b[0m files\n`,
		);
		summary.push({
			label: `${filteredItems.length} ${tool.label} ${tool.noun}`,
			count: filteredItems.length,
			color: tool.severity,
		});
		for (const file of [...toolFiles].sort().slice(0, MAX_LISTED_FILES)) {
			process.stderr.write(`\x1b[2m         ${file}\x1b[0m\n`);
			if (details) {
				for (const r of filteredItems
					.filter((r) => r.file === file)
					.slice(0, MAX_FILE_DETAIL_LINES)) {
					process.stderr.write(
						`\x1b[2m           L${r.line}: ${r.message.slice(0, MESSAGE_MAX_LENGTH)}\x1b[0m\n`,
					);
				}
			}
		}
		if (toolFiles.size > MAX_LISTED_FILES) {
			process.stderr.write(
				`\x1b[2m         ... and ${toolFiles.size - MAX_LISTED_FILES} more files\x1b[0m\n`,
			);
		}
	}

	if (toolCount <= 1 && availableTools.length === 1 && !runDepAudit) {
		currentProcessSignal()?.throwIfAborted();
		const tool = nonNull(availableTools[0]);
		const rawResults = await measureVerifyCheckAsync(tool.id, () => runToolWithSpinner({
			label: tool.label,
			...(tool.run ? { run: tool.run.bind(undefined, cwd, opts.toolTimeout ?? 0, opts.gitleaksScope) } : {}),
			cmd: tool.cmd,
			cwd,
			timeoutMs: opts.toolTimeout ?? 0,
			parseOutput: (output, status) => parseToolOutput(tool, output, status, toolParsers, cwd),
			reportStream: reportStream(tool), recoverPartial: recoverPartialToolFindings,
		}));
		currentProcessSignal()?.throwIfAborted();
		displayToolResult(tool, rawResults);
		return;
	}
	if (toolCount === 0) return;

	let frame = 0;
	let completed = 0;
	const remaining = new Set(availableTools.map((t) => t.label));
	if (runDepAudit) remaining.add("dep audit");

	const spinner = setInterval(() => {
		const secs = ((Date.now() - toolsStart) / 1000).toFixed(0);
		const f = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
		const pending = [...remaining].join(", ");
		process.stderr.write(
			`\r\x1b[K  \x1b[36m${f}\x1b[0m \x1b[1m${completed}/${toolCount}\x1b[0m \x1b[2m${secs}s — waiting: ${pending}\x1b[0m`,
		);
		frame++;
	}, SPINNER_FRAME_MS);

	try {
		for (const tool of availableTools) {
			currentProcessSignal()?.throwIfAborted();
			const rawResults = await measureVerifyCheckAsync(tool.id, () => runToolSilent({
				cmd: tool.cmd,
				...(tool.run ? { run: tool.run.bind(undefined, cwd, opts.toolTimeout ?? 0, opts.gitleaksScope) } : {}),
				cwd,
				timeoutMs: opts.toolTimeout ?? 0,
				parseOutput: (output, status) => parseToolOutput(tool, output, status, toolParsers, cwd),
				reportStream: reportStream(tool), recoverPartial: recoverPartialToolFindings,
			}));
			currentProcessSignal()?.throwIfAborted();
			process.stderr.write("\r\x1b[K");
			displayToolResult(tool, rawResults);
			completed++;
			remaining.delete(tool.label);
		}

		if (runDepAudit) {
			currentProcessSignal()?.throwIfAborted();
			const audit = await measureVerifyCheckAsync("sca", () => runVerifyDependencyAudit(cwd, opts.toolTimeout ?? 0));
			currentProcessSignal()?.throwIfAborted();
			process.stderr.write("\r\x1b[K");
			displayAuditOutcome(audit, summary);
			completed++;
			remaining.delete("dep audit");
		}
	} finally {
		clearInterval(spinner);
		process.stderr.write("\r\x1b[K");
	}

	const toolsElapsed = ((Date.now() - toolsStart) / 1000).toFixed(1);
	process.stderr.write(`\x1b[2m  all tools completed in ${toolsElapsed}s (sequential)\x1b[0m\n`);
}

/** Resolve per-project command arguments without mutating the shared tool table. */
function availableToolSpecs({ engine, cwd, opts, skipChecks }: StreamExternalToolsArgs): ToolSpec[] {
	return TOOLS_TO_RUN.filter(tool => {
		if (opts.only && opts.only !== tool.id && opts.only !== tool.label) return false;
		if (skipChecks.has(tool.id)) return false;
		if (tool.id === "rustfmt" && selectApplicableTools([{ id: "rustfmt", available: true }], { projectRoot: cwd, mode: "project" }, { resourcePolicy: "foreground-verify" }).skipped.length) return false;
		if (tool.id === "docs-check" && projectToolInputMissing(tool.id, cwd)) return false;
		return engine.discoverTools().find(candidate => candidate.id === tool.id)?.available;
	}).map(tool => tool.id === "biome" ? { ...tool, cmd: [...tool.cmd.slice(0, -1), ...biomeForegroundSizeArgs(cwd), "."] } : tool);
}

function streamUnknownToolProbes({ engine, cwd, opts, skipChecks }: StreamExternalToolsArgs): void {
	const selected = opts.only ? resolveVerifyToolIds([opts.only === "sca" ? "dep-audit" : opts.only]) : undefined;
	const unknown = engine.discoverTools().filter(tool => tool.probeError && !skipChecks.has(tool.id)
		&& !(tool.id === "dep-audit" && skipChecks.has("sca")) && (!selected || selected.includes(tool.id)));
	for (const tool of selectApplicableTools(unknown, { projectRoot: cwd, mode: "project" }, { resourcePolicy: "foreground-verify" }).applicable) {
		if (tool.probeError) displayUnavailable(tool.id, TOOLS_TO_RUN.find(spec => spec.id === tool.id)?.label ?? tool.id,
			{ items: [], elapsedMs: "0.0s", unavailable: tool.probeError });
	}
}

/** Relevant legacy language tools have no managed async runner yet. Keep that
 * capability gap explicit in human output, just as the JSON engine does. */
function streamProjectToolCoverage({ engine, cwd, opts, skipChecks }: StreamExternalToolsArgs): void {
	const selected = opts.only ? resolveVerifyToolIds([opts.only === "sca" ? "dep-audit" : opts.only]) : undefined;
	const projectTools = engine.discoverTools().filter(tool => ["rustfmt", "c-compile", "docs-check", "dep-audit"].includes(tool.id)
		&& (tool.available || Boolean(opts.only))
		&& !skipChecks.has(tool.id) && !(tool.id === "dep-audit" && skipChecks.has("sca")) && (!selected || selected.includes(tool.id)));
	const selection = selectApplicableTools(projectTools, { projectRoot: cwd, mode: "project" }, { resourcePolicy: "foreground-verify" });
	for (const row of selection.skipped) {
		if (row.category === "error") displayUnavailable(row.check, row.check, { items: [], elapsedMs: "0.0s", unavailable: row.reason });
		else process.stderr.write(`\n  ${row.check}: ${row.category === "config_disabled" ? "EXCLUDED" : "NOT APPLICABLE"} — ${row.reason}\n`);
	}
	for (const tool of selection.applicable.filter(tool => tool.available && tool.id === "c-compile")) displayUnavailable(tool.id, tool.id, {
		items: [], elapsedMs: "0.0s", unavailable: "async runner unavailable for this tool; no verification verdict",
	});
}

function displayUnavailable(check: string, label: string, result: ToolRun<unknown>): boolean {
	if (!result.unavailable) return false;
	recordVerifyInputDeferral(check, { file: "<project>", reason: result.unavailable });
	process.stderr.write(`\n  ${label}: NOT CHECKED — ${result.unavailable}\n`);
	process.exitCode = 75;
	return true;
}

function displayToolInputScope(scope: ToolInputScope): void {
	for (const input of scope.excludedInputs) recordVerifyInputExclusion(scope.tool, input);
	for (const input of scope.unavailableInputs) recordVerifyInputDeferral(scope.tool, input);
	process.stderr.write(`\n  ${scope.tool} working-input scope: ${scope.selectedFiles} files, ${scope.targets.length} native targets\n`);
	for (const input of scope.excludedInputs) process.stderr.write(`    excluded ${JSON.stringify(input.file)} — ${input.reason}\n`);
	for (const input of scope.unavailableInputs) process.stderr.write(`    unavailable ${JSON.stringify(input.file)} — ${input.reason}\n`);
	for (const limitation of scope.nativeLimitations ?? []) process.stderr.write(`    native policy — ${limitation}\n`);
}

function displayAuditOutcome(outcome: VerifyAuditOutcome, summary: { label: string; count: number; color: string }[]): void {
	if (outcome.skipped?.category === "file_type_mismatch") {
		process.stderr.write(`\n  dependency audit: NOT APPLICABLE — ${outcome.skipped.reason}\n`);
		return;
	}
	if (outcome.skipped) displayUnavailable("dep-audit", "dependency audit", { items: [], elapsedMs: "0.0s", unavailable: outcome.skipped.reason });
	if (outcome.audit || !outcome.skipped) displayDependencyAudit({ items: outcome.audit ? [outcome.audit] : [], elapsedMs: `${(outcome.elapsedMs / 1000).toFixed(1)}s` }, summary);
}

function displayDependencyAudit(result: ToolRun<AuditResult>, summary: { label: string; count: number; color: string; }[]) {
    if (displayUnavailable("sca", "dependency audit", result)) return;
    const auditResult = result.items[0] ?? null;
    if (auditResult) {
        const sc = auditResult.critical > 0 || auditResult.high > 0 ? "31" : "33";
        process.stderr.write(
            `\n  \x1b[1mdependency audit (SCA)\x1b[0m \x1b[2m${result.elapsedMs}\x1b[0m\n`
        );
        process.stderr.write(
            `    \x1b[${sc}m✗\x1b[0m \x1b[${sc}m${auditResult.total}\x1b[0m vulnerabilities (${auditResult.detail})\n`
        );
        summary.push({
            label: `${auditResult.total} dep vulnerabilities`,
            count: auditResult.total,
            color: sc,
        });
    } else {
        process.stderr.write(
            `\n  \x1b[1mdependency audit (SCA)\x1b[0m \x1b[2m${result.elapsedMs}\x1b[0m\n`
        );
        process.stderr.write("    \x1b[32m✓\x1b[0m no known vulnerabilities\n");
    }
}
