import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	CANDIDATE_TEXT_CAP,
	NONE_ID,
	SOURCE_TEXT_CAP,
	buildPacket,
	candidateIdMap,
	candidateKey,
	capText,
	packetHash,
} from "./packet.js";
import { PACKET_VERSION, type RelationshipType, type Unit } from "./types.js";

function unit(overrides: Partial<Unit> & { id: string }): Unit {
	const text = overrides.text ?? `text of ${overrides.id}`;
	return {
		kind: "function",
		file: "src/a.ts",
		name: overrides.id,
		line: 1,
		endLine: 2,
		text,
		hash: createHash("sha256").update(text).digest("hex"),
		...overrides,
	};
}

const type: RelationshipType = {
	name: "pins",
	description: "a test pins a function",
	source_kind: "test",
	target_kind: "function",
	question: "Which function does this test pin?",
	none_description: "No candidate is pinned by this test.",
	candidate_rules: ["companion"],
	k: 3,
};

const source = unit({ id: "src/a.test.ts#test:adds@3", kind: "test", file: "src/a.test.ts", name: "adds" });
const c1 = unit({ id: "src/a.ts#function:add@1", name: "add" });
const c2 = unit({ id: "src/a.ts#function:sub@9", name: "sub", line: 9 });

describe("buildPacket — positive (must fire)", () => {
	it("P1: numbers candidates c1..ck and adds none to the criteria", () => {
		const packet = buildPacket(source, [c1, c2], type, "jev-latest");
		expect(packet.state.candidates.map((c) => c.id)).toEqual(["c1", "c2"]);
		expect(Object.keys(packet.question.criteria)).toEqual(["c1", "c2", NONE_ID]);
		expect(packet.question.criteria.c1).toBe("function add in src/a.ts");
		expect(packet.question.criteria[NONE_ID]).toBe(type.none_description);
		expect(packet.question.instructions).toBe(type.question);
		expect(packet.question.type).toBe("choice");
		expect(packet.candidateIds).toEqual([c1.id, c2.id]);
		expect(packet.state.relationship).toBe("pins");
		expect(packet.state.source).toEqual({ kind: "test", name: "adds", file: "src/a.test.ts", text: source.text });
	});

	it("P2: caps the source at SOURCE_TEXT_CAP and each candidate at CANDIDATE_TEXT_CAP", () => {
		const longSource = unit({ id: "s", kind: "test", text: "x".repeat(SOURCE_TEXT_CAP + 50) });
		const longCandidate = unit({ id: "c", text: "y".repeat(CANDIDATE_TEXT_CAP + 50) });
		const packet = buildPacket(longSource, [longCandidate], type, "m");
		expect(packet.state.source.text.startsWith("x".repeat(SOURCE_TEXT_CAP))).toBe(true);
		expect(packet.state.source.text).toContain("[truncated]");
		expect(packet.state.candidates[0]?.text.startsWith("y".repeat(CANDIDATE_TEXT_CAP))).toBe(true);
		expect(packet.state.candidates[0]?.text).not.toContain("y".repeat(CANDIDATE_TEXT_CAP + 1));
	});

	it("P3: packetHash changes with model, type, question, source hash and candidate order", () => {
		const base = packetHash(source, [c1, c2], type, "m");
		expect(base).toMatch(/^[0-9a-f]{64}$/);
		expect(packetHash(source, [c1, c2], type, "other")).not.toBe(base);
		expect(packetHash(source, [c1, c2], { ...type, name: "promises" }, "m")).not.toBe(base);
		expect(packetHash(source, [c1, c2], { ...type, question: "?" }, "m")).not.toBe(base);
		expect(packetHash({ ...source, hash: "0".repeat(64) }, [c1, c2], type, "m")).not.toBe(base);
		expect(packetHash(source, [c2, c1], type, "m")).not.toBe(base);
	});

	it("P4: candidateIdMap maps c1.. to unit ids in order", () => {
		expect([...candidateIdMap([c1, c2])]).toEqual([
			["c1", c1.id],
			["c2", c2.id],
		]);
		expect(candidateKey(0)).toBe("c1");
	});
});

describe("buildPacket — negative (must not fire)", () => {
	it("N1: packetHash is stable across calls and ignores unit fields outside the hash inputs", () => {
		const base = packetHash(source, [c1], type, "m");
		expect(packetHash(source, [c1], type, "m")).toBe(base);
		expect(packetHash({ ...source, line: 99, name: "renamed" }, [{ ...c1, file: "moved.ts" }], type, "m")).toBe(base);
		expect(packetHash(source, [c1], { ...type, description: "other", k: 9 }, "m")).toBe(base);
		expect(buildPacket(source, [c1], type, "m").packetHash).toBe(base);
	});

	it("N2: capText leaves text at or under the cap untouched", () => {
		expect(capText("abc", 3)).toBe("abc");
		expect(capText("", 3)).toBe("");
		const packet = buildPacket(source, [c1], type, "m");
		expect(packet.state.candidates[0]?.text).toBe(c1.text);
	});

	it("N3: an empty candidate list yields a none-only question", () => {
		const packet = buildPacket(source, [], type, "m");
		expect(Object.keys(packet.question.criteria)).toEqual([NONE_ID]);
		expect(packet.candidateIds).toEqual([]);
		expect(candidateIdMap([]).size).toBe(0);
		expect(packet.packetHash).not.toBe(packetHash(source, [c1], type, "m"));
	});

	it("N4: PACKET_VERSION is part of the hash", () => {
		const manual = createHash("sha256");
		for (const part of [PACKET_VERSION, "m", type.name, type.question, source.hash, c1.hash]) {
			manual.update(part).update("\0");
		}
		expect(packetHash(source, [c1], type, "m")).toBe(manual.digest("hex"));
	});
});
