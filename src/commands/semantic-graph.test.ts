import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendEdges, saveUnits } from "../harness/semantic-graph/store.js";
import { type Edge, RELATIONSHIPS_FILE, SEMANTIC_GRAPH_DIR, type Unit } from "../harness/semantic-graph/types.js";
import { semanticGraphEdgesAction, semanticGraphMetricsAction, semanticGraphStatusAction } from "./semantic-graph.js";

const dirs: string[] = [];
let logged: string[] = [];
beforeEach(() => {
	logged = [];
	vi.spyOn(console, "log").mockImplementation((line: unknown) => {
		logged.push(String(line));
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function unit(id: string, kind: Unit["kind"], file: string): Unit {
	return { id, kind, file, name: id, line: 1, endLine: 2, text: id, hash: `h-${id}` };
}

// `promises` sources are markdown sections (doc_section → function).
const DOC = unit("docs/a.md#doc_section:f@1", "doc_section", "docs/a.md");
const FN = unit("src/a.ts#function:f@2", "function", "src/a.ts");
const FAR = unit("src/b.ts#function:g@2", "function", "src/b.ts");
const DOC2 = unit("docs/b.md#doc_section:g@1", "doc_section", "docs/b.md");

function edge(source: string, target: string | null, p: number, state: Edge["state"] = "proposed", type = "promises"): Edge {
	return {
		type,
		source,
		target,
		p,
		probabilities: {},
		confidence: 0.5,
		candidates: target ? [target] : [],
		packet_hash: `ph-${source}`,
		source_hash: "sh",
		model: "m",
		judged_at: "2026-10-27T00:00:00.000Z",
		state,
	};
}

function seeded(edges: Edge[], rawLines: string[] = []): string {
	const cwd = mkdtempSync(join(tmpdir(), "semantic-graph-cmd-"));
	dirs.push(cwd);
	saveUnits(cwd, [DOC, FN, FAR, DOC2]);
	appendEdges(cwd, edges);
	if (rawLines.length > 0) {
		mkdirSync(join(cwd, SEMANTIC_GRAPH_DIR), { recursive: true });
		writeFileSync(join(cwd, SEMANTIC_GRAPH_DIR, "edges.jsonl"), `${rawLines.join("\n")}\n`, { flag: "a" });
	}
	return cwd;
}

function json(): Record<string, unknown> {
	return JSON.parse(logged.join("\n")) as Record<string, unknown>;
}

const NO_IMPORTS = () => false;

describe("semantic-graph commands — positive (must fire)", () => {
	it("P1: metrics reports the four metrics per configured type with denominators", async () => {
		const cwd = seeded([edge(DOC.id, FAR.id, 0.9), edge(DOC2.id, null, 0.6)]);
		const code = await semanticGraphMetricsAction({ cwd, json: true, hasImportEdge: NO_IMPORTS });
		expect(code).toBe(0);
		const out = json();
		expect(out.relationships).toBe("default");
		const metrics = out.metrics as Array<Record<string, unknown>>;
		expect(metrics.map((m) => m.type)).toEqual(["promises", "pins", "constrains"]);
		expect(metrics[0]).toMatchObject({ orphans: { count: 1, of: 2 }, hidden_coupling: { count: 1, of: 1 }, mismatches: { count: 0, of: 0 } });
	});

	it("P2: metrics in normal mode prints the table with count/of cells", async () => {
		const cwd = seeded([edge(DOC.id, FN.id, 0.9)]);
		await semanticGraphMetricsAction({ cwd, hasImportEdge: NO_IMPORTS });
		const text = logged.join("\n");
		expect(text).toContain("orphans");
		expect(text).toContain("1/2 (50%)");
	});

	it("P3: status counts latest edges by type and state, units, malformed rows and the relationships source", async () => {
		const cwd = seeded([edge(DOC.id, FN.id, 0.9), edge(DOC2.id, FAR.id, 0.4, "stale"), edge(FN.id, FAR.id, 0.5, "proposed", "constrains")], ["{not json"]);
		const code = await semanticGraphStatusAction({ cwd, json: true });
		expect(code).toBe(0);
		expect(json()).toMatchObject({
			units: 4,
			rows: 3,
			malformed: 1,
			relationships: "default",
			types: { promises: { proposed: 1, stale: 1 }, constrains: { proposed: 1 } },
		});
	});

	it("P4: edges lists latest edges by p descending, filtered by type and state, bounded by limit", async () => {
		const cwd = seeded([edge(DOC.id, FN.id, 0.3), edge(DOC2.id, FAR.id, 0.9), edge(FN.id, FAR.id, 0.5, "confirmed", "constrains")]);
		await semanticGraphEdgesAction({ cwd, json: true, type: "promises" });
		const rows = json().edges as Edge[];
		expect(rows.map((row) => row.p)).toEqual([0.9, 0.3]);
		logged = [];
		await semanticGraphEdgesAction({ cwd, json: true, state: "confirmed" });
		expect((json().edges as Edge[]).map((row) => row.type)).toEqual(["constrains"]);
		logged = [];
		await semanticGraphEdgesAction({ cwd, limit: "1" });
		expect(logged.join("\n").split("\n").filter((line) => line.includes("→"))).toHaveLength(1);
	});
});

describe("semantic-graph commands — negative (must not fire)", () => {
	it("N1: an empty store yields zero metrics, an empty status and no edges, all exit 0", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "semantic-graph-cmd-empty-"));
		dirs.push(cwd);
		expect(await semanticGraphMetricsAction({ cwd, json: true, hasImportEdge: NO_IMPORTS })).toBe(0);
		expect((json().metrics as unknown[]).length).toBe(3);
		logged = [];
		expect(await semanticGraphStatusAction({ cwd, json: true })).toBe(0);
		expect(json()).toMatchObject({ units: 0, rows: 0, malformed: 0, types: {} });
		logged = [];
		expect(await semanticGraphEdgesAction({ cwd, json: true })).toBe(0);
		expect(json().edges).toEqual([]);
	});

	it("N2: a malformed relationships file exits 1 and names the file", async () => {
		const cwd = seeded([]);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(join(cwd, RELATIONSHIPS_FILE), "{\"version\": 2}");
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		expect(await semanticGraphMetricsAction({ cwd, hasImportEdge: NO_IMPORTS })).toBe(1);
		expect(String(err.mock.calls[0]?.[0])).toContain("semantic-relationships.json");
	});

	it("N3: a present relationships file is reported as 'file', never as default", async () => {
		const cwd = seeded([]);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(join(cwd, RELATIONSHIPS_FILE), JSON.stringify({ version: 1, relationships: [] }));
		await semanticGraphStatusAction({ cwd, json: true });
		expect(json().relationships).toBe("file");
	});
});
