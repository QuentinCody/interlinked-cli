// ===========================================
// Generic Artifact Structure V1 — Adoption Coverage Calculation
// ===========================================
// Calculates adoption coverage per artifact category by comparing
// declared artifacts against extracted artifacts in the graph.

import type { ArtifactGraph } from "./artifact-graph.js";
import type { ArtifactFileKey, ArtifactKind, StructureConfig } from "./types.js";

// -------------------------------------------
// Main adoption calculation
// -------------------------------------------

export function calculateAdoption(
	graph: ArtifactGraph,
	config: StructureConfig | null,
): Record<string, number> {
	const ctx: RatioContext = { graph, config };
	return {
		public_api: categoryRatio(ctx, { kind: "public_symbol", configKey: "public_api" }),
		env: categoryRatio(ctx, { kind: "env_key", configKey: "env" }),
		config: categoryRatio(ctx, { kind: "config_key", configKey: "config" }),
		tests: categoryRatio(ctx, { kind: "test", configKey: "tests" }),
		docs: categoryRatio(ctx, { kind: "doc", configKey: "docs" }),
		examples: categoryRatio(ctx, { kind: "example", configKey: "examples" }),
		glossary: presenceRatio(ctx, { kind: "term", configKey: "glossary" }),
		layers: presenceRatio(ctx, { kind: "layer", configKey: "layers" }),
		packages: categoryRatio(ctx, { kind: "package", configKey: "packages" }),
	};
}

// -------------------------------------------
// Ratio helpers
// -------------------------------------------

interface RatioContext {
	graph: ArtifactGraph;
	config: StructureConfig | null;
}

interface CategorySpec {
	kind: ArtifactKind;
	configKey: ArtifactFileKey;
}

function categoryRatio(ctx: RatioContext, spec: CategorySpec): number {
	const { graph, config } = ctx;
	const { kind, configKey } = spec;
	const allNodes = graph.getNodesByKind(kind);
	const extractedCount = allNodes.filter((n) => n.provenance === "extracted").length;

	// If nothing was extracted, there is nothing to adopt
	if (extractedCount === 0) return 1.0;

	const declaredCount = allNodes.filter((n) => n.provenance === "declared").length;

	// Also count nodes that have a config artifact file declared
	const hasConfigFile = config?.artifacts[configKey] != null;
	if (!hasConfigFile && declaredCount === 0) return 0.0;

	return clamp(declaredCount / extractedCount);
}

/**
 * For categories where there is no extraction baseline (glossary, layers),
 * adoption is 1.0 if any declared items exist, 0.0 otherwise.
 */
function presenceRatio(ctx: RatioContext, spec: CategorySpec): number {
	const declaredCount = ctx.graph
		.getNodesByKind(spec.kind)
		.filter((n) => n.provenance === "declared").length;
	return declaredCount > 0 ? 1.0 : 0.0;
}

function clamp(value: number): number {
	return Math.min(1.0, Math.max(0.0, value));
}
