// ===========================================
// Check placement — every catalog check is a result or a `not_run` entry
// ===========================================
// `interlinked metrics catalog` lists every check the tool owns. A verify run reports each one exactly once: as a
// result (a key with `issues`, `files`, `details`) or in the `not_run` block with one reason code. `placementFor` is the
// single decision; `computeNotRun` serializes it; `resultLocation` says where the result sits in the JSON. The test in
// `not-run.test.ts` walks the catalog against all three, so a new check cannot land without a place in verify or a reason.

import { catalogSources, type CatalogSource } from "../../lib/metrics/catalog-sources.js";
import type { SkipEntry } from "../../harness/check-engine/types.js";
import { SWEEP_INLINE_IDS } from "./registry-sweep.js";
import { resolveVerifyToolIds } from "./tool-selection.js";

export const NOT_RUN_REASONS = [
	"needs_session",
	"needs_diff",
	"language_not_present",
	"external_tool_missing",
	"opt_in_only",
	"security_scope",
	"measured_by_other_command",
	"not_reported_by_verify",
	"not_selected",
	"not_applicable",
	"external_tool_error",
	"external_tool_timeout",
	"resource_busy",
	"execution_unavailable",
] as const;
export type NotRunReason = (typeof NOT_RUN_REASONS)[number];
export type NotRunEntry = { reason: NotRunReason; detail: string };

export interface NotRunContext {
	/** `--only <tool>`: only that external tool runs. */
	only?: string | undefined;
	allChecks: boolean;
	suggestions: boolean;
	structure: boolean;
	skipChecks: ReadonlySet<string>;
	/** Engine tool ids that ran in this invocation. */
	toolsRun: readonly string[];
	skipped?: readonly SkipEntry[];
	toolsWithFindings?: ReadonlySet<string>;
	excludedTools?: ReadonlySet<string>;
}

/** The invocation's selection, from the command options and the tools that ran. */
export function notRunContextFor(args: {
	only: string | undefined;
	skipChecks: ReadonlySet<string>;
	opts: { allChecks?: boolean | undefined; suggestions?: boolean | undefined; structure?: boolean | undefined };
	toolsRun: readonly { id: string }[];
	skipped: readonly SkipEntry[];
	diagnostics: readonly { tool: string }[];
	hasAuditResult?: boolean;
}): NotRunContext {
	const { only, skipChecks, opts, toolsRun } = args;
	const toolsWithFindings = new Set(args.diagnostics.map((row) => row.tool));
	if (args.hasAuditResult) toolsWithFindings.add("dep-audit");
	return { only, skipChecks, allChecks: Boolean(opts.allChecks), suggestions: Boolean(opts.suggestions), structure: Boolean(opts.structure), toolsRun: toolsRun.map((tool) => tool.id),
		skipped: args.skipped, toolsWithFindings, excludedTools: new Set(resolveVerifyToolIds(skipChecks)) };
}

export type Placement = { kind: "result"; incomplete?: NotRunEntry } | { kind: "not_run"; reason: NotRunReason; detail: string };

const SWEEP_INLINE = new Set(SWEEP_INLINE_IDS);
const SWEEP_STRUCTURAL = new Set(["hallucinated_imports", "cross_package_imports", "undefined_env_vars"]);
/** Structural ids that verify already reports as top-level keys (project parity checks). */
const PARITY_STRUCTURAL = new Set(["cross_file_switch_discriminant", "single_implementation_interface"]);
const SELECTABLE_FAMILIES = new Set(["inline", "spec_ledger"]);
const INLINE_SCAN_FAMILIES = new Set(["inline", "spec_ledger", "suggestion"]);

const NEEDS_SESSION_STRUCTURAL = new Set(["co_dependency_staleness", "completion_tracking", "recently_failed", "redundant_reread", "route_context", "sibling_awareness", "stale_read_warning", "test_first", "test_proximity"]);
const NEEDS_DIFF_STRUCTURAL = new Set(["export_surface", "impact_analysis", "interface_change_impact", "new_import_cycle", "smart_tsc"]);
const OTHER_COMMAND_STRUCTURAL: Record<string, string> = {
	blast_radius: "interlinked check --only blast-radius",
	dead_exports: "interlinked deadcode",
	dead_imports: "interlinked check --only dead-imports",
	duplicate_symbols: "interlinked check --only duplicates",
	import_cycles: "interlinked check --only cycles",
	import_resolution: "interlinked check --only broken-imports",
};

/** tool_quality catalog id -> engine tool id, for checks that run through the external-tool engine. */
export const TOOL_QUALITY_ENGINE: Record<string, string> = {
	actionlint: "actionlint", biome_lint: "biome", c_compile: "c-compile", cargo_check: "cargo-check", cargo_clippy: "cargo-clippy",
	clang_tidy: "clang-tidy", dependency_audit: "dep-audit", eslint: "eslint", gitleaks: "gitleaks", go_build: "go-build",
	golangci_lint: "golangci-lint", hadolint: "hadolint", lint_import: "lint-import", python_typecheck: "mypy", ruff_format: "ruff-format",
	ruff_lint: "ruff", rustfmt_check: "rustfmt", semgrep: "semgrep", shellcheck: "shellcheck", taplo: "taplo", typescript: "tsc",
};
const TOOL_QUALITY_TOP_LEVEL = new Set(["strong_typing"]);
const SELECTABLE_EXTRA_IDS = new Set([...SWEEP_STRUCTURAL, ...PARITY_STRUCTURAL, ...TOOL_QUALITY_TOP_LEVEL]);

const SESSION_FAMILIES: Record<string, string> = {
	guard: "PreToolUse rule: judges one command or path in an agent session",
	sequence: "judges an ordered sequence of tool calls in an agent session",
	behavioral: "judges agent behavior across edits in a session",
};

function notRun(reason: NotRunReason, detail: string): Placement {
	return { kind: "not_run", reason, detail };
}

const RESULT: Placement = { kind: "result" };

function structuralPlacement(id: string, ctx: NotRunContext): Placement {
	if (PARITY_STRUCTURAL.has(id)) return ctx.only ? notRun("not_selected", "--only selected one external tool") : RESULT;
	if (SWEEP_STRUCTURAL.has(id)) {
		if (ctx.only) return notRun("not_selected", "--only selected one external tool");
		return ctx.allChecks ? RESULT : notRun("opt_in_only", "runs with --all-checks");
	}
	if (NEEDS_SESSION_STRUCTURAL.has(id)) return notRun("needs_session", "uses the session tracker (files read, written, failed) of an agent session");
	if (NEEDS_DIFF_STRUCTURAL.has(id)) return notRun("needs_diff", "compares the edited file against its previous version");
	const other = OTHER_COMMAND_STRUCTURAL[id];
	if (other) return notRun("measured_by_other_command", `reported by \`${other}\`, not by verify`);
	if (id === "layer_violations") return notRun("opt_in_only", "needs configured layer rules (structure rule layer_violations, off by default)");
	return notRun("not_reported_by_verify", "structural check with no verify result section");
}

const SKIP_REASONS: Record<SkipEntry["category"], NotRunReason> = {
	config_disabled: "not_selected", file_type_mismatch: "not_applicable", resource_busy: "resource_busy",
	error: "external_tool_error", timeout: "external_tool_timeout", tool_missing: "external_tool_missing",
};

function toolQualityPlacement(id: string, ctx: NotRunContext): Placement {
	if (TOOL_QUALITY_TOP_LEVEL.has(id)) return ctx.only ? notRun("not_selected", "--only selected one external tool") : RESULT;
	const tool = TOOL_QUALITY_ENGINE[id];
	if (tool === undefined) return notRun("not_reported_by_verify", "hook-time check; verify has no result section for it");
	if (ctx.only && !resolveVerifyToolIds([ctx.only]).some((selected) => selected === tool)) return notRun("not_selected", `--only selected ${ctx.only}`);
	if (ctx.excludedTools?.has(tool) || ctx.skipChecks.has(tool)) return notRun("not_selected", `${tool} was excluded by the effective verify selection`);
	const skipped = ctx.skipped?.find((row) => row.check === tool) ?? ctx.skipped?.find((row) => row.check === "external_tools");
	if (skipped) {
		const incomplete = { reason: SKIP_REASONS[skipped.category], detail: skipped.reason };
		if (ctx.toolsRun.includes(tool) || ctx.toolsWithFindings?.has(tool)) return { kind: "result", incomplete };
		return { kind: "not_run", ...incomplete };
	}
	if (ctx.toolsRun.includes(tool)) return RESULT;
	const detail = `No completed run or skip reason was recorded for ${tool}`;
	return ctx.toolsWithFindings?.has(tool) ? { kind: "result", incomplete: { reason: "execution_unavailable", detail } } : notRun("execution_unavailable", detail);
}

/** The scan uses a prefixed ID for spec-ledger checks. Session-only families bypass the skip list. */
function excludedScanId(source: CatalogSource, skipped: ReadonlySet<string>): string | null {
	const selectedId = source.family === "spec_ledger" ? `spec_${source.id}` : source.id;
	const selectionApplies = SELECTABLE_FAMILIES.has(source.family) || SELECTABLE_EXTRA_IDS.has(source.id);
	return selectionApplies && skipped.has(selectedId) ? selectedId : null;
}

/** Where a catalog row stands in this invocation. */
export function placementFor(source: CatalogSource, ctx: NotRunContext): Placement {
	const session = SESSION_FAMILIES[source.family];
	if (session) return notRun("needs_session", session);
	const excluded = excludedScanId(source, ctx.skipChecks);
	if (excluded) return notRun("not_selected", `${excluded} was excluded by the effective verify selection`);
	if (ctx.only && INLINE_SCAN_FAMILIES.has(source.family)) return notRun("not_selected", "--only selected one external tool");
	switch (source.family) {
		case "inline":
			if (SWEEP_INLINE.has(source.id) && !ctx.allChecks) return notRun("opt_in_only", "runs with --all-checks");
			return RESULT;
		case "spec_ledger":
			return ctx.allChecks ? RESULT : notRun("opt_in_only", "runs with --all-checks");
		case "structural":
			return structuralPlacement(source.id, ctx);
		case "suggestion":
			return ctx.suggestions ? RESULT : notRun("opt_in_only", "runs with --suggestions");
		case "tool_quality":
			return toolQualityPlacement(source.id, ctx);
		default:
			return notRun("not_reported_by_verify", `unknown check family ${source.family}`);
	}
}

/** Dotted path of a result in the verify JSON. */
export function resultLocation(source: CatalogSource, _ctx: NotRunContext): string {
	switch (source.family) {
		case "spec_ledger": return `spec_ledger_checks.${source.id}`;
		case "suggestion": return `suggestion_checks.${source.id}`;
		case "structural": return PARITY_STRUCTURAL.has(source.id) ? source.id : `structural_checks.${source.id}`;
		case "tool_quality": return TOOL_QUALITY_TOP_LEVEL.has(source.id) ? source.id : `tool_checks.${source.id}`;
		default: return source.id;
	}
}

/** The `not_run` block of the verify JSON: every catalog row without a result in this invocation, with its reason. */
export function computeNotRun(ctx: NotRunContext): Record<string, NotRunEntry> {
	const out: Record<string, NotRunEntry> = {};
	for (const source of catalogSources()) {
		const placement = placementFor(source, ctx);
		if (placement.kind === "not_run") out[source.key] = { reason: placement.reason, detail: placement.detail };
	}
	return out;
}
