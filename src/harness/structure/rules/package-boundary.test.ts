import { describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactEdge, ArtifactNode } from "../types.js";
import { checkPackageBoundaryViolations } from "./package-boundary.js";

function mod(
	id: string,
	file: string,
	provenance: "declared" | "extracted" = "extracted",
): ArtifactNode {
	return {
		id: makeGlobalRef("module", id),
		kind: "module",
		label: id,
		file,
		provenance,
		determinism_ceiling: "partially_deterministic",
	};
}

function pkg(id: string, file: string): ArtifactNode {
	return {
		id: makeGlobalRef("package", id),
		kind: "package",
		label: id,
		file,
		provenance: "extracted",
		determinism_ceiling: "partially_deterministic",
	};
}

function edge(from: string, to: string, kind: ArtifactEdge["kind"]): ArtifactEdge {
	return {
		id: makeEdgeId(from, to),
		kind,
		from,
		to,
		provenance: "extracted",
		confidence: 0.9,
	};
}

describe("checkPackageBoundaryViolations", () => {
	it("returns empty when the graph has no packages", () => {
		const g = new ArtifactGraph();
		expect(checkPackageBoundaryViolations(g)).toEqual([]);
	});

	it("does not flag same-package imports", () => {
		const g = new ArtifactGraph();
		const p = pkg("app", "package.json");
		const a = mod("a", "src/a.ts");
		const b = mod("b", "src/b.ts");
		for (const n of [p, a, b]) g.addNode(n);
		g.addEdge(edge(a.id, p.id, "belongs_to_package"));
		g.addEdge(edge(b.id, p.id, "belongs_to_package"));
		g.addEdge(edge(a.id, b.id, "imports"));

		expect(checkPackageBoundaryViolations(g)).toEqual([]);
	});

	it("flags cross-package import of an internal (non-entrypoint) module", () => {
		const g = new ArtifactGraph();
		const p1 = pkg("app", "app/package.json");
		const p2 = pkg("lib", "lib/package.json");
		const appMod = mod("app-mod", "app/src/x.ts");
		const libInternal = mod("lib-internal", "lib/src/internals.ts");
		for (const n of [p1, p2, appMod, libInternal]) g.addNode(n);
		g.addEdge(edge(appMod.id, p1.id, "belongs_to_package"));
		g.addEdge(edge(libInternal.id, p2.id, "belongs_to_package"));
		g.addEdge(edge(appMod.id, libInternal.id, "imports"));

		const findings = checkPackageBoundaryViolations(g);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).name).toBe("package_boundary_violation");
	});

	it("skips an import edge whose endpoint node was never added to the graph", () => {
		const g = new ArtifactGraph();
		const p1 = pkg("app", "app/package.json");
		const p2 = pkg("lib", "lib/package.json");
		// Note: only the packages are added as nodes — the module refs below
		// appear in edges (so nodeToPackage still maps them) but graph.getNode()
		// returns undefined for both, exercising the dangling-node guard.
		const appModRef = makeGlobalRef("module", "app-mod-missing");
		const libModRef = makeGlobalRef("module", "lib-mod-missing");
		g.addNode(p1);
		g.addNode(p2);
		g.addEdge(edge(appModRef, p1.id, "belongs_to_package"));
		g.addEdge(edge(libModRef, p2.id, "belongs_to_package"));
		g.addEdge(edge(appModRef, libModRef, "imports"));

		expect(checkPackageBoundaryViolations(g)).toEqual([]);
	});

	it("allows cross-package import when the target IS a declared entrypoint", () => {
		const g = new ArtifactGraph();
		const p1 = pkg("app", "app/package.json");
		const p2 = pkg("lib", "lib/package.json");
		const appMod = mod("app-mod", "app/src/x.ts");
		const libEntry = mod("lib-entry", "lib/src/index.ts");
		for (const n of [p1, p2, appMod, libEntry]) g.addNode(n);
		g.addEdge(edge(appMod.id, p1.id, "belongs_to_package"));
		g.addEdge(edge(libEntry.id, p2.id, "belongs_to_package"));
		g.addEdge(edge(p2.id, libEntry.id, "exports"));
		g.addEdge(edge(appMod.id, libEntry.id, "imports"));

		expect(checkPackageBoundaryViolations(g)).toEqual([]);
	});
});
