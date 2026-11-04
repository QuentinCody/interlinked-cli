// Semantic graph — the Jev judge.
//
// One packet = one source unit against its deterministic candidate set, asked
// as a single Choice question whose options are `c1`..`ck` plus `none`. Jev
// returns the FULL distribution; the edge records it keyed by UNIT id so the
// store and metrics never see option ids. A failed ask is `null` ("not
// measured") — the model ranks and proposes, it never gates
// (research/DIGEST-semantic-graph-2026-10-25.md §4). The packet hash and the
// question wrapper are built upstream (`packet.ts`); this module only asks and
// shapes the answer.

import type { JevClient } from "../jev/client.js";
import type { JevChoiceAnswer, JevChoiceQuestion, JevEntry } from "../jev/types.js";
import type { Edge, Unit } from "./types.js";

/** The option id Jev picks when no candidate fits; always present in `question.criteria`. */
export const NONE_OPTION = "none";
/** The question id under which the Choice is sent and read back. */
export const PICK_QUESTION_ID = "pick";
export const DEFAULT_JUDGE_CONCURRENCY = 4;

export interface JudgePacket {
	state: JevEntry;
	question: JevChoiceQuestion;
	packetHash: string;
	/** option id (`c1`..`ck`) → unit id, in presentation order. */
	candidateIds: Map<string, string>;
}

export interface JudgeArgs {
	type: string;
	source: Unit;
	/** The model the packet hash was computed with; the edge records the model the RESPONSE names. */
	model: string;
	now: () => string;
}

/** A packet with its own source, for `judgeMany`. */
export interface ManyPacket extends JudgePacket {
	source: Unit;
}

export type ManyArgs = Omit<JudgeArgs, "source">;

export interface JudgeManyOptions {
	/** Stop issuing calls once `client.spend().usd` reaches this. */
	maxUsd: number;
	/** Parallel asks; default 4. */
	concurrency?: number;
	onProgress?: (done: number, total: number) => void;
}

export interface JudgeManyResult {
	/** In packet order; a failed packet leaves no entry. */
	edges: Edge[];
	/** Packets asked (edges + failures). */
	judged: number;
	/** Packets never asked because the budget was reached first. */
	skipped: number;
	/** Packets asked whose judgment was null. */
	failures: number;
}

/** Re-key an option-id distribution by unit id; unknown option ids are dropped. */
function probabilitiesByUnit(answer: JevChoiceAnswer, candidateIds: Map<string, string>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [option, p] of Object.entries(answer.probabilities)) {
		const key = option === NONE_OPTION ? NONE_OPTION : candidateIds.get(option);
		if (key !== undefined) out[key] = p;
	}
	return out;
}

function buildEdge(answer: JevChoiceAnswer, packet: JudgePacket, args: JudgeArgs, model: string): Edge | null {
	const choice = answer.choice;
	const target = choice === NONE_OPTION ? null : packet.candidateIds.get(choice);
	if (target === undefined) return null;
	const p = answer.probabilities[choice];
	if (typeof p !== "number") return null;
	return {
		type: args.type,
		source: args.source.id,
		target,
		p,
		probabilities: probabilitiesByUnit(answer, packet.candidateIds),
		confidence: answer.confidence,
		candidates: [...packet.candidateIds.values()],
		packet_hash: packet.packetHash,
		source_hash: args.source.hash,
		model,
		judged_at: args.now(),
		state: "proposed",
	};
}

/**
 * Ask Jev one packet. `null` when the ask fails, the answer is not a Choice,
 * the chosen option is not in the candidate map, or the choice carries no
 * probability — every one is "not measured", never a verdict.
 */
export async function judgePacket(client: JevClient, packet: JudgePacket, args: JudgeArgs): Promise<Edge | null> {
	const result = await client.askDetailed(packet.state, { [PICK_QUESTION_ID]: packet.question });
	if (!result.ok) return null;
	const answer = result.response.answers[PICK_QUESTION_ID];
	if (!answer || answer.type !== "choice") return null;
	return buildEdge(answer, packet, args, result.response.model);
}

/**
 * Judge packets with bounded concurrency under a spend ceiling. The ceiling is
 * read from the client's own ledger before every ask, so the overshoot is at
 * most `concurrency - 1` calls already in flight.
 */
export async function judgeMany(
	client: JevClient,
	packets: readonly ManyPacket[],
	args: ManyArgs,
	opts: JudgeManyOptions,
): Promise<JudgeManyResult> {
	const slots: Array<Edge | null> = new Array(packets.length).fill(null);
	let next = 0;
	let done = 0;
	let failures = 0;
	const worker = async (): Promise<void> => {
		while (next < packets.length && client.spend().usd < opts.maxUsd) {
			const i = next++;
			const packet = packets[i];
			if (!packet) return;
			const edge = await judgePacket(client, packet, { ...args, source: packet.source });
			if (edge) slots[i] = edge;
			else failures++;
			done++;
			opts.onProgress?.(done, packets.length);
		}
	};
	const width = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_JUDGE_CONCURRENCY, packets.length));
	await Promise.all(Array.from({ length: width }, worker));
	const edges = slots.filter((e): e is Edge => e !== null);
	return { edges, judged: done, skipped: packets.length - done, failures };
}
