// ===========================================
// Check Engine — Tool Catalog (single declarative table)
// ===========================================
//
// ONE row per tool. Everything the engine needs to wire a checker lives in
// that row: its config-name aliases, the file extensions it claims, its
// runner function(s) + concurrency safety, and how to detect it on PATH.
// The four structures the engine consumes — the runner registry, the
// config→id map, the extension→tools dispatch, and the discovery specs — are
// all DERIVED from this catalog (see the `build*` helpers below). Adding a
// language is now a single catalog row instead of edits to four
// hand-maintained tables that silently drifted (the seam this collapses,
// 2026-06-12). `tool-catalog.test.ts` pins every derivation.
//
// Optional fields capture the real asymmetry: project-wide tools (semgrep,
// gitleaks, eslint) and filename-dispatched tools (actionlint, hadolint)
// declare no `extensions`; discovery-only tools (dep-audit, docs-check)
// declare no `runner`. Order matters for `extensions`: per-extension tool
// lists are built in catalog order, so a tool that should appear LAST for an
// extension (lizard) is placed after the per-language compilers.

import { runActionlint, runActionlintAsync } from "./tool-runners/actionlint.js";
import { runBiome, runBiomeAsync } from "./tool-runners/biome.js";
import { runCCompile, runClangTidy } from "./tool-runners/c-cpp.js";
import {
	runEslint,
	runEslintAsync,
	runGitleaks,
	runGitleaksAsync,
	runKnip,
	runKnipAsync,
	runOxlint,
	runOxlintAsync,
	runSemgrep,
	runSemgrepAsync,
} from "./tool-runners/generic.js";
import { runGoBuild, runGoBuildAsync, runGolangciLint, runGolangciLintAsync, runGoTest, runGoTestAsync } from "./tool-runners/go.js";
import { runHadolint, runHadolintAsync } from "./tool-runners/hadolint.js";
import { runLizard, runLizardAsync } from "./tool-runners/lizard.js";
import {
	runMypy,
	runMypyAsync,
	runRuff,
	runRuffAsync,
	runRuffFormat,
	runRuffFormatAsync,
} from "./tool-runners/python.js";
import { runCargoCheck, runCargoClippy, runRustfmtCheck } from "./tool-runners/rust.js";
import { runShellcheck, runShellcheckAsync } from "./tool-runners/shellcheck.js";
import { runSwiftBuild, runSwiftLint, runSwiftLintAsync } from "./tool-runners/swift.js";
import { runTaplo, runTaploAsync } from "./tool-runners/taplo.js";
import { runTsc, runTscAsync } from "./tool-runners/tsc.js";
import type { ToolId, ToolRunner, ToolRunnerAsync, ToolRunnerMeta } from "./types.js";

/** A binary-version probe (mirrors discovery's `ToolBinarySpec`). */
export interface VersionProbe {
	versionCmd: string[];
	versionRegex: RegExp;
}

/** One row of the catalog — everything needed to wire and detect a tool. */
export interface ToolCatalogEntry extends VersionProbe {
	id: ToolId;
	/** Harness config-name aliases that select this tool. */
	configNames?: string[];
	/** File extensions whose edits trigger this tool (in dispatch order). */
	extensions?: string[];
	/** Runner — present for tools the engine invokes directly. */
	runner?: ToolRunner;
	runnerAsync?: ToolRunnerAsync;
	/** True when the tool only reads files and can run in parallel. */
	concurrencySafe?: boolean;
	/** Config files that indicate the tool is relevant to this project. */
	configFiles?: string[];
	/** When true, the tool is only offered if a config file is present. */
	requiresConfig?: boolean;
	/** Probe to try if the primary binary is missing (e.g. tsc behind tsgo). */
	fallback?: VersionProbe;
}

/** Derived discovery spec shape (structurally matches discovery's `ToolSpec`). */
export interface DerivedToolSpec extends VersionProbe {
	id: ToolId;
	configFiles?: string[];
	requiresConfig?: boolean;
	fallback?: VersionProbe;
}

const JS_TS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const C_EXTS = [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"];

export const TOOL_CATALOG: ToolCatalogEntry[] = [
	// --- TypeScript / JavaScript ---
	{
		id: "tsc",
		configNames: ["typescript"],
		extensions: [".ts", ".tsx"],
		runner: runTsc,
		runnerAsync: runTscAsync,
		concurrencySafe: true,
		versionCmd: ["npx", "tsgo", "--version"],
		versionRegex: /Version\s+(\S+)/,
		configFiles: ["tsconfig.json"],
		requiresConfig: true,
		fallback: { versionCmd: ["npx", "tsc", "--version"], versionRegex: /Version\s+(\S+)/ },
	},
	{
		id: "biome",
		configNames: ["biome_lint", "biome"],
		extensions: JS_TS_EXTS,
		runner: runBiome,
		runnerAsync: runBiomeAsync,
		concurrencySafe: true,
		versionCmd: ["npx", "biome", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: ["biome.json", "biome.jsonc"],
		requiresConfig: true,
	},
	{
		id: "oxlint",
		configNames: ["oxlint"],
		extensions: JS_TS_EXTS,
		runner: runOxlint,
		runnerAsync: runOxlintAsync,
		concurrencySafe: true,
		versionCmd: ["npx", "oxlint", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
	},
	// --- Python ---
	{
		id: "mypy",
		configNames: ["python_typecheck"],
		extensions: [".py", ".pyi"],
		runner: runMypy,
		runnerAsync: runMypyAsync,
		concurrencySafe: true,
		versionCmd: ["mypy", "--version"],
		versionRegex: /mypy\s+(\S+)/,
		configFiles: ["mypy.ini", ".mypy.ini", "pyproject.toml", "setup.cfg"],
		requiresConfig: true,
	},
	{
		id: "ruff",
		configNames: ["ruff_lint"],
		extensions: [".py", ".pyi"],
		runner: runRuff,
		runnerAsync: runRuffAsync,
		concurrencySafe: true,
		versionCmd: ["ruff", "--version"],
		versionRegex: /ruff\s+(\S+)/,
	},
	{
		id: "ruff-format",
		configNames: ["ruff_format"],
		extensions: [".py", ".pyi"],
		runner: runRuffFormat,
		runnerAsync: runRuffFormatAsync,
		concurrencySafe: true,
		versionCmd: ["ruff", "--version"],
		versionRegex: /ruff\s+(\S+)/,
	},
	// --- Rust ---
	{
		id: "cargo-check",
		configNames: ["cargo_check"],
		extensions: [".rs"],
		runner: runCargoCheck,
		concurrencySafe: false,
		versionCmd: ["cargo", "--version"],
		versionRegex: /cargo\s+(\S+)/,
		configFiles: ["Cargo.toml"],
		requiresConfig: true,
	},
	{
		id: "cargo-clippy",
		configNames: ["cargo_clippy"],
		extensions: [".rs"],
		runner: runCargoClippy,
		concurrencySafe: false,
		versionCmd: ["cargo", "clippy", "--version"],
		versionRegex: /clippy\s+(\S+)/,
		configFiles: ["Cargo.toml"],
		requiresConfig: true,
	},
	{
		id: "rustfmt",
		configNames: ["rustfmt_check"],
		extensions: [".rs"],
		runner: runRustfmtCheck,
		concurrencySafe: true,
		versionCmd: ["rustfmt", "--version"],
		versionRegex: /rustfmt\s+(\S+)/,
	},
	// --- Go ---
	{
		id: "go-build",
		configNames: ["go_build"],
		extensions: [".go"],
		runner: runGoBuild,
		runnerAsync: runGoBuildAsync,
		concurrencySafe: false,
		versionCmd: ["go", "version"],
		versionRegex: /go(\d+\.\d+\.\d+)/,
		configFiles: ["go.mod"],
		requiresConfig: true,
	},
	{
		id: "golangci-lint",
		configNames: ["golangci_lint"],
		extensions: [".go"],
		runner: runGolangciLint,
		runnerAsync: runGolangciLintAsync,
		concurrencySafe: false,
		versionCmd: ["golangci-lint", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: [".golangci.yml", ".golangci.yaml", ".golangci.json", ".golangci.toml"],
	},
	{
		// Full-suite Go test runner (project-wide, opt-in — see
		// CheckEngine.shouldRunByDefault: auto-runs only when the project
		// configures `go_test` in .interlinked/tool-commands*.json, or when
		// explicitly requested via --only go-test / --tools go-test).
		id: "go-test",
		configNames: ["go_test"],
		runner: runGoTest,
		runnerAsync: runGoTestAsync,
		concurrencySafe: false,
		versionCmd: ["go", "version"],
		versionRegex: /go(\d+\.\d+\.\d+)/,
		configFiles: ["go.mod"],
		requiresConfig: true,
	},
	// --- C/C++ ---
	{
		id: "c-compile",
		configNames: ["c_compile"],
		extensions: C_EXTS,
		runner: runCCompile,
		concurrencySafe: false,
		versionCmd: ["gcc", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: ["Makefile", "CMakeLists.txt"],
		requiresConfig: true,
	},
	{
		id: "clang-tidy",
		configNames: ["clang_tidy"],
		extensions: C_EXTS,
		runner: runClangTidy,
		concurrencySafe: false,
		versionCmd: ["clang-tidy", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: [".clang-tidy"],
		requiresConfig: true,
	},
	// --- Shell ---
	{
		id: "shellcheck",
		configNames: ["shellcheck"],
		extensions: [".sh", ".bash", ".zsh", ".ksh"],
		runner: runShellcheck,
		runnerAsync: runShellcheckAsync,
		concurrencySafe: true,
		versionCmd: ["shellcheck", "--version"],
		versionRegex: /version:\s*(\S+)/,
	},
	// --- TOML ---
	{
		id: "taplo",
		configNames: ["taplo"],
		extensions: [".toml"],
		runner: runTaplo,
		runnerAsync: runTaploAsync,
		concurrencySafe: true,
		versionCmd: ["taplo", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
	},
	// --- Swift ---
	{
		id: "swiftlint",
		configNames: ["swiftlint"],
		extensions: [".swift"],
		runner: runSwiftLint,
		runnerAsync: runSwiftLintAsync,
		concurrencySafe: true,
		versionCmd: ["swiftlint", "version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: [".swiftlint.yml", ".swiftlint.yaml"],
	},
	{
		id: "swift-build",
		configNames: ["swift_build"],
		extensions: [".swift"],
		runner: runSwiftBuild,
		concurrencySafe: false,
		versionCmd: ["swift", "--version"],
		versionRegex: /Swift version\s+(\S+)/,
		configFiles: ["Package.swift"],
		requiresConfig: true,
	},
	// --- Polyglot complexity (placed AFTER per-language tools so it appends
	//     last in every extension's tool list). ---
	{
		id: "lizard",
		configNames: ["lizard"],
		extensions: [".rs", ".go", ...C_EXTS, ".swift", ".java"],
		runner: runLizard,
		runnerAsync: runLizardAsync,
		concurrencySafe: true,
		versionCmd: ["lizard", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
	},
	// --- Project-wide / filename-dispatched / discovery-only ---
	{
		id: "eslint",
		configNames: ["eslint"],
		runner: runEslint,
		runnerAsync: runEslintAsync,
		concurrencySafe: true,
		versionCmd: ["npx", "eslint", "--version"],
		versionRegex: /v?(\d+\.\d+\.\d+)/,
		configFiles: [
			".eslintrc.json",
			".eslintrc.js",
			".eslintrc.cjs",
			".eslintrc.yml",
			"eslint.config.js",
			"eslint.config.mjs",
			"eslint.config.cjs",
			"eslint.config.ts",
		],
		requiresConfig: true,
	},
	{
		id: "semgrep",
		configNames: ["semgrep"],
		runner: runSemgrep,
		runnerAsync: runSemgrepAsync,
		concurrencySafe: true,
		versionCmd: ["semgrep", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
	},
	{
		id: "gitleaks",
		configNames: ["gitleaks"],
		runner: runGitleaks,
		runnerAsync: runGitleaksAsync,
		concurrencySafe: true,
		versionCmd: ["gitleaks", "version"],
		versionRegex: /v?(\d+\.\d+\.\d+)/,
	},
	{
		id: "knip",
		configNames: ["knip"],
		runner: runKnip,
		runnerAsync: runKnipAsync,
		concurrencySafe: true,
		versionCmd: ["npx", "knip", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: ["package.json"],
		requiresConfig: true,
	},
	{
		id: "actionlint",
		configNames: ["actionlint"],
		runner: runActionlint,
		runnerAsync: runActionlintAsync,
		concurrencySafe: true,
		versionCmd: ["actionlint", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: [".github/workflows"],
		requiresConfig: true,
	},
	{
		id: "hadolint",
		configNames: ["hadolint"],
		runner: runHadolint,
		runnerAsync: runHadolintAsync,
		concurrencySafe: true,
		versionCmd: ["hadolint", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
	},
	{
		// Discovery-only: SCA audit is invoked outside the runner registry.
		id: "dep-audit",
		configNames: ["dependency_audit"],
		versionCmd: ["npm", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: ["package.json"],
		requiresConfig: true,
	},
	{
		// Discovery-only project-local Node script (`scripts/check-docs.mjs`).
		id: "docs-check",
		versionCmd: ["node", "--version"],
		versionRegex: /v?(\d+\.\d+\.\d+)/,
		configFiles: ["scripts/check-docs.mjs"],
		requiresConfig: true,
	},
];

/** Runner registry — `{ [id]: { runner, runnerAsync?, concurrencySafe } }`
 *  for every catalog row that declares a runner. */
export function buildToolRegistry(): Record<string, ToolRunnerMeta> {
	const out: Record<string, ToolRunnerMeta> = {};
	for (const e of TOOL_CATALOG) {
		if (!e.runner) continue;
		const meta: ToolRunnerMeta = {
			runner: e.runner,
			concurrencySafe: e.concurrencySafe === true,
		};
		if (e.runnerAsync) meta.runnerAsync = e.runnerAsync;
		out[e.id] = meta;
	}
	return out;
}

/** Harness config-name → tool id (every alias flattened). */
export function buildConfigToTool(): Record<string, ToolId> {
	const out: Record<string, ToolId> = {};
	for (const e of TOOL_CATALOG) {
		for (const name of e.configNames ?? []) out[name] = e.id;
	}
	return out;
}

/** Extension → ordered tool-id list (built in catalog order). */
export function buildExtensionTools(): Record<string, ToolId[]> {
	const out: Record<string, ToolId[]> = {};
	for (const e of TOOL_CATALOG) {
		for (const ext of e.extensions ?? []) {
			(out[ext] ??= []).push(e.id);
		}
	}
	return out;
}

/** Tool ids the engine can actually EXECUTE — catalog rows that declare a
 *  `runner`. `dep-audit` / `docs-check` are discovery-only: present for
 *  availability reporting (and dispatched elsewhere, e.g. `interlinked
 *  verify`), but with no runner in the registry. `runChecks({tools:[id]})`
 *  skips a runner-less id and returns 0 findings, so a caller that maps a
 *  user-supplied check to the engine MUST reject ids absent from this set
 *  rather than dispatch them — otherwise the run reports a false clean. */
export const RUNNABLE_TOOL_IDS: ReadonlySet<ToolId> = new Set(
	TOOL_CATALOG.filter((e) => e.runner).map((e) => e.id),
);

/** Discovery specs (availability detection) for every catalog row. */
export function buildToolSpecs(): DerivedToolSpec[] {
	return TOOL_CATALOG.map((e) => {
		const spec: DerivedToolSpec = {
			id: e.id,
			versionCmd: e.versionCmd,
			versionRegex: e.versionRegex,
		};
		if (e.configFiles) spec.configFiles = e.configFiles;
		if (e.requiresConfig !== undefined) spec.requiresConfig = e.requiresConfig;
		if (e.fallback) spec.fallback = e.fallback;
		return spec;
	});
}
