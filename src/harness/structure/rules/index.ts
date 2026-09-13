// ===========================================
// Generic Artifact Structure V1 — Rule Runner
// ===========================================
// Barrel export and orchestrator for all built-in rule families.

import type { ArtifactGraph } from "../artifact-graph.js";
import { isStringArray } from "../schema-validator-helpers.js";
import type { Determinism, StructureConfig, StructureFinding } from "../types.js";
import { checkConfigKeyCompanions } from "./config-key-companions.js";
import { checkEnvKeyCompanions } from "./env-key-companions.js";
import { checkGlossaryResidue } from "./glossary-residue.js";
import { checkLayerBoundaryViolations } from "./layer-boundary.js";
import { checkPackageBoundaryViolations } from "./package-boundary.js";
import { checkPublicSymbolCompanions } from "./public-symbol-companions.js";
import { checkPublicSymbolTestCase } from "./public-symbol-test-case.js";

// -------------------------------------------
// Determinism sort order
// -------------------------------------------

const DETERMINISM_ORDER: Record<Determinism, number> = {
	fully_deterministic: 0,
	partially_deterministic: 1,
	heuristic: 2,
};

// -------------------------------------------
// Main entry point
// -------------------------------------------

export interface StructureRuleContext {
	graph: ArtifactGraph;
	config: StructureConfig;
	changedFiles: string[];
	repoRoot?: string | undefined;
}

export function evaluateStructureRules(ctx: StructureRuleContext): StructureFinding[];
export function evaluateStructureRules(
	graph: ArtifactGraph,
	config: StructureConfig,
	changedFiles: string[],
	repoRoot?: string,
): StructureFinding[];
export function evaluateStructureRules(
	...args: [ctx: StructureRuleContext] | [graph: ArtifactGraph, config: StructureConfig, changedFiles: string[], repoRoot?: string | undefined]
): StructureFinding[] {
	if (args.length !== 1) {
		return evaluateStructureRules({ graph: args[0], config: args[1], changedFiles: args[2], repoRoot: args[3] });
	}
	const { graph, config, changedFiles, repoRoot } = args[0];
	const findings: StructureFinding[] = [];
	const builtins = config.builtins;

	if (builtins.public_symbol_companions) {
		findings.push(...checkPublicSymbolCompanions(graph, changedFiles));
	}

	if (builtins.public_symbol_test_case) {
		findings.push(...checkPublicSymbolTestCase(graph, changedFiles, repoRoot));
	}

	if (builtins.env_key_companions) {
		findings.push(...checkEnvKeyCompanions(graph, changedFiles));
	}

	if (builtins.config_key_companions) {
		findings.push(...checkConfigKeyCompanions(graph, changedFiles));
	}

	if (builtins.layer_boundary_violations) {
		const layerRules =
			graph.getEdgesByKind("belongs_to_layer").length > 0 ? extractLayerRules(graph) : [];
		findings.push(...checkLayerBoundaryViolations(graph, layerRules));
	}

	if (builtins.package_boundary_violations) {
		findings.push(...checkPackageBoundaryViolations(graph));
	}

	if (builtins.glossary_residue && repoRoot) {
		findings.push(...checkGlossaryResidue(graph, changedFiles, repoRoot));
	}

	// Sort: fully_deterministic first, then partially, then heuristic
	findings.sort((a, b) => DETERMINISM_ORDER[a.determinism] - DETERMINISM_ORDER[b.determinism]);

	return findings;
}

// -------------------------------------------
// Extract layer rules from graph metadata
// -------------------------------------------

function extractLayerRules(graph: ArtifactGraph): Array<{ from: string; cannot_import: string[] }> {
	const rules: Array<{ from: string; cannot_import: string[] }> = [];
	const layerNodes = graph.getNodesByKind("layer");

	for (const layer of layerNodes) {
		const cannotImport = layer.metadata?.cannot_import;
		if (isStringArray(cannotImport) && cannotImport.length > 0) {
			rules.push({
				from: layer.id,
				cannot_import: cannotImport,
			});
		}
	}

	return rules;
}

export {
	checkConfigKeyCompanions,
	checkEnvKeyCompanions,
	checkGlossaryResidue,
	checkLayerBoundaryViolations,
	checkPackageBoundaryViolations,
	checkPublicSymbolCompanions,
	checkPublicSymbolTestCase,
};
