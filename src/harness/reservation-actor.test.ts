import { describe, expect, it } from "vitest";
import {
	holderJoinFields,
	ownerJoinFields,
	RESERVATION_ACTOR_CEILING,
	ReservationActorLedger,
	requesterJoinFields,
	reservationActorOf,
} from "./reservation-actor.js";

const event = { session_id: "s1", subagent_id: "a1", tool_use_id: "toolu_1", event_id: "evt-1" };

describe("reservationActorOf + join fields — positive (must fire)", () => {
	it("P1: copies the file-touch.v1 identity fields off the event", () => {
		expect(reservationActorOf(event)).toEqual({
			session_id: "s1", subagent_id: "a1", tool_use_id: "toolu_1", event_id: "evt-1",
		});
	});
	it("P2: requester fields carry session, subagent, tool_use_id and event_id", () => {
		expect(requesterJoinFields(reservationActorOf(event))).toEqual({
			session_id: "s1", subagent_id: "a1", tool_use_id: "toolu_1", event_id: "evt-1",
		});
	});
	it("P3: owner fields name the grant's call as grant_tool_use_id", () => {
		expect(ownerJoinFields(reservationActorOf(event))).toEqual({
			session_id: "s1", subagent_id: "a1", grant_tool_use_id: "toolu_1",
		});
	});
	it("P4: holder fields prefix the holder's identity", () => {
		expect(holderJoinFields(reservationActorOf(event))).toEqual({
			holder_session_id: "s1", holder_subagent_id: "a1", holder_tool_use_id: "toolu_1",
		});
	});
	it("P5: the ledger finds a grant under any synthetic name variant of its owner", () => {
		const ledger = new ReservationActorLedger();
		ledger.remember("session-claude-abc", "/r/a.ts", reservationActorOf(event));
		expect(ledger.get("session-abc", "/r/a.ts")?.tool_use_id).toBe("toolu_1");
	});
});

describe("reservationActorOf + join fields — negative (must not fire)", () => {
	it("N1: an absent actor yields no fields (legacy row shape unchanged)", () => {
		expect(requesterJoinFields(undefined)).toEqual({});
		expect(ownerJoinFields(undefined)).toEqual({});
		expect(holderJoinFields(undefined)).toEqual({});
	});
	it("N2: missing optional identity becomes null, never a borrowed value", () => {
		expect(reservationActorOf({ session_id: "s2" })).toEqual({
			session_id: "s2", subagent_id: null, tool_use_id: null, event_id: null,
		});
	});
	it("N3: a forgotten grant and another owner's grant are not found", () => {
		const ledger = new ReservationActorLedger();
		ledger.remember("agent-x", "/r/a.ts", reservationActorOf(event));
		expect(ledger.get("agent-y", "/r/a.ts")).toBeUndefined();
		ledger.forget("agent-x", "/r/a.ts");
		expect(ledger.get("agent-x", "/r/a.ts")).toBeUndefined();
	});
	it("N4: the ledger is bounded and drops the stalest grant first", () => {
		const ledger = new ReservationActorLedger();
		for (let i = 0; i <= RESERVATION_ACTOR_CEILING; i++) {
			ledger.remember("agent", `/r/${i}.ts`, reservationActorOf(event));
		}
		expect(ledger.get("agent", "/r/0.ts")).toBeUndefined();
		expect(ledger.get("agent", `/r/${RESERVATION_ACTOR_CEILING}.ts`)).toBeDefined();
	});
});
