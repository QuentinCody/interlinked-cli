import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JevClient } from "../harness/jev/client.js";
import { loadEdges } from "../harness/semantic-graph/store.js";
import { semanticGraphBuildAction, semanticGraphConfirmAction, semanticGraphRefreshAction } from "./semantic-graph-internal.js";

const dirs: string[] = [];
let out: string[] = [];
let err: string[] = [];
beforeEach(() => {
	out = [];
	err = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		out.push(String(chunk));
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		err.push(String(chunk));
		return true;
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(): string {
	const cwd = mkdtempSync(join(tmpdir(), "semantic-graph-internal-"));
	dirs.push(cwd);
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "a.ts"), "/** Returns the cap. */\nexport function lineCap(): number {\n\treturn 500;\n}\n");
	// `promises` sources are markdown sections; the heading shares the token "line" with `lineCap`.
	writeFileSync(join(cwd, "README.md"), "# Line cap\n\nReturns the cap.\n");
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
const DEPS = { coChange: new Map<string, string[]>(), graph: GRAPH };

function json(): Record<string, unknown> {
	return JSON.parse(out.join("")) as Record<string, unknown>;
}

describe("semantic-graph internal actions — positive (must fire)", () => {
	it("P1: build judges the tree with the injected client and prints a JSON report", async () => {
		const cwd = tree();
		const { client, fetchImpl } = fakeClient();
		const code = await semanticGraphBuildAction({ cwd, client, json: true, types: "promises", maxUsd: "0.05", deps: DEPS });
		expect(code).toBe(0);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const report = json();
		expect(report.model).toBe("jev-latest");
		expect((report.types as Array<Record<string, unknown>>)[0]).toMatchObject({ type: "promises", judged: 1, edges: 1 });
		expect(loadEdges(cwd)).toHaveLength(1);
	});

	it("P2: refresh reports the stale count and the build; an unchanged tree asks nothing", async () => {
		const cwd = tree();
		await semanticGraphBuildAction({ cwd, client: fakeClient().client, json: true, types: "promises", deps: DEPS });
		out = [];
		const { client, fetchImpl } = fakeClient();
		expect(await semanticGraphRefreshAction({ cwd, client, json: true, types: "promises", deps: DEPS })).toBe(0);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(json()).toMatchObject({ stale: 0, build: { types: [{ unchanged: 1 }] } });
	});

	it("P3: confirm runs the injected runner over the top slice and appends the verdict", async () => {
		const cwd = tree();
		await semanticGraphBuildAction({ cwd, client: fakeClient().client, json: true, types: "promises", deps: DEPS });
		out = [];
		const runner = vi.fn(async () => JSON.stringify({ verdict: "supported", evidence: "Returns the cap." }));
		expect(await semanticGraphConfirmAction({ cwd, runner, json: true, maxCalls: "3" })).toBe(0);
		expect(runner).toHaveBeenCalledTimes(1);
		expect(json()).toMatchObject({ selected: 1, calls: 1, confirmed: 1, appended: 1 });
		expect(loadEdges(cwd).at(-1)?.state).toBe("confirmed");
	});

	it("P4: the human summary names the spend and per-type counts", async () => {
		const cwd = tree();
		await semanticGraphBuildAction({ cwd, client: fakeClient().client, types: "promises", deps: DEPS });
		const text = out.join("");
		expect(text).toMatch(/promises: .*1 judged/);
		expect(text).toMatch(/spend \$\d+\.\d{4}/);
	});
});

describe("semantic-graph internal actions — negative (must not fire)", () => {
	it("N1: build exits 2 with the Jev explanation when no client resolves, and writes nothing", async () => {
		const cwd = tree();
		expect(await semanticGraphBuildAction({ cwd, client: null, json: true, deps: DEPS })).toBe(2);
		expect(err.join("")).toContain("TYPESAFE_API_KEY");
		expect(loadEdges(cwd)).toEqual([]);
	});

	it("N2: refresh exits 2 the same way", async () => {
		const cwd = tree();
		expect(await semanticGraphRefreshAction({ cwd, client: null, deps: DEPS })).toBe(2);
		expect(err.join("")).toContain("TYPESAFE_API_KEY");
	});

	it("N3: a non-numeric --max-usd is refused with exit 1 before any call", async () => {
		const cwd = tree();
		const { client, fetchImpl } = fakeClient();
		expect(await semanticGraphBuildAction({ cwd, client, maxUsd: "lots", deps: DEPS })).toBe(1);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(err.join("")).toContain("--max-usd");
	});

	it("N5: --max-packets 0 asks nothing and counts the packet as cap_skipped", async () => {
		const cwd = tree();
		const { client, fetchImpl } = fakeClient();
		expect(await semanticGraphBuildAction({ cwd, client, json: true, types: "promises", maxPackets: "0", deps: DEPS })).toBe(0);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect((json().types as Array<Record<string, unknown>>)[0]).toMatchObject({ packets: 1, judged: 0, cap_skipped: 1 });
	});

	it("N6: a negative --max-packets is refused with exit 1 before any call", async () => {
		const cwd = tree();
		const { client, fetchImpl } = fakeClient();
		expect(await semanticGraphBuildAction({ cwd, client, maxPackets: "-1", deps: DEPS })).toBe(1);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(err.join("")).toContain("--max-packets");
	});

	it("N4: confirm on an empty store spawns no runner and exits 0", async () => {
		const cwd = tree();
		const runner = vi.fn(async () => "");
		expect(await semanticGraphConfirmAction({ cwd, runner, json: true })).toBe(0);
		expect(runner).not.toHaveBeenCalled();
		expect(json()).toMatchObject({ selected: 0, calls: 0 });
	});
});
