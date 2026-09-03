// Pinning test for the single tool catalog. The catalog is the one
// declarative table that drives the runner registry, the config-name map, the
// extension→tool dispatch, and the discovery specs. These assertions snapshot
// the behavior that used to live in four hand-maintained structures, so the
// derivation can't silently drift from what the engine shipped before the
// catalog landed (2026-06-12).

import { describe, expect, it } from "vitest";
import {
	buildConfigToTool,
	buildExtensionTools,
	buildToolRegistry,
	buildToolSpecs,
	RUNNABLE_TOOL_IDS,
	TOOL_CATALOG,
} from "./tool-catalog.js";

describe("tool catalog — derived registry", () => {
	const registry = buildToolRegistry();

	it("registers exactly the runner-backed tools", () => {
		expect(new Set(Object.keys(registry))).toEqual(
			new Set([
				"tsc",
				"biome",
				"eslint",
				"oxlint",
				"knip",
				"semgrep",
				"gitleaks",
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
			]),
		);
	});

	it("preserves concurrency-safety flags (cargo/go/c/swift-build are unsafe)", () => {
		for (const unsafe of [
			"cargo-check",
			"cargo-clippy",
			"go-build",
			"golangci-lint",
			"go-test",
			"c-compile",
			"clang-tidy",
			"swift-build",
		]) {
			expect(registry[unsafe]?.concurrencySafe).toBe(false);
		}
		for (const safe of ["tsc", "biome", "lizard", "shellcheck", "rustfmt", "ruff-format"]) {
			expect(registry[safe]?.concurrencySafe).toBe(true);
		}
	});

	it("every registry entry has a callable runner", () => {
		for (const meta of Object.values(registry)) {
			expect(typeof meta.runner).toBe("function");
		}
	});
});

describe("tool catalog — derived config map", () => {
	const map = buildConfigToTool();

	it("maps every harness config name to its tool id", () => {
		expect(map).toMatchObject({
			typescript: "tsc",
			biome_lint: "biome",
			biome: "biome",
			eslint: "eslint",
			semgrep: "semgrep",
			gitleaks: "gitleaks",
			dependency_audit: "dep-audit",
			oxlint: "oxlint",
			knip: "knip",
			python_typecheck: "mypy",
			ruff_lint: "ruff",
			ruff_format: "ruff-format",
			cargo_check: "cargo-check",
			cargo_clippy: "cargo-clippy",
			rustfmt_check: "rustfmt",
			go_build: "go-build",
			golangci_lint: "golangci-lint",
			go_test: "go-test",
			c_compile: "c-compile",
			clang_tidy: "clang-tidy",
			shellcheck: "shellcheck",
			actionlint: "actionlint",
			hadolint: "hadolint",
			taplo: "taplo",
			swiftlint: "swiftlint",
			swift_build: "swift-build",
			lizard: "lizard",
		});
	});
});

describe("tool catalog — derived extension dispatch", () => {
	const ext = buildExtensionTools();

	it("reproduces the per-extension tool lists (order preserved)", () => {
		expect(ext[".ts"]).toEqual(["tsc", "biome", "oxlint"]);
		expect(ext[".tsx"]).toEqual(["tsc", "biome", "oxlint"]);
		expect(ext[".js"]).toEqual(["biome", "oxlint"]);
		expect(ext[".py"]).toEqual(["mypy", "ruff", "ruff-format"]);
		expect(ext[".rs"]).toEqual(["cargo-check", "cargo-clippy", "rustfmt", "lizard"]);
		expect(ext[".go"]).toEqual(["go-build", "golangci-lint", "lizard"]);
		expect(ext[".c"]).toEqual(["c-compile", "clang-tidy", "lizard"]);
		expect(ext[".swift"]).toEqual(["swiftlint", "swift-build", "lizard"]);
		expect(ext[".java"]).toEqual(["lizard"]);
		expect(ext[".sh"]).toEqual(["shellcheck"]);
		expect(ext[".toml"]).toEqual(["taplo"]);
	});

	it("has no entry for project-wide tools (semgrep/gitleaks/eslint dispatch elsewhere)", () => {
		const allTools = new Set(Object.values(ext).flat());
		expect(allTools.has("semgrep")).toBe(false);
		expect(allTools.has("gitleaks")).toBe(false);
		expect(allTools.has("eslint")).toBe(false);
	});
});

describe("tool catalog — derived discovery specs", () => {
	const specs = buildToolSpecs();
	const byId = new Map(specs.map((s) => [s.id, s]));

	it("includes discovery-only tools (dep-audit, docs-check) that have no runner", () => {
		expect(byId.has("dep-audit")).toBe(true);
		expect(byId.has("docs-check")).toBe(true);
		expect(buildToolRegistry()["dep-audit"]).toBeUndefined();
	});

	it("carries the tsgo→tsc fallback spec", () => {
		expect(byId.get("tsc")?.fallback).toBeDefined();
		expect(byId.get("tsc")?.versionCmd).toEqual(["npx", "tsgo", "--version"]);
	});

	it("preserves requiresConfig + configFiles", () => {
		expect(byId.get("cargo-check")?.requiresConfig).toBe(true);
		expect(byId.get("cargo-check")?.configFiles).toContain("Cargo.toml");
		expect(byId.get("rustfmt")?.requiresConfig).toBeUndefined();
	});

	it("spec count matches the catalog size", () => {
		expect(specs.length).toBe(TOOL_CATALOG.length);
	});
});

describe("tool catalog — runnable tool ids", () => {
	it("equals exactly the runner-backed catalog rows", () => {
		expect(RUNNABLE_TOOL_IDS).toEqual(new Set(Object.keys(buildToolRegistry())));
	});

	it("includes engine tools that have a runner", () => {
		expect(RUNNABLE_TOOL_IDS.has("tsc")).toBe(true);
		expect(RUNNABLE_TOOL_IDS.has("biome")).toBe(true);
		expect(RUNNABLE_TOOL_IDS.has("lizard")).toBe(true);
	});

	it("excludes discovery-only tools (dep-audit, docs-check) so callers reject them", () => {
		// These are in the ToolId union + discovery specs but have no engine
		// runner; dispatching `runChecks({tools:[id]})` would emit 0 findings →
		// a false clean. `interlinked check --only` must reject them instead.
		expect(RUNNABLE_TOOL_IDS.has("dep-audit")).toBe(false);
		expect(RUNNABLE_TOOL_IDS.has("docs-check")).toBe(false);
	});
});
