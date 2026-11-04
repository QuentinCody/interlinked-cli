import { describe, expect, it, vi } from "vitest";
import { JevClient } from "../jev/client.js";
import type { JevChoiceQuestion } from "../jev/types.js";
import { judgeMany, judgePacket, type JudgeArgs, type JudgePacket, type ManyPacket } from "./judge.js";
import type { Unit } from "./types.js";

function unit(id: string, text = "body"): Unit {
	return { id, kind: "function", file: "src/a.ts", name: id, line: 1, endLine: 2, text, hash: `h-${id}` };
}

const QUESTION: JevChoiceQuestion = {
	type: "choice",
	instructions: "Which candidate does the source promise?",
	criteria: { c1: "candidate one", c2: "candidate two", none: "no candidate" },
};

function packet(hash = "ph"): JudgePacket {
	return {
		state: { source: "s", candidates: {} },
		question: QUESTION,
		packetHash: hash,
		candidateIds: new Map([
			["c1", "src/a.ts#function:one@1"],
			["c2", "src/a.ts#function:two@9"],
		]),
	};
}

const ARGS: JudgeArgs = { type: "promises", source: unit("src/a.ts#function:src@1"), model: "jev-latest", now: () => "2026-10-27T00:00:00Z" };

interface Reply {
	choice: string;
	probabilities?: Record<string, number>;
	confidence?: number;
	inputTokens?: number;
}

function choiceBody(reply: Reply): string {
	return JSON.stringify({
		model: "jev-live",
		answers: {
			pick: {
				type: "choice",
				choice: reply.choice,
				probabilities: reply.probabilities ?? { c1: 0.7, c2: 0.2, none: 0.1 },
				confidence: reply.confidence ?? 0.66,
			},
		},
		usage: { input_tokens: reply.inputTokens ?? 100, output_tokens: 0 },
	});
}

function clientReplying(reply: Reply, maxSpendUsd = 10): { client: JevClient; fetchImpl: ReturnType<typeof vi.fn> } {
	const fetchImpl = vi.fn(async () => new Response(choiceBody(reply), { status: 200 }));
	return { client: new JevClient({ apiKey: "k", fetchImpl, config: { max_spend_usd: maxSpendUsd } }), fetchImpl };
}

describe("judgePacket — positive (must fire)", () => {
	it("P1: maps the chosen option id to the unit id and keys the distribution by unit id", async () => {
		const { client, fetchImpl } = clientReplying({ choice: "c1" });
		const edge = await judgePacket(client, packet(), ARGS);
		expect(edge).not.toBeNull();
		expect(edge).toMatchObject({
			type: "promises",
			source: "src/a.ts#function:src@1",
			target: "src/a.ts#function:one@1",
			p: 0.7,
			confidence: 0.66,
			candidates: ["src/a.ts#function:one@1", "src/a.ts#function:two@9"],
			packet_hash: "ph",
			source_hash: "h-src/a.ts#function:src@1",
			model: "jev-live",
			judged_at: "2026-10-27T00:00:00Z",
			state: "proposed",
		});
		expect(edge?.probabilities).toEqual({ "src/a.ts#function:one@1": 0.7, "src/a.ts#function:two@9": 0.2, none: 0.1 });
		const init = (fetchImpl.mock.calls[0] as [string, { body: string }])[1];
		const body = JSON.parse(init.body) as { questions: unknown; state: unknown };
		expect(body.questions).toEqual({ pick: QUESTION });
		expect(body.state).toEqual({ source: "s", candidates: {} });
	});

	it("P2: a `none` choice yields a null target with p = P(none)", async () => {
		const { client } = clientReplying({ choice: "none", probabilities: { c1: 0.2, c2: 0.3, none: 0.5 } });
		const edge = await judgePacket(client, packet(), ARGS);
		expect(edge?.target).toBeNull();
		expect(edge?.p).toBe(0.5);
		expect(edge?.probabilities.none).toBe(0.5);
	});
});

describe("judgePacket — negative (must not fire)", () => {
	it("N1: a failed ask returns null (not measured) instead of throwing", async () => {
		const client = new JevClient({ apiKey: "k", fetchImpl: async () => new Response("nope", { status: 500 }) });
		expect(await judgePacket(client, packet(), ARGS)).toBeNull();
	});

	it("N2: a choice id outside the candidate map is rejected", async () => {
		const { client } = clientReplying({ choice: "c9", probabilities: { c1: 0.1, c2: 0.1, c9: 0.8 } });
		expect(await judgePacket(client, packet(), ARGS)).toBeNull();
	});

	it("N3: a choice with no probability entry is rejected", async () => {
		const { client } = clientReplying({ choice: "c2", probabilities: { c1: 1 } });
		expect(await judgePacket(client, packet(), ARGS)).toBeNull();
	});

	it("N4: an answer of the wrong type is rejected", async () => {
		const fetchImpl = async () =>
			new Response(
				JSON.stringify({ model: "m", answers: { pick: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 0 } }),
				{ status: 200 },
			);
		const client = new JevClient({ apiKey: "k", fetchImpl });
		expect(await judgePacket(client, packet(), ARGS)).toBeNull();
	});
});

function manyPackets(n: number): ManyPacket[] {
	return Array.from({ length: n }, (_, i) => ({ ...packet(`ph${i}`), source: unit(`src/a.ts#function:s${i}@${i}`) }));
}

const MANY_ARGS = { type: "promises", model: "jev-latest", now: () => "2026-10-27T00:00:00Z" };

describe("judgeMany — positive (must fire)", () => {
	it("P1: judges every packet under budget, keeps input order, reports progress", async () => {
		const { client, fetchImpl } = clientReplying({ choice: "c1" });
		const progress: Array<[number, number]> = [];
		const out = await judgeMany(client, manyPackets(7), MANY_ARGS, { maxUsd: 1, concurrency: 3, onProgress: (d, t) => progress.push([d, t]) });
		expect(out.edges.map((e) => e.packet_hash)).toEqual(["ph0", "ph1", "ph2", "ph3", "ph4", "ph5", "ph6"]);
		expect(out.edges.map((e) => e.source)).toEqual(manyPackets(7).map((p) => p.source.id));
		expect({ judged: out.judged, skipped: out.skipped, failures: out.failures }).toEqual({ judged: 7, skipped: 0, failures: 0 });
		expect(fetchImpl).toHaveBeenCalledTimes(7);
		expect(progress.at(-1)).toEqual([7, 7]);
	});

	it("P2: stops when the client's spend reaches maxUsd and counts the rest as skipped", async () => {
		// 1,000,000 input tokens per call = $0.042 per call at list price; maxUsd 0.1 admits three calls.
		const { client, fetchImpl } = clientReplying({ choice: "c1", inputTokens: 1_000_000 });
		const out = await judgeMany(client, manyPackets(10), MANY_ARGS, { maxUsd: 0.1, concurrency: 1 });
		expect(out.edges).toHaveLength(3);
		expect(out.skipped).toBe(7);
		expect(out.failures).toBe(0);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("P3: a null judgment is a failure, not an edge, and the rest still run", async () => {
		let n = 0;
		const fetchImpl = vi.fn(async () => {
			n++;
			return n === 2 ? new Response("boom", { status: 503 }) : new Response(choiceBody({ choice: "c2" }), { status: 200 });
		});
		const client = new JevClient({ apiKey: "k", fetchImpl });
		const out = await judgeMany(client, manyPackets(4), MANY_ARGS, { maxUsd: 1, concurrency: 1 });
		expect(out.edges).toHaveLength(3);
		expect(out.failures).toBe(1);
		expect(out.skipped).toBe(0);
	});
});

describe("judgeMany — negative (must not fire)", () => {
	it("N1: an empty packet list makes no call", async () => {
		const { client, fetchImpl } = clientReplying({ choice: "c1" });
		const out = await judgeMany(client, [], MANY_ARGS, { maxUsd: 1 });
		expect(out).toEqual({ edges: [], judged: 0, skipped: 0, failures: 0 });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("N2: a budget already spent makes no call and skips everything", async () => {
		const { client, fetchImpl } = clientReplying({ choice: "c1" });
		const out = await judgeMany(client, manyPackets(3), MANY_ARGS, { maxUsd: 0 });
		expect(out.skipped).toBe(3);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("N3: concurrency never exceeds the configured bound", async () => {
		let inFlight = 0;
		let peak = 0;
		const fetchImpl = vi.fn(async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 2));
			inFlight--;
			return new Response(choiceBody({ choice: "c1" }), { status: 200 });
		});
		const client = new JevClient({ apiKey: "k", fetchImpl });
		await judgeMany(client, manyPackets(9), MANY_ARGS, { maxUsd: 1, concurrency: 2 });
		expect(peak).toBe(2);
	});
});
