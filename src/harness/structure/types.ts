// ===========================================
// Generic Artifact Structure V1 — Type Definitions
// ===========================================

// -------------------------------------------
// Determinism and Provenance
// -------------------------------------------

import type { JsonObject } from "../../lib/json-types.js";
// Determinism is canonically defined in ../types.ts — import for local use + re-export
import type { Determinism } from "../types.js";

export type { Determinism };
export type Provenance = "declared" | "extracted" | "inferred";

// -------------------------------------------
// Artifact Kinds
// -------------------------------------------

export type ArtifactKind =
	| "module"
	| "public_symbol"
	| "package"
	| "env_key"
	| "config_key"
	| "test"
	| "doc"
	| "example"
	| "term"
	| "layer";

// -------------------------------------------
// Edge Kinds
// -------------------------------------------

export type EdgeKind =
	| "exports"
	| "imports"
	| "belongs_to_package"
	| "belongs_to_layer"
	| "documents"
	| "tests"
	| "illustrates"
	| "aliases_term"
	| "declares_env"
	| "references_env"
	| "declares_config"
	| "references_config";

// -------------------------------------------
// Artifact Graph
// -------------------------------------------

export interface ArtifactNode {
	id: string; // global ref: "<kind>:<local_id>"
	kind: ArtifactKind;
	label: string;
	file: string; // repo-relative
	provenance: Provenance;
	determinism_ceiling: Determinism;
	metadata?: JsonObject;
}

export interface ArtifactEdge {
	id: string; // "edge:<from>-><to>"
	kind: EdgeKind;
	from: string; // global ref
	to: string; // global ref
	provenance: Provenance;
	confidence: number; // 0.0–1.0
}

// -------------------------------------------
// Structure Configuration (structure.json)
// -------------------------------------------

export type StructureMode = "minimal" | "standard" | "strict";

export interface StructureVerifyConfig {
	fail_on_deterministic: boolean;
	fail_on_invalid_structure: boolean;
	fail_on_partial: boolean;
	fail_on_heuristic: boolean;
}

export interface StructurePostToolUseConfig {
	emit_deterministic: boolean;
	emit_partial: boolean;
	emit_heuristic: boolean;
	max_heuristics: number;
}

export interface StructureAdoptionConfig {
	coverage_thresholds: {
		public_api: number;
		env: number;
		config: number;
		tests: number;
		docs: number;
		examples: number;
		glossary: number;
		layers: number;
		packages: number;
	};
}

export interface StructureBuiltinsConfig {
	public_symbol_companions: boolean;
	/** Complements `public_symbol_companions`: a companion test file was
	 *  touched, but does it actually reference the symbol by name? See
	 *  `structure/rules/public-symbol-test-case.ts`. */
	public_symbol_test_case: boolean;
	env_key_companions: boolean;
	config_key_companions: boolean;
	layer_boundary_violations: boolean;
	glossary_residue: boolean;
	package_boundary_violations: boolean;
}

export type ArtifactFileKey =
	| "public_api"
	| "env"
	| "config"
	| "tests"
	| "docs"
	| "examples"
	| "glossary"
	| "layers"
	| "packages";

export interface StructureConfig {
	version: 1;
	mode: StructureMode;
	artifacts: Partial<Record<ArtifactFileKey, string>>;
	verify: StructureVerifyConfig;
	posttooluse: StructurePostToolUseConfig;
	adoption: StructureAdoptionConfig;
	builtins: StructureBuiltinsConfig;
}

// -------------------------------------------
// Artifact File Schemas
// -------------------------------------------

export type SymbolKind =
	| "function"
	| "class"
	| "type"
	| "interface"
	| "const"
	| "enum"
	| "default_export";
export type SymbolStability = "public" | "beta" | "internal";

export interface PublicSymbolEntry {
	name: string;
	kind: SymbolKind;
	stability: SymbolStability;
	docs: string[];
	tests: string[];
	examples: string[];
}

export interface PublicModuleEntry {
	id: string;
	file: string;
	symbols: PublicSymbolEntry[];
}

export interface PublicApiFile {
	version: 1;
	modules: PublicModuleEntry[];
}

export interface EnvKeyEntry {
	name: string;
	required: boolean;
	docs: string[];
	tests: string[];
	examples: string[];
	default_sources: string[];
}

export interface EnvFile {
	version: 1;
	sources: {
		declarations: string[];
		defaults: string[];
	};
	keys: EnvKeyEntry[];
}

export type TestKind = "unit" | "integration" | "contract" | "golden" | "smoke";

export interface CoversEntry {
	artifact_kind: ArtifactKind;
	artifact_id: string; // local ID
}

export type DocKind = "reference" | "guide" | "concept" | "readme" | "runbook";

export interface LayerRule {
	from: string;
	cannot_import: string[];
	reason: string;
}

// -------------------------------------------
// Cache File Schemas
// -------------------------------------------

export interface CatalogMeta {
	schema_version: 1;
	cli_version: string;
	built_at: string;
	repo_root: string;
	last_scanned_commit: string;
	manifest_hash: string;
	extractor_versions: Record<string, number>;
}

export interface CatalogItem {
	local_id: string;
	global_ref: string;
	file: string;
	provenance: Provenance;
	determinism_ceiling: Determinism;
	[key: string]: unknown;
}

export interface CategoryCatalog {
	schema_version: 1;
	items: CatalogItem[];
}

export interface AdoptionReport {
	schema_version: 1;
	categories: Record<ArtifactFileKey, number>;
}

export interface BaselineEntry {
	finding_name: string;
	artifact_ref: string;
	source_file: string;
	determinism: Determinism;
	required_companion_files: string[];
	context_hash: string;
}

export interface BaselineFile {
	schema_version: 1;
	entries: BaselineEntry[];
}

// -------------------------------------------
// Structure Findings
// -------------------------------------------

export interface RequiredUpdate {
	file: string;
	kind: string;
	reason: string;
}

export interface StructureFinding {
	name: string;
	severity: "error" | "warning" | "info";
	message: string;
	file: string;
	detail?: string;
	line?: number;
	affected_files?: string[];
	determinism: Determinism;
	provenance: Provenance;
	artifact_kind: ArtifactKind;
	artifact_id: string;
	required_updates: RequiredUpdate[];
	confidence: number;
}

// -------------------------------------------
// Structure Pending Completion
// -------------------------------------------

export interface StructurePendingCompletion {
	source_artifact_ref: string;
	source_file: string;
	finding_class: string;
	required_companion_files: string[];
	resolved_companion_files: Set<string>;
	determinism: Determinism;
	provenance: Provenance;
	first_detected_tool_call: number;
}

// -------------------------------------------
// Verify Output
// -------------------------------------------

export interface StructureVerifyOutput {
	mode: StructureMode;
	catalog_fresh: boolean;
	invalid_files: string[];
	adoption: Record<ArtifactFileKey, number>;
	findings: {
		fully_deterministic: number;
		partially_deterministic: number;
		heuristic: number;
	};
	details: Array<{
		name: string;
		determinism: Determinism;
		provenance: Provenance;
		file: string;
		artifact_id: string;
		required_updates: RequiredUpdate[];
	}>;
}

// -------------------------------------------
// Extractor Contract
// -------------------------------------------

export interface ExtractorMetadata {
	name: string;
	supported_patterns: string[];
	output_kinds: ArtifactKind[];
	provenance: Provenance;
	max_determinism: Determinism;
	version: number;
}

export interface ExtractorResult {
	nodes: ArtifactNode[];
	edges: ArtifactEdge[];
}

// -------------------------------------------
// Mode Defaults
// -------------------------------------------

export const MODE_DEFAULTS: Record<
	StructureMode,
	{ verify: StructureVerifyConfig; posttooluse: StructurePostToolUseConfig }
> = {
	minimal: {
		verify: {
			fail_on_deterministic: false,
			fail_on_invalid_structure: true,
			fail_on_partial: false,
			fail_on_heuristic: false,
		},
		posttooluse: {
			emit_deterministic: true,
			emit_partial: true,
			emit_heuristic: true,
			max_heuristics: 3,
		},
	},
	standard: {
		verify: {
			fail_on_deterministic: true,
			fail_on_invalid_structure: true,
			fail_on_partial: false,
			fail_on_heuristic: false,
		},
		posttooluse: {
			emit_deterministic: true,
			emit_partial: true,
			emit_heuristic: true,
			max_heuristics: 3,
		},
	},
	strict: {
		verify: {
			fail_on_deterministic: true,
			fail_on_invalid_structure: true,
			fail_on_partial: false,
			fail_on_heuristic: false,
		},
		posttooluse: {
			emit_deterministic: true,
			emit_partial: true,
			emit_heuristic: true,
			max_heuristics: 3,
		},
	},
};

export const DEFAULT_ADOPTION_THRESHOLDS: StructureAdoptionConfig["coverage_thresholds"] = {
	public_api: 0.6,
	env: 0.8,
	config: 0.8,
	tests: 0.5,
	docs: 0.5,
	examples: 0.3,
	glossary: 0.4,
	layers: 0.7,
	packages: 1.0,
};

export const DEFAULT_BUILTINS: StructureBuiltinsConfig = {
	public_symbol_companions: true,
	public_symbol_test_case: true,
	env_key_companions: true,
	config_key_companions: true,
	layer_boundary_violations: true,
	glossary_residue: true,
	package_boundary_violations: true,
};

// -------------------------------------------
// ID validation
// -------------------------------------------

export const LOCAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export const VALID_ARTIFACT_KINDS: ArtifactKind[] = [
	"module",
	"public_symbol",
	"package",
	"env_key",
	"config_key",
	"test",
	"doc",
	"example",
	"term",
	"layer",
];

export const VALID_SYMBOL_KINDS: SymbolKind[] = [
	"function",
	"class",
	"type",
	"interface",
	"const",
	"enum",
	"default_export",
];

export const VALID_STABILITY: SymbolStability[] = ["public", "beta", "internal"];
export const VALID_TEST_KINDS: TestKind[] = ["unit", "integration", "contract", "golden", "smoke"];
export const VALID_DOC_KINDS: DocKind[] = ["reference", "guide", "concept", "readme", "runbook"];
export const VALID_MODES: StructureMode[] = ["minimal", "standard", "strict"];
