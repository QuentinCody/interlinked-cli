import type { ArtifactGraph } from "../artifact-graph.js";
import type { StructureFinding } from "../types.js";

const labels = { config_key: "Config key", env_key: "Env key", public_symbol: "Public symbol" } as const;

export function checkCompanionUpdates(graph: ArtifactGraph, changedFiles: string[], kind: keyof typeof labels): StructureFinding[] {
	const findings: StructureFinding[] = [];
	const changedSet = new Set(changedFiles);
	for (const node of graph.getNodesByKind(kind)) {
		if (!changedSet.has(node.file)) {
			continue;
		}

		const companions = graph.getCompanions(node.id);
		const allCompanions = [...companions.docs, ...companions.tests, ...companions.examples];

		const untouched = allCompanions.filter((c) => !changedSet.has(c.file));
		if (untouched.length === 0) {
			continue;
		}

		const allDeclared =
			node.provenance === "declared" &&
			untouched.every((c) => c.provenance === "declared");

		findings.push({
			name: `${kind}_companion_untouched`,
			severity: "warning",
			message: `${labels[kind]} "${node.label}" was changed but ${untouched.length} companion(s) were not updated`,
			file: node.file,
			affected_files: untouched.map((c) => c.file),
			determinism: allDeclared ? "fully_deterministic" : "partially_deterministic",
			provenance: node.provenance,
			artifact_kind: kind,
			artifact_id: node.id,
			required_updates: untouched.map((c) => ({
				file: c.file,
				kind: c.kind,
				reason: `Companion ${c.kind} "${c.label}" may need updating`,
			})),
			confidence: allDeclared ? 1.0 : 0.8,
		});
	}

	return findings;
}
