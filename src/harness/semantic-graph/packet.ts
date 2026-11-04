// Semantic graph — packet construction. Pure functions, no I/O.
//
// A packet is one source unit judged against its deterministic candidates as
// a Jev Choice among `c1..ck` plus `none`. `packetHash` identifies the exact
// question asked (layout version, model, type, question, source hash,
// candidate hashes in order), so a later judgment of the same hash is a
// repeat (churn) rather than a new edge.

import { createHash } from "node:crypto";
import type { JevChoiceQuestion, JevEntry } from "../jev/types.js";
import { PACKET_VERSION, type RelationshipType, type Unit } from "./types.js";

/** Source text cap in characters; longer units are truncated with a marker. */
export const SOURCE_TEXT_CAP = 3000;
/** Candidate text cap in characters; each candidate is truncated independently. */
export const CANDIDATE_TEXT_CAP = 1500;
const TRUNCATION_MARKER = "\n…[truncated]";
/** The option id Jev picks when no candidate fits. */
export const NONE_ID = "none";

// Type aliases, not interfaces: an alias gets an implicit index signature, so
// `PacketState` is assignable to `JevEntry` and can be sent as the Jev state.
export type PacketUnit = {
	kind: string;
	name: string;
	file: string;
	text: string;
};

export type PacketCandidate = PacketUnit & {
	/** `c1`..`ck`, the option id the Choice answers with. */
	id: string;
};

/** The Jev `state` object, serializable as a JevEntry. */
export type PacketState = {
	relationship: string;
	source: PacketUnit;
	candidates: PacketCandidate[];
};

/** Compile-time proof that a packet state is a valid Jev state. */
export function asJevState(state: PacketState): JevEntry {
	return state;
}

export interface Packet {
	state: PacketState;
	question: JevChoiceQuestion;
	packetHash: string;
	/** Candidate unit ids in presentation order (`c1` ↔ index 0). */
	candidateIds: string[];
}

/** Truncate `text` to `cap` characters; marks the cut so the model sees it. */
export function capText(text: string, cap: number): string {
	if (text.length <= cap) return text;
	return text.slice(0, cap) + TRUNCATION_MARKER;
}

/** `c1` for index 0, `c2` for index 1, … */
export function candidateKey(index: number): string {
	return `c${index + 1}`;
}

/** `Map<"c1", unitId>` in presentation order. */
export function candidateIdMap(candidates: Unit[]): Map<string, string> {
	const map = new Map<string, string>();
	candidates.forEach((unit, index) => map.set(candidateKey(index), unit.id));
	return map;
}

function describeUnit(unit: Unit): string {
	return `${unit.kind} ${unit.name} in ${unit.file}`;
}

/** sha256 over PACKET_VERSION, model, type name, question, source hash, candidate hashes in order. */
export function packetHash(source: Unit, candidates: Unit[], type: RelationshipType, model: string): string {
	const hash = createHash("sha256");
	for (const part of [PACKET_VERSION, model, type.name, type.question, source.hash]) {
		hash.update(part).update("\0");
	}
	for (const candidate of candidates) hash.update(candidate.hash).update("\0");
	return hash.digest("hex");
}

export function buildPacket(source: Unit, candidates: Unit[], type: RelationshipType, model: string): Packet {
	const packetCandidates: PacketCandidate[] = candidates.map((unit, index) => ({
		id: candidateKey(index),
		kind: unit.kind,
		name: unit.name,
		file: unit.file,
		text: capText(unit.text, CANDIDATE_TEXT_CAP),
	}));
	const state: PacketState = {
		relationship: type.name,
		source: {
			kind: source.kind,
			name: source.name,
			file: source.file,
			text: capText(source.text, SOURCE_TEXT_CAP),
		},
		candidates: packetCandidates,
	};
	const criteria: Record<string, JevEntry> = {};
	candidates.forEach((unit, index) => {
		criteria[candidateKey(index)] = describeUnit(unit);
	});
	criteria[NONE_ID] = type.none_description;
	const question: JevChoiceQuestion = { type: "choice", instructions: type.question, criteria };
	return {
		state,
		question,
		packetHash: packetHash(source, candidates, type, model),
		candidateIds: candidates.map((unit) => unit.id),
	};
}
