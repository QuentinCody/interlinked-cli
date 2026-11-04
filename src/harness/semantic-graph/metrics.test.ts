import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeMetrics, type ImportEdgeOracle } from "./metrics.js";
import { CHURN_NOISE_FLOOR, type Edge, type RelationshipType, type Unit } from "./types.js";

function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function unit(id: string, kind: Unit["kind"], file: string): Unit {
	return { id, kind, file, name: id, line: 1, endLine: 2, text: id, hash: sha(id) };
}

function edge(overrides: Partial<Edge> & { source: string }): Edge {
	return {
		type: "pins",
		target: null,
		p: 0.8,
		probabilities: { none: 0.8 },
		confidence: 0.6,
		candidates: [],
		packet_hash: `ph:${overrides.source}`,
		source_hash: sha(overrides.source),
		model: "jev-latest",
		judged_at: "2026-10-27T00:00:00.000Z",
		state: "proposed",
		...overrides,
	};
}

const pins: RelationshipType = {
	name: "pins",
	description: "",
	source_kind: "test",
	target_kind: "function",
	question: "q",
	none_description: "n",
	candidate_rules: ["companion"],
	k: 2,
};
const promises: RelationshipType = { ...pins, name: "promises", source_kind: "doc_comment" };

const t1 = unit("a.test.ts#test:one@1", "test", "a.test.ts");
const t2 = unit("a.test.ts#test:two@9", "test", "a.test.ts");
const t3 = unit("b.test.ts#test:three@1", "test", "b.test.ts");
const f1 = unit("a.ts#function:f1@1", "function", "a.ts");
const f2 = unit("c.ts#function:f2@1", "function", "c.ts");
const d1 = unit("a.ts#doc_comment:f1@1", "doc_comment", "a.ts");
const units = [t1, t2, t3, f1, f2, d1];

const importsAll: ImportEdgeOracle = () => true;
const importsNone: ImportEdgeOracle = () => false;

function confirmed(verdict: "supported" | "contradicted" | "undecided") {
	return { model: "haiku", verdict, evidence: "e", confirmed_at: "2026-10-27T00:00:00.000Z" };
}

describe("computeMetrics — positive (must fire)", () => {
	it("P1: orphans count source-kind units with no edge, a none edge, or a stale latest edge", () => {
		const edges = [
			edge({ source: t1.id, target: f1.id }),
			edge({ source: t2.id, target: null }),
			edge({ source: t3.id, target: f1.id, judged_at: "2026-10-27T01:00:00.000Z", state: "stale" }),
			edge({ source: t3.id, target: f1.id, judged_at: "2026-10-27T00:00:00.000Z" }),
		];
		const [m] = computeMetrics({ relationships: [pins], units, edges, hasImportEdge: importsAll });
		expect(m?.type).toBe("pins");
		expect(m?.orphans).toEqual({ count: 2, of: 3 });
	});

	it("P2: mismatches count contradicted confirmations over confirmed edges", () => {
		const edges = [
			edge({ source: t1.id, target: f1.id, confirmation: confirmed("contradicted") }),
			edge({ source: t2.id, target: f1.id, confirmation: confirmed("supported") }),
			edge({ source: t3.id, target: f1.id }),
		];
		const [m] = computeMetrics({ relationships: [pins], units, edges, hasImportEdge: importsAll });
		expect(m?.mismatches).toEqual({ count: 1, of: 2 });
	});

	it("P3: hidden coupling counts targets whose files share no import edge in either direction", () => {
		const edges = [
			edge({ source: t1.id, target: f2.id }),
			edge({ source: t2.id, target: f1.id }),
			edge({ source: t3.id, target: f2.id }),
		];
		const oneWay: ImportEdgeOracle = (a, b) => a === "a.test.ts" && b === "a.ts";
		const [m] = computeMetrics({ relationships: [pins], units, edges, hasImportEdge: oneWay });
		expect(m?.hidden_coupling).toEqual({ count: 2, of: 3 });
		const reversed: ImportEdgeOracle = (a, b) => a === "a.ts" && b === "a.test.ts";
		expect(computeMetrics({ relationships: [pins], units, edges, hasImportEdge: reversed })[0]?.hidden_coupling).toEqual({
			count: 2,
			of: 3,
		});
	});

	it("P4: churn counts re-judged packets whose p moved more than the noise floor", () => {
		const edges = [
			edge({ source: t1.id, p: 0.5, judged_at: "2026-10-27T00:00:00.000Z" }),
			edge({ source: t1.id, p: 0.5 + CHURN_NOISE_FLOOR + 0.01, judged_at: "2026-10-27T01:00:00.000Z" }),
			edge({ source: t2.id, p: 0.5, judged_at: "2026-10-27T00:00:00.000Z" }),
			edge({ source: t2.id, p: 0.5 + CHURN_NOISE_FLOOR - 0.01, judged_at: "2026-10-27T01:00:00.000Z" }),
			edge({ source: t3.id, p: 0.5 }),
		];
		const [m] = computeMetrics({ relationships: [pins], units, edges, hasImportEdge: importsNone });
		expect(m?.churn).toEqual({ count: 1, of: 2 });
	});

	it("P5: one row per relationship type, each scoped to its own edges and source kind", () => {
		const edges = [edge({ source: t1.id, target: f1.id }), edge({ source: d1.id, type: "promises", target: null })];
		const rows = computeMetrics({ relationships: [pins, promises], units, edges, hasImportEdge: importsNone });
		expect(rows.map((r) => r.type)).toEqual(["pins", "promises"]);
		expect(rows[0]?.orphans).toEqual({ count: 2, of: 3 });
		expect(rows[1]?.orphans).toEqual({ count: 1, of: 1 });
		expect(rows[0]?.hidden_coupling).toEqual({ count: 1, of: 1 });
		expect(rows[1]?.hidden_coupling).toEqual({ count: 0, of: 0 });
	});
});

describe("computeMetrics — negative (must not fire)", () => {
	it("N1: no edges and no units give zero denominators", () => {
		const [m] = computeMetrics({ relationships: [pins], units: [], edges: [], hasImportEdge: importsAll });
		expect(m).toEqual({
			type: "pins",
			orphans: { count: 0, of: 0 },
			mismatches: { count: 0, of: 0 },
			hidden_coupling: { count: 0, of: 0 },
			churn: { count: 0, of: 0 },
		});
	});

	it("N2: an unknown import relation (null) or an unknown unit is excluded from the hidden-coupling denominator", () => {
		const edges = [edge({ source: t1.id, target: f1.id }), edge({ source: t2.id, target: "missing#function:x@1" })];
		const unknown: ImportEdgeOracle = () => null;
		const [m] = computeMetrics({ relationships: [pins], units, edges, hasImportEdge: unknown });
		expect(m?.hidden_coupling).toEqual({ count: 0, of: 0 });
	});

	it("N3: a p move inside the noise floor is not churn, and a moved packet hash is not a repeat", () => {
		const edges = [
			edge({ source: t1.id, p: 0.5, judged_at: "2026-10-27T00:00:00.000Z" }),
			edge({ source: t1.id, p: 0.5 + CHURN_NOISE_FLOOR, judged_at: "2026-10-27T01:00:00.000Z" }),
			edge({ source: t2.id, p: 0.1, packet_hash: "old", judged_at: "2026-10-27T00:00:00.000Z" }),
			edge({ source: t2.id, p: 0.9, packet_hash: "new", judged_at: "2026-10-27T01:00:00.000Z" }),
		];
		const [m] = computeMetrics({ relationships: [pins], units, edges, hasImportEdge: importsNone });
		expect(m?.churn).toEqual({ count: 0, of: 1 });
	});

	it("N4: a stale or none edge is not a hidden-coupling or mismatch candidate", () => {
		const edges = [
			edge({ source: t1.id, target: f1.id, state: "stale", confirmation: confirmed("contradicted") }),
			edge({ source: t2.id, target: null, confirmation: confirmed("contradicted") }),
		];
		const [m] = computeMetrics({ relationships: [pins], units, edges, hasImportEdge: importsNone });
		expect(m?.hidden_coupling).toEqual({ count: 0, of: 0 });
		expect(m?.mismatches).toEqual({ count: 1, of: 1 });
	});

	it("N5: same-file targets never count as hidden coupling", () => {
		const edges = [edge({ source: t1.id, target: t2.id })];
		const [m] = computeMetrics({ relationships: [pins], units, edges, hasImportEdge: importsNone });
		expect(m?.hidden_coupling).toEqual({ count: 0, of: 1 });
	});
});
