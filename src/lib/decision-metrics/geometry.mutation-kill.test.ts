import { expect, it } from "vitest";
import { measureGeometry } from "./geometry.js";
import type { EvidenceRecord } from "./types.js";

function rec(id: string, embedding: number[]): EvidenceRecord {
	return {
		id,
		repository: "r",
		revision: "c",
		timestamp: "2026-01-01",
		unit: "function",
		file: "a.ts",
		line: 1,
		evidence: { embedding, embeddingModelIdentity: "fixture@v1" },
		provenance: { extractor: "test", sourceHash: id, metricsVersion: "test" },
	};
}

// test-contract: boundary — each record keeps its three nearest neighbours, not fewer
it("keeps three nearest neighbours out of four peers", () => {
	const result = measureGeometry([
		rec("a", [1, 0]),
		rec("b", [1, 0.1]),
		rec("c", [1, 0.2]),
		rec("d", [1, 0.3]),
		rec("e", [1, 0.4]),
	]);
	const metrics = result.records[0]?.evidence.metrics as {
		embeddingGeometry: { nearest: { id: string }[] };
	};
	expect(metrics.embeddingGeometry.nearest.map((n) => n.id)).toEqual(["b", "c", "d"]);
});
