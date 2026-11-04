import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	buildConfirmPrompt,
	CONFIRM_TEXT_CAP,
	confirmEdge,
	confirmMany,
	HAIKU_ARGS,
	HAIKU_MODEL,
	haikuRunnerCwd,
	type HaikuRunner,
	parseConfirmationReply,
	parseHaikuEnvelope,
	selectForConfirmation,
} from "./confirm.js";
import type { Edge, RelationshipType, Unit } from "./types.js";

const NOW = () => "2026-10-27T01:00:00Z";

function unit(id: string, text: string): Unit {
	return { id, kind: "function", file: "src/a.ts", name: id, line: 1, endLine: 3, text, hash: `h-${id}` };
}

const SOURCE = unit("src/a.ts#doc_comment:parse@1", "Returns null when the input is empty.");
const TARGET = unit("src/a.ts#function:parse@4", "function parse(s) { if (!s) return null; return JSON.parse(s); }");

const TYPE: RelationshipType = {
	name: "promises",
	description: "a doc comment promises a function's behavior",
	source_kind: "doc_comment",
	target_kind: "function",
	question: "Which function does this comment describe?",
	none_description: "no listed function",
	candidate_rules: ["same_file"],
	k: 4,
};

function edge(over: Partial<Edge> = {}): Edge {
	return {
		type: "promises",
		source: SOURCE.id,
		target: TARGET.id,
		p: 0.8,
		probabilities: { [TARGET.id]: 0.8, none: 0.2 },
		confidence: 0.6,
		candidates: [TARGET.id],
		packet_hash: "ph",
		source_hash: SOURCE.hash,
		model: "jev-live",
		judged_at: "2026-10-27T00:00:00Z",
		state: "proposed",
		...over,
	};
}

function runnerSaying(reply: string): HaikuRunner & ReturnType<typeof vi.fn> {
	return vi.fn(async () => reply);
}

describe("confirmEdge — positive (must fire)", () => {
	it("P1: a supported verdict with a verbatim quote from the target is kept", async () => {
		const runner = runnerSaying(JSON.stringify({ verdict: "supported", evidence: "if (!s) return null;" }));
		const c = await confirmEdge(runner, edge(), SOURCE, TARGET, TYPE, NOW);
		expect(c).toEqual({ model: HAIKU_MODEL, verdict: "supported", evidence: "if (!s) return null;", confirmed_at: NOW() });
	});

	it("P2: a contradicted verdict with a verbatim quote from the source is kept", async () => {
		const runner = runnerSaying(`Here is my answer:\n{"verdict":"contradicted","evidence":"Returns null when the input is empty."}`);
		const c = await confirmEdge(runner, edge(), SOURCE, TARGET, TYPE, NOW);
		expect(c.verdict).toBe("contradicted");
		expect(c.evidence).toBe("Returns null when the input is empty.");
	});

	it("P3: the prompt names the question, both texts and the JSON shape, and caps each text", async () => {
		const long = unit("x", "y".repeat(CONFIRM_TEXT_CAP + 50));
		const prompt = buildConfirmPrompt(TYPE, SOURCE, long);
		expect(prompt).toContain(TYPE.question);
		expect(prompt).toContain(SOURCE.text);
		expect(prompt).toContain('"verdict"');
		expect(prompt).toContain("supported");
		expect(prompt).not.toContain("y".repeat(CONFIRM_TEXT_CAP + 1));
		expect(prompt).toContain("y".repeat(CONFIRM_TEXT_CAP));
	});
});

describe("confirmEdge — negative (must not fire)", () => {
	it("N1: a quote that is not verbatim in either text downgrades the verdict to undecided but keeps the quote", async () => {
		const runner = runnerSaying(JSON.stringify({ verdict: "supported", evidence: "returns NULL for empty input" }));
		const c = await confirmEdge(runner, edge(), SOURCE, TARGET, TYPE, NOW);
		expect(c.verdict).toBe("undecided");
		expect(c.evidence).toBe("returns NULL for empty input");
	});

	it("N2: an empty quote is never evidence", async () => {
		const runner = runnerSaying(JSON.stringify({ verdict: "contradicted", evidence: "" }));
		const c = await confirmEdge(runner, edge(), SOURCE, TARGET, TYPE, NOW);
		expect(c.verdict).toBe("undecided");
	});

	it("N3: an unparseable or empty reply is undecided with empty evidence", async () => {
		expect((await confirmEdge(runnerSaying(""), edge(), SOURCE, TARGET, TYPE, NOW)).verdict).toBe("undecided");
		const c = await confirmEdge(runnerSaying("not json at all"), edge(), SOURCE, TARGET, TYPE, NOW);
		expect(c).toMatchObject({ verdict: "undecided", evidence: "" });
	});

	it("N4: a verdict outside the three allowed values is rejected by the parser", () => {
		expect(parseConfirmationReply(JSON.stringify({ verdict: "maybe", evidence: "x" }))).toBeNull();
		expect(parseConfirmationReply(JSON.stringify({ verdict: "supported" }))).toBeNull();
		expect(parseConfirmationReply(JSON.stringify([1]))).toBeNull();
	});

	it("N5: a runner that throws yields undecided rather than a rejection", async () => {
		const runner: HaikuRunner = async () => {
			throw new Error("spawn failed");
		};
		const c = await confirmEdge(runner, edge(), SOURCE, TARGET, TYPE, NOW);
		expect(c.verdict).toBe("undecided");
	});
});

describe("parseHaikuEnvelope — positive (must fire)", () => {
	it("P1: reads the `result` string of the `claude -p --output-format json` envelope", () => {
		expect(parseHaikuEnvelope(JSON.stringify({ type: "result", result: "{\"verdict\":\"supported\"}", cost_usd: 0.001 }))).toBe(
			'{"verdict":"supported"}',
		);
	});
});

describe("parseHaikuEnvelope — negative (must not fire)", () => {
	it("N1: a missing or non-string result, or malformed JSON, is the empty string", () => {
		expect(parseHaikuEnvelope(JSON.stringify({ type: "result" }))).toBe("");
		expect(parseHaikuEnvelope(JSON.stringify({ result: 5 }))).toBe("");
		expect(parseHaikuEnvelope("{")).toBe("");
	});
});

function edgesWithP(ps: number[], over: Partial<Edge> = {}): Edge[] {
	return ps.map((p) => edge({ p, ...over }));
}

describe("selectForConfirmation — positive (must fire)", () => {
	it("P1: returns the top slice by p, at least `min`", () => {
		const picked = selectForConfirmation(edgesWithP([0.1, 0.9, 0.5, 0.7, 0.3, 0.8, 0.2]), 0.05, 3);
		expect(picked.map((e) => e.p)).toEqual([0.9, 0.8, 0.7]);
	});

	it("P2: uses ceil(fraction * n) when that exceeds `min`", () => {
		const picked = selectForConfirmation(edgesWithP(Array.from({ length: 100 }, (_, i) => i / 100)), 0.05, 2);
		expect(picked).toHaveLength(5);
		expect(picked[0]?.p).toBe(0.99);
	});
});

describe("selectForConfirmation — negative (must not fire)", () => {
	it("N1: edges with a null target or a non-proposed state are never selected", () => {
		const edges = [
			edge({ p: 0.99, target: null }),
			edge({ p: 0.98, state: "confirmed" }),
			edge({ p: 0.97, state: "stale" }),
			edge({ p: 0.5 }),
		];
		expect(selectForConfirmation(edges).map((e) => e.p)).toEqual([0.5]);
	});

	it("N2: never returns more edges than are eligible", () => {
		expect(selectForConfirmation(edgesWithP([0.4, 0.6]), 0.05, 5)).toHaveLength(2);
		expect(selectForConfirmation([])).toEqual([]);
	});
});

describe("confirmMany — positive (must fire)", () => {
	const lookup = (id: string): Unit | undefined => (id === SOURCE.id ? SOURCE : id === TARGET.id ? TARGET : undefined);

	it("P1: attaches a confirmation and moves state to confirmed / contradicted; undecided stays proposed", async () => {
		const replies = [
			JSON.stringify({ verdict: "supported", evidence: "return null;" }),
			JSON.stringify({ verdict: "contradicted", evidence: "JSON.parse(s)" }),
			JSON.stringify({ verdict: "undecided", evidence: "" }),
		];
		let i = 0;
		const runner: HaikuRunner = async () => replies[i++] ?? "";
		const out = await confirmMany(runner, edgesWithP([0.9, 0.8, 0.7]), lookup, [TYPE], { concurrency: 1, maxCalls: 10 });
		expect(out.edges.map((e) => e.state)).toEqual(["confirmed", "contradicted", "proposed"]);
		expect(out.edges.map((e) => e.confirmation?.verdict)).toEqual(["supported", "contradicted", "undecided"]);
		expect(out.calls).toBe(3);
		expect(out.skipped).toBe(0);
	});

	it("P2: stops at maxCalls and returns the rest unchanged", async () => {
		const runner = runnerSaying(JSON.stringify({ verdict: "supported", evidence: "return null;" }));
		const out = await confirmMany(runner, edgesWithP([0.9, 0.8, 0.7, 0.6]), lookup, [TYPE], { maxCalls: 2 });
		expect(runner).toHaveBeenCalledTimes(2);
		expect(out.edges.map((e) => e.state)).toEqual(["confirmed", "confirmed", "proposed", "proposed"]);
		expect(out.edges[2]?.confirmation).toBeUndefined();
		expect(out.skipped).toBe(2);
	});
});

describe("confirmMany — negative (must not fire)", () => {
	it("N1: an edge whose source, target or type cannot be resolved is returned untouched and costs no call", async () => {
		const runner = runnerSaying(JSON.stringify({ verdict: "supported", evidence: "return null;" }));
		const edges = [edge({ target: "missing" }), edge({ type: "unknown-type" }), edge({ target: null })];
		const out = await confirmMany(runner, edges, (id) => (id === SOURCE.id ? SOURCE : undefined), [TYPE], { maxCalls: 10 });
		expect(runner).not.toHaveBeenCalled();
		expect(out.edges).toEqual(edges);
		expect(out.calls).toBe(0);
		expect(out.skipped).toBe(3);
	});

	it("N2: the input edges are not mutated", async () => {
		const runner = runnerSaying(JSON.stringify({ verdict: "supported", evidence: "return null;" }));
		const input = edgesWithP([0.9]);
		const before = structuredClone(input);
		await confirmMany(runner, input, (id) => (id === SOURCE.id ? SOURCE : TARGET), [TYPE], { maxCalls: 1 });
		expect(input).toEqual(before);
	});
});

describe("haikuRunnerCwd — positive (must fire)", () => {
	it("P1: is an existing, empty temp directory outside the process cwd, stable across calls", () => {
		const dir = haikuRunnerCwd();
		expect(existsSync(dir)).toBe(true);
		expect(readdirSync(dir)).toEqual([]);
		expect(dir.startsWith(resolve(tmpdir()))).toBe(true);
		expect(dir.startsWith(process.cwd())).toBe(false);
		expect(haikuRunnerCwd()).toBe(dir);
	});
});

describe("haikuRunnerCwd — negative (must not fire)", () => {
	it("N1: no CLAUDE.md is reachable from the runner cwd, and the spawn args carry no cwd override", () => {
		// `claude -p` loads every CLAUDE.md on the path from its cwd upward; a temp root has none.
		expect(existsSync(resolve(haikuRunnerCwd(), "CLAUDE.md"))).toBe(false);
		expect(existsSync(resolve(haikuRunnerCwd(), "..", "CLAUDE.md"))).toBe(false);
		expect(HAIKU_ARGS).toEqual(["-p", "--model", HAIKU_MODEL, "--effort", "low", "--output-format", "json"]);
	});
});
