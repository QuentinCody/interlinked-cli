import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendEdges,
	edgeKey,
	latestEdges,
	loadEdges,
	loadEdgesReport,
	loadUnits,
	markStale,
	parseEdge,
	previousJudgment,
	saveUnits,
} from "./store.js";
import { EDGES_FILE, SEMANTIC_GRAPH_DIR, UNITS_FILE, type Edge, type RelationshipType, type Unit } from "./types.js";

function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function unit(id: string, text: string, kind: Unit["kind"] = "function"): Unit {
	return { id, kind, file: id.split("#")[0] ?? "", name: id, line: 1, endLine: 2, text, hash: sha(text) };
}

function edge(overrides: Partial<Edge> & { source: string }): Edge {
	return {
		type: "pins",
		target: "t1",
		p: 0.8,
		probabilities: { c1: 0.8, none: 0.2 },
		confidence: 0.6,
		candidates: ["t1"],
		packet_hash: "h1",
		source_hash: sha("old"),
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

let cwd = "";
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "semantic-graph-store-"));
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("store — positive (must fire)", () => {
	it("P1: appendEdges creates the directory and loadEdges reads rows back in order", () => {
		appendEdges(cwd, [edge({ source: "s1" })]);
		appendEdges(cwd, [edge({ source: "s2" }), edge({ source: "s3" })]);
		const file = join(cwd, SEMANTIC_GRAPH_DIR, EDGES_FILE);
		expect(existsSync(file)).toBe(true);
		expect(loadEdges(cwd).map((e) => e.source)).toEqual(["s1", "s2", "s3"]);
	});

	it("P2: loadEdgesReport skips malformed rows and counts them", () => {
		const dir = join(cwd, SEMANTIC_GRAPH_DIR);
		mkdirSync(dir, { recursive: true });
		const rows = [
			JSON.stringify(edge({ source: "ok" })),
			"{not json",
			JSON.stringify({ ...edge({ source: "bad-state" }), state: "weird" }),
			JSON.stringify({ ...edge({ source: "bad-p" }), p: "high" }),
			JSON.stringify({ ...edge({ source: "bad-conf" }), confirmation: { verdict: "supported" } }),
			"",
			JSON.stringify(edge({ source: "ok2", target: null })),
		];
		writeFileSync(join(dir, EDGES_FILE), `${rows.join("\n")}\n`);
		const report = loadEdgesReport(cwd);
		expect(report.edges.map((e) => e.source)).toEqual(["ok", "ok2"]);
		expect(report.malformed).toBe(4);
	});

	it("P3: latestEdges keeps the newest judged_at per type|source, file order breaks ties", () => {
		const rows = [
			edge({ source: "s", judged_at: "2026-10-27T02:00:00.000Z", p: 0.1 }),
			edge({ source: "s", judged_at: "2026-10-27T01:00:00.000Z", p: 0.2 }),
			edge({ source: "s", judged_at: "2026-10-27T02:00:00.000Z", p: 0.3 }),
			edge({ source: "s", type: "promises", p: 0.4 }),
		];
		const latest = latestEdges(rows);
		expect(latest.size).toBe(2);
		expect(latest.get(edgeKey("pins", "s"))?.p).toBe(0.3);
		expect(latest.get(edgeKey("promises", "s"))?.p).toBe(0.4);
	});

	it("P4: markStale appends a stale copy for changed and vanished sources", () => {
		appendEdges(cwd, [
			edge({ source: "a.ts#test:changed@1" }),
			edge({ source: "a.ts#test:gone@5" }),
			edge({ source: "a.ts#test:same@9", source_hash: sha("same") }),
		]);
		const units = [unit("a.ts#test:changed@1", "new text", "test"), unit("a.ts#test:same@9", "same", "test")];
		const stale = markStale(cwd, units, [pins]);
		expect(stale.map((e) => e.source).sort()).toEqual(["a.ts#test:changed@1", "a.ts#test:gone@5"]);
		expect(stale.every((e) => e.state === "stale")).toBe(true);
		const latest = latestEdges(loadEdges(cwd));
		expect(latest.get(edgeKey("pins", "a.ts#test:changed@1"))?.state).toBe("stale");
		expect(latest.get(edgeKey("pins", "a.ts#test:same@9"))?.state).toBe("proposed");
		expect(loadEdges(cwd)).toHaveLength(5);
	});

	it("P5: saveUnits / loadUnits round-trip units.json", () => {
		const units = [unit("a.ts#function:f@1", "f"), unit("b.md#doc_section:Intro@1", "# Intro", "doc_section")];
		saveUnits(cwd, units);
		expect(existsSync(join(cwd, SEMANTIC_GRAPH_DIR, UNITS_FILE))).toBe(true);
		expect(loadUnits(cwd)).toEqual(units);
	});

	it("P6: previousJudgment returns the newest earlier edge with the same packet hash", () => {
		const first = edge({ source: "s", judged_at: "2026-10-27T00:00:00.000Z", p: 0.1 });
		const second = edge({ source: "s", judged_at: "2026-10-27T01:00:00.000Z", p: 0.5 });
		const current = edge({ source: "s", judged_at: "2026-10-27T02:00:00.000Z", p: 0.9 });
		expect(previousJudgment([first, second, current], "h1", current)).toBe(second);
		expect(previousJudgment([first, second, current], "h1")).toBe(current);
	});
});

describe("store — negative (must not fire)", () => {
	it("N1: loadEdges and loadUnits return empty when nothing was written", () => {
		expect(loadEdges(cwd)).toEqual([]);
		expect(loadEdgesReport(cwd)).toEqual({ edges: [], malformed: 0 });
		expect(loadUnits(cwd)).toEqual([]);
	});

	it("N2: markStale appends nothing when every source is current, already stale, or of an unlisted type", () => {
		const current = unit("a.ts#test:same@9", "same", "test");
		appendEdges(cwd, [
			edge({ source: current.id, source_hash: current.hash }),
			edge({ source: "a.ts#test:already@1", state: "stale" }),
			edge({ source: "a.ts#test:other-type@1", type: "promises" }),
		]);
		const before = readFileSync(join(cwd, SEMANTIC_GRAPH_DIR, EDGES_FILE), "utf8");
		expect(markStale(cwd, [current], [pins])).toEqual([]);
		expect(readFileSync(join(cwd, SEMANTIC_GRAPH_DIR, EDGES_FILE), "utf8")).toBe(before);
	});

	it("N3: previousJudgment ignores other hashes, stale copies, and later edges", () => {
		const current = edge({ source: "s", judged_at: "2026-10-27T01:00:00.000Z" });
		const later = edge({ source: "s", judged_at: "2026-10-27T05:00:00.000Z" });
		const staleCopy = edge({ source: "s", judged_at: "2026-10-27T00:30:00.000Z", state: "stale" });
		const other = edge({ source: "s", judged_at: "2026-10-27T00:00:00.000Z", packet_hash: "h2" });
		expect(previousJudgment([other, staleCopy, current, later], "h1", current)).toBeNull();
		expect(previousJudgment([], "h1")).toBeNull();
	});

	it("N5: previousJudgment never pairs a verbatim clone's judgment with another source", () => {
		const current = edge({ source: "a.ts#function:f@1", judged_at: "2026-10-27T01:00:00.000Z" });
		const clone = edge({ source: "b.ts#function:f@1", judged_at: "2026-10-27T00:00:00.000Z" });
		expect(previousJudgment([clone, current], "h1", current)).toBeNull();
		const own = edge({ source: "a.ts#function:f@1", judged_at: "2026-10-27T00:00:00.000Z" });
		expect(previousJudgment([clone, own, current], "h1", current)).toBe(own);
	});

	it("N4: parseEdge accepts a well-formed row with a confirmation and rejects extra-typed fields", () => {
		const confirmed = edge({
			source: "s",
			confirmation: { model: "haiku", verdict: "supported", evidence: "e", confirmed_at: "2026-10-27T00:00:00.000Z" },
		});
		expect(parseEdge(JSON.stringify(confirmed))).toEqual(confirmed);
		expect(parseEdge(JSON.stringify({ ...confirmed, candidates: "t1" }))).toBeNull();
		expect(parseEdge(JSON.stringify({ ...confirmed, probabilities: { c1: "0.8" } }))).toBeNull();
		expect(parseEdge("[]")).toBeNull();
	});

	it("N5: loadUnits treats a malformed units.json as empty", () => {
		const dir = join(cwd, SEMANTIC_GRAPH_DIR);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, UNITS_FILE), "{oops");
		expect(loadUnits(cwd)).toEqual([]);
		writeFileSync(join(dir, UNITS_FILE), JSON.stringify([{ id: "x" }, unit("a.ts#function:f@1", "f")]));
		expect(loadUnits(cwd).map((u) => u.id)).toEqual(["a.ts#function:f@1"]);
	});
});
