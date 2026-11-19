import { describe, expect, it } from "vitest";
import { judgmentId, legacyAliases, legacyJudgmentId, legacySessionToken, sessionToken } from "./session-token.js";

describe("sessionToken — the session part of a judgment id (break R5 #4)", () => {
	it("P1: two UUIDv7 session ids that share their first 8 characters get different tokens", () => {
		const a = "0190aaaa-1111-7000-8000-000000000001";
		const b = "0190aaaa-2222-7000-8000-000000000002";
		expect(legacySessionToken(a)).toBe(legacySessionToken(b));
		expect(sessionToken(a)).not.toBe(sessionToken(b));
	});
	it("P2: the token is 8 lowercase hex characters and stable", () => {
		expect(sessionToken("s")).toMatch(/^[0-9a-f]{8}$/);
		expect(sessionToken("s")).toBe(sessionToken("s"));
	});
});

describe("judgmentId — a call without a usable seq (audit R6 W5)", () => {
	const base = { packet: "p", session_id: "s1", packet_hash: "a".repeat(64), evidence_hash: "b".repeat(64) };
	it("P4: two calls with seq null and equal evidence get different ids from their tool_use_id", () => {
		const a = judgmentId({ ...base, seq: null, tool_use_id: "tu-1" });
		const b = judgmentId({ ...base, seq: null, tool_use_id: "tu-2" });
		expect(a).not.toBe(b);
		expect(a.split(":")).toHaveLength(5);
	});
	it("P5: a negative seq also falls back to the tool_use_id hash", () => {
		expect(judgmentId({ ...base, seq: -1, tool_use_id: "tu-1" })).not.toBe(judgmentId({ ...base, seq: -1, tool_use_id: "tu-2" }));
	});
	it("N2: a seq of 0 or more keeps the seq; the legacy form keeps '?' for a null seq", () => {
		expect(judgmentId({ ...base, seq: 3, tool_use_id: "tu-1" }).split(":")[2]).toBe("3");
		expect(legacyJudgmentId({ ...base, seq: null, tool_use_id: "tu-1" }).split(":")[2]).toBe("?");
		expect(judgmentId({ ...base, seq: null, tool_use_id: null }).split(":")[2]).toBe("?");
	});
});

describe("legacyAliases — old-form ids keep joining where they name one observation", () => {
	type R = { id: string; old: string };
	const rows: R[] = [
		{ id: "new-1", old: "old-1" },
		{ id: "new-2", old: "old-shared" },
		{ id: "new-3", old: "old-shared" },
		{ id: "new-1", old: "old-1" },
	];
	it("P3: a unique old id maps to its new id; an old id two observations share maps to nothing", () => {
		const aliases = legacyAliases(rows, (r) => r.id, (r) => r.old);
		expect(aliases.get("old-1")).toBe("new-1");
		expect(aliases.has("old-shared")).toBe(false);
	});
	it("N1: an old id equal to its new id adds nothing", () => {
		expect(legacyAliases([{ id: "x", old: "x" }], (r) => r.id, (r) => r.old).size).toBe(0);
	});
});
