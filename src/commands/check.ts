// ===========================================
// Check Command — Project-wide structural issue scan
// ===========================================
// Scans the project using the same checks the harness runs in real-time,
// giving a full picture of existing issues before agents start working.
// Optionally runs external tool checks (tsc, biome, mypy, etc.) via CheckEngine.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { CheckEngine, type CheckReport, type ToolId } from "../harness/check-engine/index.js";
import { RUNNABLE_TOOL_IDS } from "../harness/check-engine/tool-catalog.js";
import { ProjectGraph } from "../harness/project-graph.js";
import { containsSecrets, findAnyTypes } from "../harness/quality-checks.js";
import { findDeadImports } from "./check-dead-imports.js";
import {
	emitEngineOnly,
	emitFullSummary,
	emitJsonOutput,
	emitStructuralOnly,
	type StructuralCheckResult,
} from "./check-output.js";

// Re-exported for callers/tests that import the dead-import helpers directly.
export { extractBindings, findDeadImports } from "./check-dead-imports.js";

// Helper: returns true if any symbol in the import edge is not exported by the target file.
function hasMissingSymbol(importSymbols: string[], exportedNames: Set<string>): boolean {
	for (const sym of importSymbols) {
		if (!exportedNames.has(sym)) return true;
	}
	return false;
}

interface CycleRecordContext {
	cycle: string[];
	files: Set<string>;
	visited: Set<string>;
	toRelative: (f: string) => string;
}

// Helper: records every file in a cycle as affected and marks them visited.
function recordCycleFiles(ctx: CycleRecordContext): void {
	for (const f of ctx.cycle) {
		ctx.files.add(ctx.toRelative(f));
		ctx.visited.add(f);
	}
}

// --- Individual structural-check scanners -------------------------------
// Each returns the set of (relative) files flagged by that check. They mirror
// the inline blocks that previously lived in checkCommand, extracted so the
// orchestrator stays a thin dispatcher.

function scanBrokenImports(graph: ProjectGraph): Set<string> {
	const files = new Set<string>();
	for (const file of graph.allFiles()) {
		const edges = graph.getDependencies(file);
		for (const edge of edges) {
			if (!edge.toFile) continue;
			if (edge.specifier.endsWith(".json")) continue;
			if (edge.toFile.includes("/node_modules/")) continue;
			if (!existsSync(edge.toFile)) {
				files.add(graph.toRelative(file));
				break;
			}
			if (edge.symbols.length > 0) {
				const targetExports = graph.getExports(edge.toFile);
				const targetNames = new Set(targetExports.map((e) => e.name));
				targetNames.add("default");
				if (hasMissingSymbol(edge.symbols, targetNames)) {
					files.add(graph.toRelative(file));
				}
			}
		}
	}
	return files;
}

function scanCycles(graph: ProjectGraph): Set<string> {
	const files = new Set<string>();
	const visited = new Set<string>();
	const toRel = (f: string): string => graph.toRelative(f);
	for (const file of graph.allFiles()) {
		if (visited.has(file)) continue;
		const cycles = graph.findCyclesThrough(file);
		for (const cycle of cycles) {
			recordCycleFiles({ cycle, files, visited, toRelative: toRel });
		}
	}
	return files;
}

function scanDuplicates(graph: ProjectGraph): Set<string> {
	const files = new Set<string>();
	const symbolIndex = new Map<string, string[]>();
	for (const file of graph.allFiles()) {
		const boundary = graph.getProjectBoundary(file);
		const exports = graph.getExports(file);
		for (const exp of exports) {
			if (exp.name === "default" || exp.name === "*" || exp.isTypeOnly) continue;
			if (exp.kind === "re-export") continue;
			const key = `${exp.name}::${boundary}`;
			const existing = symbolIndex.get(key);
			if (existing) {
				existing.push(file);
			} else {
				symbolIndex.set(key, [file]);
			}
		}
	}
	for (const [, dupes] of symbolIndex) {
		if (dupes.length > 1) {
			for (const f of dupes) {
				files.add(graph.toRelative(f));
			}
		}
	}
	return files;
}

// Helper: true if a source file is exempt from the missing-tests scan by path
// or name convention (test/spec/decl/index/config/setup/fixtures/etc.).
function isMissingTestExempt(file: string, base: string): boolean {
	if (base.endsWith(".test") || base.endsWith(".spec") || base.endsWith(".d")) return true;
	if (base === "index") return true;
	if (file.endsWith(".d.ts")) return true;
	if (/\.config\.|\.setup\./.test(basename(file))) return true;
	if (file.includes("__tests__") || file.includes("__mocks__")) return true;
	if (file.includes("/test/") || file.includes("/tests/")) return true;
	if (file.includes("/fixtures/") || file.includes("/__fixtures__/")) return true;
	if (file.includes("/orchestration-scripts/") || file.includes("/templates/")) return true;
	return false;
}

function scanMissingTests(graph: ProjectGraph): Set<string> {
	const files = new Set<string>();
	for (const file of graph.allFiles()) {
		const ext = extname(file);
		if (![".ts", ".tsx", ".js", ".jsx"].includes(ext)) continue;
		const base = basename(file, ext);
		if (isMissingTestExempt(file, base)) continue;

		const dir = dirname(file);
		const candidates = [
			join(dir, `${base}.test${ext}`),
			join(dir, `${base}.spec${ext}`),
			join(dir, "__tests__", `${base}.test${ext}`),
			join(dir, "__tests__", `${base}.spec${ext}`),
		];
		if (!candidates.some((c) => existsSync(c))) {
			files.add(graph.toRelative(file));
		}
	}
	return files;
}

interface ContentScanOpts {
	allowedExts: string[];
	skipDecl: boolean;
	skipTestDirs: boolean;
	detector: (content: string) => boolean;
}

// Helper: scans every source file's content through a detector, collecting
// relative paths of files whose detector reports at least one finding. Shared
// by the secrets and any-types scans (which differ in ext-filter, decl-skip,
// test-dir skip, and detector). Unreadable files are skipped.
function scanFileContent(graph: ProjectGraph, scan: ContentScanOpts): Set<string> {
	const files = new Set<string>();
	for (const file of graph.allFiles()) {
		const ext = extname(file);
		if (!scan.allowedExts.includes(ext)) continue;
		if (scan.skipDecl && file.endsWith(".d.ts")) continue;
		const base = basename(file, ext);
		if (base.endsWith(".test") || base.endsWith(".spec")) continue;
		if (scan.skipTestDirs) {
			if (file.includes("__tests__") || file.includes("__mocks__")) continue;
			if (file.includes("/test/") || file.includes("/tests/")) continue;
		}
		try {
			const content = readFileSync(file, "utf-8");
			if (scan.detector(content)) {
				files.add(graph.toRelative(file));
			}
		} catch (_) {
			/* intentional: unreadable file during scan, skip content check */
		}
	}
	return files;
}

function scanSecrets(graph: ProjectGraph): Set<string> {
	return scanFileContent(graph, {
		allowedExts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		skipDecl: false,
		skipTestDirs: true,
		detector: (content) => containsSecrets(content).length > 0,
	});
}

function scanAnyTypes(graph: ProjectGraph): Set<string> {
	return scanFileContent(graph, {
		allowedExts: [".ts", ".tsx"],
		skipDecl: true,
		skipTestDirs: false,
		detector: (content) => findAnyTypes(content).length > 0,
	});
}

function scanBlastRadius(graph: ProjectGraph): Set<string> {
	const files = new Set<string>();
	for (const file of graph.allFiles()) {
		const dependents = graph.getDependents(file);
		if (dependents.length >= 5) {
			files.add(graph.toRelative(file));
		}
	}
	return files;
}

function scanDeadImports(graph: ProjectGraph): Set<string> {
	const files = new Set<string>();
	for (const file of graph.allFiles()) {
		const ext = extname(file);
		if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) continue;
		try {
			const content = readFileSync(file, "utf-8");
			const deadBindings = findDeadImports(content);
			if (deadBindings.length > 0) {
				files.add(graph.toRelative(file));
			}
		} catch (_) {
			/* intentional: unreadable file during scan, skip dead-imports check */
		}
	}
	return files;
}

const STRUCTURAL_CHECKS = [
	"broken-imports",
	"cycles",
	"duplicates",
	"missing-tests",
	"secrets",
	"any-types",
	"blast-radius",
	"dead-imports",
] as const;

// Every engine ToolId `--only <tool>` may name. Kept `as const` (not a widened
// `ToolId[]`) so the compile-time drift guard below can see the literal members.
const ALL_TOOL_IDS = [
	"tsc",
	"biome",
	"eslint",
	"oxlint",
	"knip",
	"semgrep",
	"gitleaks",
	"dep-audit",
	"mypy",
	"ruff",
	"ruff-format",
	"cargo-check",
	"cargo-clippy",
	"rustfmt",
	"go-build",
	"golangci-lint",
	"go-test",
	"c-compile",
	"clang-tidy",
	"shellcheck",
	"actionlint",
	"hadolint",
	"taplo",
	"swiftlint",
	"swift-build",
	"lizard",
	"docs-check",
] as const satisfies readonly ToolId[];

// Compile-time drift guard: `--only <tool>` must accept EVERY engine ToolId.
// rustfmt/lizard (and 8 others) were added to the ToolId union but not to this
// list, so `interlinked check --only rustfmt` rejected a runnable tool as
// "Unknown check" (finding 2026-06). If a ToolId is added to check-engine/types.ts
// without being listed above, `_MissingToolIds` stops being `never` and this
// assignment fails to type-check — surfacing the drift at build time.
type _MissingToolIds = Exclude<ToolId, (typeof ALL_TOOL_IDS)[number]>;
const _allToolIdsCoverEveryToolId: [_MissingToolIds] extends [never] ? true : false = true;
void _allToolIdsCoverEveryToolId;

// True for a known engine tool with NO runner (dep-audit/docs-check). runChecks
// skips a runner-less id → 0 findings, so both --only and --tools must refuse to
// report it (the summary would otherwise print a misleading clean row).
function isDiscoveryOnlyTool(id: string): boolean {
	return (ALL_TOOL_IDS as readonly ToolId[]).includes(id as ToolId) && !RUNNABLE_TOOL_IDS.has(id as ToolId);
}

// Dispatch table: structural check name -> scanner. Keyed by the names in
// STRUCTURAL_CHECKS so iteration order (and thus results order) is preserved.
const STRUCTURAL_SCANNERS: Record<
	(typeof STRUCTURAL_CHECKS)[number],
	(graph: ProjectGraph) => Set<string>
> = {
	"broken-imports": scanBrokenImports,
	cycles: scanCycles,
	duplicates: scanDuplicates,
	"missing-tests": scanMissingTests,
	secrets: scanSecrets,
	"any-types": scanAnyTypes,
	"blast-radius": scanBlastRadius,
	"dead-imports": scanDeadImports,
};

// Runs every structural check whose name passes `shouldRun`, in the canonical
// STRUCTURAL_CHECKS order, returning the accumulated results.
function runStructuralChecks(
	graph: ProjectGraph,
	shouldRun: (name: string) => boolean,
): StructuralCheckResult[] {
	const results: StructuralCheckResult[] = [];
	for (const name of STRUCTURAL_CHECKS) {
		if (!shouldRun(name)) continue;
		results.push({ name, files: STRUCTURAL_SCANNERS[name](graph) });
	}
	return results;
}

// Runs the external-tool engine when requested, returning its report (or null
// when the engine phase is skipped).
function runEngineChecks(
	cwd: string,
	runEngine: boolean,
	engineToolFilter: ToolId[] | undefined,
): CheckReport | null {
	if (!runEngine) return null;
	const engine = new CheckEngine(cwd);
	const scope = { projectRoot: cwd, mode: "project" as const };
	process.stderr.write("  running external tools...\n");
	return engine.runChecks(scope, {
		...(engineToolFilter !== undefined ? { tools: engineToolFilter } : {}),
		timeoutMs: 30_000,
	});
}

interface ResolvedCheckPlan {
	onlyCheck: string | undefined;
	isStructuralOnly: boolean;
	isEngineOnly: boolean;
	runEngine: boolean;
	runStructural: boolean;
	engineToolFilter: ToolId[] | undefined;
	unknown: boolean;
}

// Resolves the --only / --tools / --report options into a check plan. `unknown`
// is set when --only names neither a structural check nor an engine tool.
function resolveCheckPlan(opts: {
	only?: string;
	tools?: boolean | string;
	report?: boolean;
}): ResolvedCheckPlan {
	const onlyCheck = opts.only;
	const isStructuralOnly = Boolean(
		onlyCheck && (STRUCTURAL_CHECKS as readonly string[]).includes(onlyCheck),
	);
	// A known engine tool id. Some are discovery-only (dep-audit / docs-check):
	// in the ToolId union for availability reporting but with NO engine runner.
	// CheckEngine.runChecks skips a runner-less id and returns 0 findings, so
	// `--only dep-audit` would emit a false clean. Split "known" from "runnable":
	// only runnable ids are engine-only; known-but-not-runnable ids are
	// discovery-only and get rejected by the command (finding 2026-06).
	const isKnownEngineTool = Boolean(
		onlyCheck && (ALL_TOOL_IDS as readonly ToolId[]).includes(onlyCheck as ToolId),
	);
	const isEngineOnly = isKnownEngineTool && RUNNABLE_TOOL_IDS.has(onlyCheck as ToolId);
	const unknown = Boolean(onlyCheck) && !isStructuralOnly && !isKnownEngineTool;

	const runEngine = opts.tools !== undefined || Boolean(opts.report) || isEngineOnly;
	const runStructural = !isEngineOnly;

	let engineToolFilter: ToolId[] | undefined;
	if (isEngineOnly && onlyCheck) {
		engineToolFilter = [onlyCheck as ToolId];
	} else if (typeof opts.tools === "string") {
		// Drop discovery-only ids (dep-audit/docs-check): runChecks skips them and
		// the summary would print a "0 findings" row implying a clean run that never
		// happened — the same false-clean the --only path rejects. Unknown ids stay
		// (a typo just runs nothing, no row).
		engineToolFilter = (
			opts.tools.split(",").map((t) => t.trim()).filter(Boolean) as ToolId[]
		).filter((t) => !isDiscoveryOnlyTool(t));
	}

	return {
		onlyCheck,
		isStructuralOnly,
		isEngineOnly,
		runEngine,
		runStructural,
		engineToolFilter,
		unknown,
	};
}

// The stderr message to reject a `--only` target with (caller sets exit 1), or
// null when it's runnable. Unknown name → list valid checks. (A second case —
// known-but-discovery-only engine tools — is added alongside its test.)
function onlyRejectionMessage(plan: ResolvedCheckPlan): string | null {
	if (plan.unknown) {
		return `Unknown check: "${plan.onlyCheck}". Available: ${[...STRUCTURAL_CHECKS, ...ALL_TOOL_IDS].join(", ")}\n`;
	}
	// Known engine tool with no runner (dep-audit/docs-check): runChecks skips it
	// and returns 0 findings + exit 0 — a false clean. Reject; these run under
	// interlinked verify, not interlinked check.
	if (plan.onlyCheck && !plan.isStructuralOnly && !plan.isEngineOnly) {
		return `Check "${plan.onlyCheck}" is discovery-only and has no runner under interlinked check — it would report a false clean. Run interlinked verify (it performs the dependency audit and docs checks).\n`;
	}
	return null;
}

export async function checkCommand(opts: {
	only?: string;
	json?: boolean;
	cwd?: string;
	tools?: boolean | string;
	report?: boolean;
}): Promise<void> {
	const cwd = opts.cwd || process.cwd();

	// --- Resolve --only / --tools / --report against both namespaces ---
	const plan = resolveCheckPlan(opts);
	const { onlyCheck, isStructuralOnly, isEngineOnly } = plan;

	const rejection = onlyRejectionMessage(plan);
	if (rejection) {
		process.stderr.write(rejection);
		process.exitCode = 1;
		return;
	}

	// --tools: warn (don't fail) on discovery-only ids dropped from the filter so
	// the run never prints a misleading "0 findings" row for a check that did not
	// run; these run under `interlinked verify`.
	if (typeof opts.tools === "string") {
		const dropped = opts.tools.split(",").map((t) => t.trim()).filter(isDiscoveryOnlyTool);
		if (dropped.length > 0) {
			process.stderr.write(
				`Skipping discovery-only tool(s) ${dropped.join(", ")} from --tools — no interlinked check runner; run interlinked verify instead.\n`,
			);
		}
	}

	// --- Tool report ---
	if (opts.report) {
		const engine = new CheckEngine(cwd);
		process.stderr.write(`\n  ${engine.formatToolReport()}\n\n`);
		if (!opts.tools && !onlyCheck) return;
	}

	// Build the project graph (needed for structural checks)
	let graph: ProjectGraph | undefined;
	if (plan.runStructural) {
		graph = new ProjectGraph(cwd);
		graph.initialize();
	}

	const shouldRun = (name: string): boolean => !onlyCheck || onlyCheck === name;

	// --- Structural checks (instant, graph-based) ---
	const results: StructuralCheckResult[] =
		plan.runStructural && graph ? runStructuralChecks(graph, shouldRun) : [];

	// --- Engine checks (external tools, opt-in) ---
	const engineReport = runEngineChecks(cwd, plan.runEngine, plan.engineToolFilter);

	// --- Output ---
	if (opts.json) {
		emitJsonOutput(results, engineReport);
		return;
	}

	if (onlyCheck) {
		if (isStructuralOnly) {
			emitStructuralOnly(results, onlyCheck);
		} else if (isEngineOnly && engineReport) {
			emitEngineOnly(engineReport, onlyCheck);
		}
		return;
	}

	// --- Full summary ---
	emitFullSummary(results, engineReport, graph?.fileCount ?? 0);
}