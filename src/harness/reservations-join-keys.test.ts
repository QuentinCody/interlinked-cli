// Reservation rows carry the files-touched join keys (U3a, 2026-10-08).
import { describe, expect, it } from "vitest";
import { CohortManager } from "./cohort.js";
import { reservationActorOf } from "./reservation-actor.js";
import { type ReservationLogEvent, ReservationManager } from "./reservations.js";

const writer = reservationActorOf({ session_id: "sess-w", subagent_id: "sub-w", tool_use_id: "toolu_w", event_id: "evt-w" });
const other = reservationActorOf({ session_id: "sess-o", tool_use_id: "toolu_o", event_id: "evt-o" });

function setup(): { cohort: CohortManager; events: ReservationLogEvent[]; manager: ReservationManager } {
	const events: ReservationLogEvent[] = [];
	return { cohort: new CohortManager(), events, manager: new ReservationManager(undefined, 30_000, (e) => events.push(e)) };
}

function reserve(manager: ReservationManager, cohort: CohortManager, file: string, agentName: string, actor = writer, dryRun = false): void {
	manager.checkAndReserveBatch({ filePaths: [file], agentName, cohort, actor, dryRun, shouldBlock: () => false });
}

describe("reservation join keys — positive (must fire)", () => {
	it("P1: a grant row carries the requesting call's session, subagent, tool_use_id and event_id", () => {
		const { cohort, events, manager } = setup();
		reserve(manager, cohort, "/r/a.ts", "sub-w");
		expect(events[0]).toMatchObject({
			action: "grant", agent_name: "sub-w",
			session_id: "sess-w", subagent_id: "sub-w", tool_use_id: "toolu_w", event_id: "evt-w",
		});
	});
	it("P2: a conflict row carries both the requester's keys and the holder's grant keys", () => {
		const { cohort, events, manager } = setup();
		reserve(manager, cohort, "/r/a.ts", "holder", other);
		reserve(manager, cohort, "/r/a.ts", "sub-w");
		const conflict = events.find((e) => e.action === "conflict");
		expect(conflict).toMatchObject({
			holder: "holder", session_id: "sess-w", tool_use_id: "toolu_w",
			holder_session_id: "sess-o", holder_subagent_id: null, holder_tool_use_id: "toolu_o",
		});
	});
	it("P2b: a conflict against a GLOB lease still carries the holder's grant keys (2026-10-15 review)", () => {
		const { cohort, events, manager } = setup();
		reserve(manager, cohort, "src/auth/**", "holder", other);
		reserve(manager, cohort, "src/auth/login.ts", "sub-w");
		const conflict = events.find((e) => e.action === "conflict");
		expect(conflict).toMatchObject({
			file: "src/auth/login.ts", holder: "holder",
			holder_session_id: "sess-o", holder_subagent_id: null, holder_tool_use_id: "toolu_o",
		});
	});
	it("P3: a release row replays the owner's identity and the grant's tool_use_id", () => {
		const { cohort, events, manager } = setup();
		reserve(manager, cohort, "/r/a.ts", "sub-w");
		manager.release("/r/a.ts", "sub-w", cohort);
		expect(events.find((e) => e.action === "release")).toMatchObject({
			session_id: "sess-w", subagent_id: "sub-w", grant_tool_use_id: "toolu_w",
		});
	});
});

describe("reservation join keys — negative (must not fire)", () => {
	it("N1: a dry-run batch grants nothing and writes no row", () => {
		const { cohort, events, manager } = setup();
		reserve(manager, cohort, "/r/a.ts", "test", writer, true);
		expect(events).toEqual([]);
		expect(manager.getAll()).toEqual([]);
	});
	it("N2: a dry-run batch still reports the conflict a real call would hit", () => {
		const { cohort, events, manager } = setup();
		reserve(manager, cohort, "/r/a.ts", "holder", other);
		events.length = 0;
		const result = manager.checkAndReserveBatch({
			filePaths: ["/r/a.ts"], agentName: "test", cohort, dryRun: true, shouldBlock: () => true,
		});
		expect(result?.conflict.agent_name).toBe("holder");
		expect(events).toEqual([]);
	});
	it("N3: a row written without an actor keeps the legacy shape (no join keys invented)", () => {
		const { cohort, events, manager } = setup();
		manager.checkAndReserve("/r/a.ts", "legacy", cohort);
		expect(Object.keys(events[0] ?? {}).sort()).toEqual(["action", "agent_name", "cohort", "expires_at", "file", "ts"]);
	});
	it("N4: a release after re-grant by another owner does not inherit the first grant's keys", () => {
		const { cohort, events, manager } = setup();
		reserve(manager, cohort, "/r/a.ts", "sub-w");
		manager.release("/r/a.ts", "sub-w", cohort);
		manager.checkAndReserve("/r/a.ts", "legacy", cohort);
		manager.release("/r/a.ts", "legacy", cohort);
		const last = events.filter((e) => e.action === "release").at(-1);
		expect(last?.grant_tool_use_id).toBeUndefined();
	});
});
