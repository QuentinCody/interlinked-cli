// ===========================================
// Rule: Package Boundary Violations
// ===========================================
// Check import edges that cross package boundaries
// inappropriately (imports from internal paths of another package).

import type { ArtifactGraph } from "../artifact-graph.js";
import type { Determinism, StructureFinding } from "../types.js";

/**
 * Build a package-boundary-violation finding for a single import edge, or
 * return null when the edge does not cross a package boundary improperly.
 */
function buildBoundaryViolationFinding(
	graph: ArtifactGraph,
	edge: ReturnType<ArtifactGraph["getEdgesByKind"]>[number],
	nodeToPackage: Map<string, string>,
	packageEntrypoints: Map<string, Set<string>>,
): StructureFinding | null {
	const sourcePkg = nodeToPackage.get(edge.from);
	const targetPkg = nodeToPackage.get(edge.to);

	// Same package or one side not in a package: skip
	if (!sourcePkg || !targetPkg || sourcePkg === targetPkg) {
		return null;
	}

	// Check if target is an entrypoint of its package
	const entrypoints = packageEntrypoints.get(targetPkg);
	if (entrypoints?.has(edge.to)) {
		return null;
	}

	const sourceNode = graph.getNode(edge.from);
	const targetNode = graph.getNode(edge.to);
	if (!sourceNode || !targetNode) {
		return null;
	}

	const allDeclared =
		sourceNode.provenance === "declared" && targetNode.provenance === "declared";
	const determinism: Determinism = allDeclared
		? "fully_deterministic"
		: "partially_deterministic";

	return {
		name: "package_boundary_violation",
		severity: "warning",
		message: `"${sourceNode.label}" imports internal module "${targetNode.label}" from package "${targetPkg}"`,
		file: sourceNode.file,
		affected_files: [targetNode.file],
		determinism,
		provenance: edge.provenance,
		artifact_kind: sourceNode.kind,
		artifact_id: sourceNode.id,
		required_updates: [
			{
				file: sourceNode.file,
				kind: "module",
				reason: `Use public entrypoint of "${targetPkg}" instead of internal import`,
			},
		],
		confidence: edge.confidence,
	};
}

export function checkPackageBoundaryViolations(graph: ArtifactGraph): StructureFinding[] {
	const findings: StructureFinding[] = [];
	const packages = graph.getNodesByKind("package");

	if (packages.length === 0) {
		return [];
	}

	// Build package membership: nodeRef -> packageRef
	const nodeToPackage = new Map<string, string>();
	for (const edge of graph.getEdgesByKind("belongs_to_package")) {
		nodeToPackage.set(edge.from, edge.to);
	}

	// Build entrypoint set per package from exports edges
	const packageEntrypoints = new Map<string, Set<string>>();
	for (const edge of graph.getEdgesByKind("exports")) {
		const existing = packageEntrypoints.get(edge.from) ?? new Set();
		existing.add(edge.to);
		packageEntrypoints.set(edge.from, existing);
	}

	// Check each import edge for cross-package violations
	for (const edge of graph.getEdgesByKind("imports")) {
		const finding = buildBoundaryViolationFinding(graph, edge, nodeToPackage, packageEntrypoints);
		if (finding) {
			findings.push(finding);
		}
	}

	return findings;
}
