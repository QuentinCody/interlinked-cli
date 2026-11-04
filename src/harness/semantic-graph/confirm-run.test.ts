import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfirmation } from "./confirm-run.js";
import { appendEdges, loadEdges, saveUnits } from "./store.js";
import type { Edge, Unit } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function unit(id: string, kind: Unit["kind"], text: string): Unit {
	return { id, kind, file: "src/a.ts", name: id, line: 1, endLine: 2, text, hash: `h-${id}` };
}

const DOC = unit("src/a.ts#doc_comment:lineCap@1", "doc_comment", "/** Returns the cap. */");
const FN = unit("src/a.ts#function:lineCap@2", "function", "function lineCap() { return 500; }");
const FN2 = unit("src/a.ts#function:other@9", "function", "function other() { return 1; }");

function edge(source: string, target: string | null, p: number, state: Edge["state"] = "proposed"): Edge {
	return {
		type: "promises",
		source,
		target,
		p,
		probabilities: {},
		confidence: 0.5,
		candidates: target ? [target] : [],
		packet_hash: `ph-${source}-${target}`,
		source_hash: "sh",
		model: "m",
		judged_at: "2026-10-27T00:00:00.000Z",
		state,
	};
}

function seeded(edges: Edge[]): string {
	const cwd = mkdtempSync(join(tmpdir(), "semantic-graph-confirm-"));
	dirs.push(cwd);
	saveUnits(cwd, [DOC, FN, FN2]);
	appendEdges(cwd, edges);
	return cwd;
}

const NOW = () => "2026-10-27T01:00:00.000Z";
const supported = vi.fn(async () => JSON.stringify({ verdict: "supported", evidence: "Returns the cap." }));

describe("runConfirmation — positive (must fire)", () => {
	it("P1: confirms the top slice and appends the confirmed edge with a verdict", async () => {
		const cwd = seeded([edge(DOC.id, FN.id, 0.9)]);
		const report = await runConfirmation(cwd, { runner: supported, maxCalls: 5, now: NOW });
		expect(report).toMatchObject({ candidates: 1, selected: 1, calls: 1, confirmed: 1, contradicted: 1 - 1, undecided: 0, appended: 1 });
		const edges = loadEdges(cwd);
		expect(edges).toHaveLength(2);
		expect(edges[1]).toMatchObject({ state: "confirmed", judged_at: NOW(), confirmation: { verdict: "supported", confirmed_at: NOW() } });
	});

	it("P2: a contradicted verdict is appended as contradicted and counted", async () => {
		const cwd = seeded([edge(DOC.id, FN.id, 0.9)]);
		const runner = vi.fn(async () => JSON.stringify({ verdict: "contradicted", evidence: "return 500" }));
		const report = await runConfirmation(cwd, { runner, maxCalls: 5, now: NOW });
		expect(report).toMatchObject({ confirmed: 0, contradicted: 1, appended: 1 });
		expect(loadEdges(cwd)[1]?.state).toBe("contradicted");
	});

	it("P3: maxCalls bounds the runner and the rest of the slice is skipped", async () => {
		const cwd = seeded([edge(DOC.id, FN.id, 0.9), edge(FN2.id, FN.id, 0.8)]);
		const runner = vi.fn(async () => JSON.stringify({ verdict: "supported", evidence: "return 500" }));
		const report = await runConfirmation(cwd, { runner, maxCalls: 1, min: 2, now: NOW });
		expect(runner).toHaveBeenCalledTimes(1);
		expect(report).toMatchObject({ selected: 2, calls: 1, skipped: 1, appended: 1 });
	});
});

describe("runConfirmation — negative (must not fire)", () => {
	it("N1: an undecided verdict appends nothing (the edge stays proposed)", async () => {
		const cwd = seeded([edge(DOC.id, FN.id, 0.9)]);
		const runner = vi.fn(async () => JSON.stringify({ verdict: "supported", evidence: "a paraphrase, not a quote" }));
		const report = await runConfirmation(cwd, { runner, maxCalls: 5, now: NOW });
		expect(report).toMatchObject({ calls: 1, undecided: 1, appended: 0 });
		expect(loadEdges(cwd)).toHaveLength(1);
	});

	it("N2: none-edges, stale edges and already-confirmed edges are never selected", async () => {
		const cwd = seeded([edge(DOC.id, null, 0.9), edge(FN2.id, FN.id, 0.9, "stale"), edge(DOC.id, FN2.id, 0.9, "confirmed")]);
		const runner = vi.fn(async () => "");
		const report = await runConfirmation(cwd, { runner, maxCalls: 5, now: NOW });
		expect(runner).not.toHaveBeenCalled();
		expect(report).toMatchObject({ candidates: 0, selected: 0, calls: 0, appended: 0 });
	});

	it("N3: an empty store reports zeros and never spawns a runner", async () => {
		const cwd = seeded([]);
		const runner = vi.fn(async () => "");
		const report = await runConfirmation(cwd, { runner, maxCalls: 5, now: NOW });
		expect(runner).not.toHaveBeenCalled();
		expect(report).toMatchObject({ candidates: 0, selected: 0, calls: 0, appended: 0 });
	});
});
