import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JevClient } from "../jev/client.js";
import { buildSemanticGraph } from "./build.js";
import { refreshSemanticGraph } from "./refresh.js";
import { latestEdges, loadEdges } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FILE_A = "/** Returns the cap. */\nexport function lineCap(): number {\n\treturn 500;\n}\n";
const FILE_B = "/** Formats a count. */\nexport function formatCap(count: number): string {\n\treturn `${count}`;\n}\n";
// `promises` sources are markdown sections; each heading name-matches one function.
const README = "# Line cap\n\nReturns the cap.\n\n# Format cap\n\nFormats a count.\n";

function tree(): string {
	const cwd = mkdtempSync(join(tmpdir(), "semantic-graph-refresh-"));
	dirs.push(cwd);
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "a.ts"), FILE_A);
	writeFileSync(join(cwd, "src", "b.ts"), FILE_B);
	writeFileSync(join(cwd, "README.md"), README);
	return cwd;
}

function fakeClient(): { client: JevClient; fetchImpl: ReturnType<typeof vi.fn> } {
	const body = JSON.stringify({
		model: "jev-live",
		answers: { pick: { type: "choice", choice: "c1", probabilities: { c1: 0.9, none: 0.1 }, confidence: 0.8 } },
		usage: { input_tokens: 50, output_tokens: 0 },
	});
	const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
	return { client: new JevClient({ apiKey: "k", fetchImpl, config: { max_spend_usd: 10 } }), fetchImpl };
}

const GRAPH = { getDependencies: () => [], getDependents: () => [] };
// `markStale` stamps its rows with the wall clock, and a fresh judgment must
// not sort BEFORE that stale copy in the latest-edge view; the clock is frozen
// so both carry the same stamp and file order decides (the fresh row is later).
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-27T06:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());
const NOW = () => new Date().toISOString();

function opts(client: JevClient) {
	return { client, maxUsd: 10, types: ["promises"], now: NOW, deps: { coChange: new Map<string, string[]>(), graph: GRAPH } };
}

describe("refreshSemanticGraph — positive (must fire)", () => {
	it("P1: marks the edge of a changed source stale and re-judges only that packet", async () => {
		const cwd = tree();
		await buildSemanticGraph(cwd, opts(fakeClient().client));
		expect(loadEdges(cwd)).toHaveLength(2);
		writeFileSync(join(cwd, "README.md"), README.replace("Returns the cap.", "Returns the line cap."));
		const { client, fetchImpl } = fakeClient();
		const report = await refreshSemanticGraph(cwd, opts(client));
		expect(report.stale).toBe(1);
		expect(report.build.types[0]).toMatchObject({ unchanged: 1, judged: 1, edges: 1 });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const edges = loadEdges(cwd);
		expect(edges).toHaveLength(4); // 2 original + 1 stale copy + 1 fresh judgment
		expect(edges.filter((edge) => edge.state === "stale")).toHaveLength(1);
		const live = [...latestEdges(edges).values()].filter((edge) => edge.state !== "stale");
		expect(live).toHaveLength(2);
	});

	it("P2: a vanished source is marked stale and gets no new edge", async () => {
		const cwd = tree();
		await buildSemanticGraph(cwd, opts(fakeClient().client));
		writeFileSync(join(cwd, "README.md"), "# Line cap\n\nReturns the cap.\n");
		const { client, fetchImpl } = fakeClient();
		const report = await refreshSemanticGraph(cwd, opts(client));
		expect(report.stale).toBe(1);
		expect(report.build.types[0]).toMatchObject({ sources: 1, unchanged: 1, judged: 0 });
		expect(loadEdges(cwd).filter((edge) => edge.state === "stale")[0]?.judged_at).toBe(NOW());
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("refreshSemanticGraph — negative (must not fire)", () => {
	it("N1: an unchanged tree marks nothing stale and asks nothing", async () => {
		const cwd = tree();
		await buildSemanticGraph(cwd, opts(fakeClient().client));
		const { client, fetchImpl } = fakeClient();
		const report = await refreshSemanticGraph(cwd, opts(client));
		expect(report.stale).toBe(0);
		expect(report.build.types[0]).toMatchObject({ unchanged: 2, judged: 0 });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(loadEdges(cwd)).toHaveLength(2);
	});

	it("N2: a repo with no prior edges refreshes into a plain build", async () => {
		const cwd = tree();
		const { client, fetchImpl } = fakeClient();
		const report = await refreshSemanticGraph(cwd, opts(client));
		expect(report.stale).toBe(0);
		expect(report.build.types[0]).toMatchObject({ judged: 2, edges: 2 });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
});
