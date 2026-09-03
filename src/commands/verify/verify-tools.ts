// ===========================================
// External-tool specs + parallel runner
// ===========================================
// Owns the declarative table of external verifiers (oxlint / gitleaks /
// biome / eslint / tsc / semgrep / knip / docs-check) and the streaming
// runner that spawns them — in parallel when more than one is available —
// and renders their results to stderr.
//
// The orchestrator (`verify.ts`) calls `streamExternalTools` and passes the
// shared `allFlaggedFiles` set + `summary` accumulator through. The single
// available-tool fast path and the parallel-with-spinner path both live here.

import { join } from "node:path";

import type { CheckEngine, CheckResult } from "../../harness/check-engine/index.js";
import {
	buildToolCommandArgv,
	resolveToolCommand,
} from "../../harness/check-engine/tool-commands.js";
import { loadFileSuppressions } from "../../harness/suppressions.js";
import { nonNull } from "../../lib/non-null.js";
import {
	runToolSilent,
	runToolWithSpinner,
	SPINNER_FRAMES,
} from "./streaming-output.js";

export interface ToolSpec {
	id: import("../../harness/check-engine/types.js").ToolId;
	label: string;
	passLabel: string;
	noun: string;
	severity: string;
	cmd: string[];
	/** True when the tool runs only under an explicit `--only <id>` on the
	 *  default streaming path (never in an unfiltered `interlinked verify`).
	 *  The JSON path and `interlinked check` gate the same tool via
	 *  CheckEngine.shouldRunByDefault instead. */
	requestedOnly?: boolean;
	/** Per-run timeout; falls back to DEFAULT_TOOL_TIMEOUT_MS. Filled from
	 *  tool-commands `timeout_ms` for configurable tools at stream time. */
	timeoutMs?: number;
}

export const TOOLS_TO_RUN: readonly ToolSpec[] = [
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
		label: "gitleaks (secrets)",
		passLabel: "no secrets detected",
		noun: "secrets",
		severity: "31",
		cmd: [
			"gitleaks",
			"detect",
			"--no-git",
			"--no-banner",
			"--report-format",
			"json",
			"--report-path",
			"/dev/stdout",
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
			".",
		],
	},
	{
		id: "eslint",
		label: "eslint",
		passLabel: "no issues",
		noun: "issues",
		severity: "33",
		cmd: ["npx", "eslint", "--no-error-on-unmatched-pattern", "--format", "unix", "."],
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
			"--no-git-ignore",
			"--metrics",
			"off",
			"--config",
			"p/default",
			"--json",
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
	{
		// Full-suite Go test runner (opt-in). `requestedOnly` keeps it out of
		// unfiltered `interlinked verify` (the default gate debate is deferred);
		// the cmd is resolved below from .interlinked/tool-commands*.json so a
		// configured `go_test` (build tags etc.) is honored exactly.
		id: "go-test",
		label: "go test",
		passLabel: "all tests passed",
		noun: "failing tests",
		severity: "31",
		cmd: ["go", "test", "./..."],
		requestedOnly: true,
	},
];

const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_DEP_AUDIT_TIMEOUT_MS = 30_000;
const SPINNER_FRAME_MS = 80;
const MAX_LISTED_FILES = 20;
const MAX_FILE_DETAIL_LINES = 5;
const MESSAGE_MAX_LENGTH = 120;

type AuditResult = import("../../harness/check-engine/types.js").AuditResult;

export interface VerifyToolOpts {
	only?: string;
}

export interface StreamExternalToolsArgs {
	engine: CheckEngine;
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
export async function streamExternalTools(args: StreamExternalToolsArgs): Promise<void> {
	const { engine, cwd, opts, skipChecks, summary, allFlaggedFiles, details } = args;
	const {
		parseTscOutput,
		parseBiomeOutput,
		parseEslintOutput,
		parseKnipJson,
		parseSemgrepJson,
		parseGitleaksJson,
		parseOxlintJson,
		parseNpmAuditJson,
		parseDocsCheckOutput,
		parseGoTestOutput,
	} = await import("../../harness/check-engine/output-parsers.js");

	const toolParsers: Record<string, (output: string) => CheckResult[]> = {
		tsc: (out) => parseTscOutput(out),
		biome: (out) => parseBiomeOutput(out),
		eslint: (out) => parseEslintOutput(out),
		oxlint: (out) => parseOxlintJson(out),
		knip: (out) => parseKnipJson(out),
		semgrep: (out) => parseSemgrepJson(out, cwd),
		gitleaks: (out) => parseGitleaksJson(out),
		"docs-check": (out) => parseDocsCheckOutput(out),
	};

	// Resolve configurable tools (go-test) against .interlinked/tool-commands*:
	// the configured argv replaces the static placeholder so `--only go-test`
	// runs the project's exact test command (tags etc.).
	const toolsToRun = TOOLS_TO_RUN.map((tool) => {
		if (tool.id !== "go-test") return tool;
		const override = resolveToolCommand(cwd, "go_test", ["go", "test"], ["./..."]);
		return {
			...tool,
			cmd: buildToolCommandArgv(override, ["go", "test"], ["./..."]),
			timeoutMs: override?.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
		};
	});

	const availableTools = toolsToRun.filter((tool) => {
		// requestedOnly tools (go-test) never participate in an unfiltered run.
		if (tool.requestedOnly && !opts.only) return false;
		if (opts.only && opts.only !== tool.id && opts.only !== tool.label) return false;
		if (skipChecks.has(tool.id)) return false;
		const avail = engine.discoverTools().find((t) => t.id === tool.id);
		return avail?.available;
	});

	const runDepAudit =
		(!opts.only || opts.only === "sca") &&
		!skipChecks.has("sca") &&
		!skipChecks.has("dep-audit");
	const interlinkedDir = join(cwd, ".interlinked");
	const parallelStart = Date.now();
	const toolCount = availableTools.length + (runDepAudit ? 1 : 0);

	function displayToolResult(
		tool: ToolSpec,
		rawResults: { items: CheckResult[]; elapsedMs: string },
	): void {
		const filteredItems = rawResults.items.filter((item) => {
			const fileSup = loadFileSuppressions(interlinkedDir, item.file);
			return !fileSup.has(tool.id);
		});
		const elapsed = rawResults.elapsedMs;

		if (filteredItems.length === 0) {
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

	function displayDepAuditResult(result: { items: AuditResult[]; elapsedMs: string }): void {
		const auditResult = result.items[0] ?? null;
		if (auditResult) {
			const sc = auditResult.critical > 0 || auditResult.high > 0 ? "31" : "33";
			process.stderr.write(
				`\n  \x1b[1mdependency audit (SCA)\x1b[0m \x1b[2m${result.elapsedMs}\x1b[0m\n`,
			);
			process.stderr.write(
				`    \x1b[${sc}m✗\x1b[0m \x1b[${sc}m${auditResult.total}\x1b[0m vulnerabilities (${auditResult.detail})\n`,
			);
			summary.push({
				label: `${auditResult.total} dep vulnerabilities`,
				count: auditResult.total,
				color: sc,
			});
		} else {
			process.stderr.write(
				`\n  \x1b[1mdependency audit (SCA)\x1b[0m \x1b[2m${result.elapsedMs}\x1b[0m\n`,
			);
			process.stderr.write("    \x1b[32m✓\x1b[0m no known vulnerabilities\n");
		}
	}

	function parseToolOutput(tool: ToolSpec, output: string, status: number | null): CheckResult[] {
		if (tool.id === "go-test") {
			// Go test: exit 0 = green; non-zero = parsed failing units (the
			// parser emits a generic whole-run finding when no unit isolates).
			if (status === 0) return [];
			return parseGoTestOutput(output, status ?? -1);
		}
		if (
			tool.id === "gitleaks" &&
			status === 1 &&
			(output.includes("FTL") || output.includes("no such file"))
		) {
			return [];
		}
		if ((tool.id === "semgrep" || tool.id === "knip") && status === 2) return [];
		if (status === 0 && tool.id !== "tsc") return [];
		const parser = toolParsers[tool.id];
		return parser ? parser(output) : [];
	}

	if (toolCount <= 1 && availableTools.length === 1 && !runDepAudit) {
		const tool = nonNull(availableTools[0]);
		const rawResults = await runToolWithSpinner({
			label: tool.label,
			cmd: tool.cmd,
			cwd,
			timeoutMs: tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
			parseOutput: (output, status) => parseToolOutput(tool, output, status),
		});
		displayToolResult(tool, rawResults);
		return;
	}
	if (toolCount === 0) return;

	let frame = 0;
	let completed = 0;
	const remaining = new Set(availableTools.map((t) => t.label));
	if (runDepAudit) remaining.add("dep audit");

	const spinner = setInterval(() => {
		const secs = ((Date.now() - parallelStart) / 1000).toFixed(0);
		const f = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
		const pending = [...remaining].join(", ");
		process.stderr.write(
			`\r\x1b[K  \x1b[36m${f}\x1b[0m \x1b[1m${completed}/${toolCount}\x1b[0m \x1b[2m${secs}s — waiting: ${pending}\x1b[0m`,
		);
		frame++;
	}, SPINNER_FRAME_MS);

	const allDone: Promise<void>[] = [];

	for (const tool of availableTools) {
		allDone.push(
			runToolSilent({
				cmd: tool.cmd,
				cwd,
				timeoutMs: tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
				parseOutput: (output, status) => parseToolOutput(tool, output, status),
			}).then((rawResults) => {
				process.stderr.write("\r\x1b[K");
				displayToolResult(tool, rawResults);
				completed++;
				remaining.delete(tool.label);
			}),
		);
	}

	if (runDepAudit) {
		allDone.push(
			runToolSilent({
				cmd: ["npm", "audit", "--json", "--audit-level=moderate"],
				cwd,
				timeoutMs: DEFAULT_DEP_AUDIT_TIMEOUT_MS,
				parseOutput: (output) => {
					const audit = parseNpmAuditJson(output);
					return audit ? [audit] : [];
				},
			}).then((depResult) => {
				process.stderr.write("\r\x1b[K");
				displayDepAuditResult(depResult);
				completed++;
				remaining.delete("dep audit");
			}),
		);
	}

	await Promise.all(allDone);
	clearInterval(spinner);
	process.stderr.write("\r\x1b[K");

	const parallelElapsed = ((Date.now() - parallelStart) / 1000).toFixed(1);
	process.stderr.write(`\x1b[2m  all tools completed in ${parallelElapsed}s (parallel)\x1b[0m\n`);
}
