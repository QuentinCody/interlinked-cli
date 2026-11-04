import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JevClient } from "../jev/client.js";
import { buildSemanticGraph, DEFAULT_CO_CHANGE_SINCE, liveHashes } from "./build.js";
import { appendEdges, loadEdges } from "./store.js";
import { type Edge, RELATIONSHIPS_FILE, SEMANTIC_GRAPH_DIR } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(): string {
	const cwd = mkdtempSync(join(tmpdir(), "semantic-graph-build-"));
	dirs.push(cwd);
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(
		join(cwd, "src", "limits.ts"),
		[
			"/** Returns the configured cap for a lane. */",
			"export function lineCap(lane: string): number {",
			"\treturn lane === 'test' ? 1000 : 500;",
			"}",
			"",
			"/** Checks whether a count sits under the cap. */",
			"export function underCap(count: number, lane: string): boolean {",
			"\treturn count <= lineCap(lane);",
			"}",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(cwd, "src", "report.ts"),
		[
			"/** Formats a count against its cap. */",
			"export function formatCap(count: number, cap: number): string {",
			"\treturn `${count}/${cap}`;",
			"}",
			"",
		].join("\n"),
	);
	// `promises` sources are markdown sections; each heading shares one token with exactly one function.
	writeFileSync(
		join(cwd, "README.md"),
		"# Line cap\n\nThe cap is one number.\n\n## Under cap\n\nTests get more.\n\n## Format cap\n\nShown as count/cap.\n",
	);
	return cwd;
}

function choiceBody(): string {
	return JSON.stringify({
		model: "jev-live",
		answers: { pick: { type: "choice", choice: "c1", probabilities: { c1: 0.8, none: 0.2 }, confidence: 0.7 } },
		usage: { input_tokens: 100, output_tokens: 0 },
	});
}

function fakeClient(maxSpendUsd = 10): { client: JevClient; fetchImpl: ReturnType<typeof vi.fn> } {
	const fetchImpl = vi.fn(async () => new Response(choiceBody(), { status: 200 }));
	return { client: new JevClient({ apiKey: "k", fetchImpl, config: { max_spend_usd: maxSpendUsd } }), fetchImpl };
}

const GRAPH = { getDependencies: () => [], getDependents: () => [] };
const NOW = () => "2026-10-27T00:00:00.000Z";

function build(cwd: string, client: JevClient, extra: Partial<Parameters<typeof buildSemanticGraph>[1]> = {}) {
	return buildSemanticGraph(cwd, {
		client,
		maxUsd: 10,
		types: ["promises"],
		now: NOW,
		deps: { coChange: new Map(), graph: GRAPH },
		...extra,
	});
}

describe("buildSemanticGraph — positive (must fire)", () => {
	it("P1: judges every doc section against its name-matched functions and appends one edge per packet", async () => {
		const cwd = tree();
		const { client, fetchImpl } = fakeClient();
		const report = await build(cwd, client);
		expect(report.relationships_written).toBe(true);
		expect(existsSync(join(cwd, RELATIONSHIPS_FILE))).toBe(true);
		expect(report.model).toBe("jev-latest");
		expect(report.types).toHaveLength(1);
		const promises = report.types[0];
		expect(promises).toMatchObject({ type: "promises", sources: 3, no_candidates: 0, packets: 3, unchanged: 0, judged: 3, failures: 0, edges: 3, none_chosen: 0 });
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(report.spend.calls).toBe(3);
		const edges = loadEdges(cwd);
		expect(edges).toHaveLength(3);
		expect(edges.every((edge) => edge.type === "promises" && edge.state === "proposed" && edge.target !== null)).toBe(true);
		expect(edges.map((edge) => edge.model)).toEqual(["jev-live", "jev-live", "jev-live"]);
		const units = JSON.parse(readFileSync(join(cwd, SEMANTIC_GRAPH_DIR, "units.json"), "utf8")) as unknown[];
		expect(units.length).toBe(report.units);
		expect(report.units).toBe(9); // 3 functions + 3 doc comments + 3 doc sections
		expect(edges.every((edge) => edge.candidates.length === 1)).toBe(true);
	});

	it("P6: maxPackets caps the asks per type after the unchanged skip and counts the rest as cap_skipped", async () => {
		const cwd = tree();
		const { client, fetchImpl } = fakeClient();
		const first = await build(cwd, client, { maxPackets: 2 });
		expect(first.types[0]).toMatchObject({ packets: 3, unchanged: 0, judged: 2, cap_skipped: 1, edges: 2, no_candidates: 0 });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const second = await build(cwd, fakeClient().client, { maxPackets: 2 });
		expect(second.types[0]).toMatchObject({ packets: 3, unchanged: 2, judged: 1, cap_skipped: 0, edges: 1 });
	});

	it("P2: a second run over an unchanged tree skips every packet and asks Jev nothing", async () => {
		const cwd = tree();
		await build(cwd, fakeClient().client);
		const { client, fetchImpl } = fakeClient();
		const report = await build(cwd, client);
		expect(report.relationships_written).toBe(false);
		expect(report.types[0]).toMatchObject({ packets: 3, unchanged: 3, judged: 3 - 3, edges: 0 });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(loadEdges(cwd)).toHaveLength(3);
	});

	it("P3: a changed candidate text produces a new packet while the others stay unchanged", async () => {
		const cwd = tree();
		await build(cwd, fakeClient().client);
		writeFileSync(join(cwd, "src", "report.ts"), "/** Formats a count against its cap. */\nexport function formatCap(count: number, cap: number): string {\n\treturn `${count} / ${cap}`;\n}\n");
		const { client, fetchImpl } = fakeClient();
		const report = await build(cwd, client);
		expect(report.types[0]).toMatchObject({ unchanged: 2, judged: 1, edges: 1 });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("P4: the budget ceiling stops asking and counts the rest as budget_skipped", async () => {
		const cwd = tree();
		const { client, fetchImpl } = fakeClient();
		const report = await build(cwd, client, { maxUsd: 0, concurrency: 1 });
		expect(report.types[0]).toMatchObject({ judged: 0, budget_skipped: 3, edges: 0 });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("P5: liveHashes keeps the newest non-stale judgment per packet and drops stale ones", () => {
		const base: Edge = {
			type: "promises",
			source: "s",
			target: "t",
			p: 0.5,
			probabilities: { t: 0.5 },
			confidence: 0.5,
			candidates: ["t"],
			packet_hash: "h1",
			source_hash: "sh",
			model: "m",
			judged_at: "2026-01-01T00:00:00Z",
			state: "proposed",
		};
		const stale: Edge = { ...base, state: "stale", judged_at: "2026-01-02T00:00:00Z" };
		const other: Edge = { ...base, source: "s2", packet_hash: "h2" };
		expect([...liveHashes([base, stale, other])]).toEqual(["promises|s2|h2"]);
	});

	it("P7: two verbatim clone sources with one packet hash each keep their own live key", () => {
		const base: Edge = {
			type: "constrains",
			source: "a.ts#function:f@1",
			target: "t",
			p: 0.9,
			probabilities: { t: 0.9 },
			confidence: 0.8,
			candidates: ["t"],
			packet_hash: "h1",
			source_hash: "x",
			model: "m",
			judged_at: "2026-01-01T00:00:00Z",
			state: "proposed",
		};
		const clone: Edge = { ...base, source: "b.ts#function:f@1" };
		expect([...liveHashes([base, clone])].sort()).toEqual([
			"constrains|a.ts#function:f@1|h1",
			"constrains|b.ts#function:f@1|h1",
		]);
	});
});

describe("buildSemanticGraph — negative (must not fire)", () => {
	it("N1: an unknown type name is reported and judges nothing", async () => {
		const cwd = tree();
		const { client, fetchImpl } = fakeClient();
		const report = await build(cwd, client, { types: ["nope"] });
		expect(report.unknown_types).toEqual(["nope"]);
		expect(report.types).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("N2: a source with zero candidates builds no packet and is counted under no_candidates", async () => {
		const cwd = tree();
		const { client, fetchImpl } = fakeClient();
		// `pins` sources are tests; the tree has none, so the sibling `constrains` type is the empty-candidate probe:
		// name_match / co_change / same_file across a one-function file yields nothing for `formatCap`.
		const report = await build(cwd, client, { types: ["constrains"] });
		const counts = report.types[0];
		expect(counts?.sources).toBe(3);
		expect(counts?.no_candidates).toBeGreaterThanOrEqual(1);
		expect(counts?.packets).toBe(counts!.sources - counts!.no_candidates);
		expect(fetchImpl).toHaveBeenCalledTimes(counts!.judged);
	});

	it("N3: a stale latest edge does not count as unchanged, so the packet is re-judged", async () => {
		const cwd = tree();
		await build(cwd, fakeClient().client);
		const stale = loadEdges(cwd).map((edge) => ({ ...edge, state: "stale" as const, judged_at: "2026-10-28T00:00:00.000Z" }));
		appendEdges(cwd, stale);
		const { client, fetchImpl } = fakeClient();
		const report = await build(cwd, client);
		expect(report.types[0]).toMatchObject({ unchanged: 0, judged: 3 });
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("N4: an existing relationships file is never overwritten", async () => {
		const cwd = tree();
		const path = join(cwd, RELATIONSHIPS_FILE);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const custom = JSON.stringify({ version: 1, relationships: [] });
		writeFileSync(path, custom);
		const report = await buildSemanticGraph(cwd, { client: fakeClient().client, maxUsd: 10, now: NOW, deps: { coChange: new Map(), graph: GRAPH } });
		expect(report.relationships_written).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(custom);
		expect(report.types).toEqual([]);
	});

	it("N5: the default co-change window is a git --since value, not a date", () => {
		expect(DEFAULT_CO_CHANGE_SINCE).toMatch(/ago$/);
	});
});
