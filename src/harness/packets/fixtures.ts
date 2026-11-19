// interlinked-tdd: exempt
// Test fixtures for the packets modules: one valid packet file and builders.
// Data only; every test file imports from here so no test imports another test.

import { packetHash } from "./schema.js";
import type { Packet, PacketFile } from "./types.js";

export const SAMPLE_HASH_PLACEHOLDER = "0".repeat(64);

export function samplePacket(overrides: Partial<Packet> = {}): Packet {
	return hashed({
		id: "bounded-log-read",
		kind: "call",
		source: { file: "CLAUDE.md", span: [412, 418], quote: "Never full-read `collection.jsonl` …" },
		strength: "never",
		applies: {
			phase: "post",
			tools: ["Bash"],
			command_regex: "(collection|activity|timeline)\\.jsonl",
			path_regex: null,
			exclude_path_regex: null,
			new_text_regex: null,
			role: null,
		},
		settle: { compliant_regex: null, violated_regex: null },
		evidence: "command",
		questions: {
			violated: {
				type: "noul",
				instructions: "Does this command read the whole file?",
				criteria: { true: "cat or a full-file script", false: "tail/head/query" },
			},
			where: null,
		},
		cosignals: [],
		packet_hash: SAMPLE_HASH_PLACEHOLDER,
		calibration: {
			status: "shadow",
			bound_to: null,
			tau: null,
			holdout: { n: 0, pos: 0, auroc: null, precision_at_tau: null, recall_at_tau: null },
			adjudication: null,
			measured_at: null,
		},
		release: null,
		...overrides,
	});
}

/** `packet_hash` computed from content; a binding, when present, names the same hash. */
function hashed(p: Packet): Packet {
	const packet_hash = packetHash(p);
	const bound_to = p.calibration.bound_to ? { ...p.calibration.bound_to, packet_hash } : null;
	return { ...p, packet_hash, calibration: { ...p.calibration, bound_to } };
}

export function sampleFile(packets: Packet[] = [samplePacket()], overrides: Partial<PacketFile> = {}): PacketFile {
	return {
		version: 1,
		compiled_at: "2026-11-05T15:00:00.000Z",
		compiler: { model: "fixture-compiler", skill: "enforce@4" },
		sources: { "CLAUDE.md": "a".repeat(64) },
		packets,
		skipped: [{ quote: "we usually try to", reason: "hedged" }],
		...overrides,
	};
}

/** A packet at `warn` with a valid-looking binding and tau. */
export function warnPacket(overrides: Partial<Packet> = {}): Packet {
	return samplePacket({
		calibration: {
			status: "warn",
			bound_to: { packet_hash: SAMPLE_HASH_PLACEHOLDER, renderer: "evidence-v1", redaction: "e20-v3", model: "jev-1.14.0", runner: "claude-code" },
			tau: 0.7,
			holdout: { n: 60, pos: 20, auroc: 0.95, precision_at_tau: 0.9, recall_at_tau: 0.75 },
			adjudication: null,
			measured_at: "2026-11-05T16:00:00.000Z",
		},
		...overrides,
	});
}
