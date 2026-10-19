// ===========================================
// Reservation actor identity (join keys for reservation-events.jsonl)
// ===========================================
// The reservation owner name (`agent_name`: `session-<id8>`, a subagent id, an
// explicit agent name) is NOT a field files-touched rows carry. Joining "who
// held a lease" to "who touched the file" therefore had to be LEARNED from
// timing (E26, 2026-10-08: 2,648 of 2,695 "another actor holds a reservation"
// cases were the writer's own grant ≤60 s earlier). Each row now also carries
// the identity fields file-touch.v1 rows use (`data-capture-native.ts`
// eventIdentity): session_id, subagent_id, tool_use_id, event_id.
//
// Timer-driven releases happen with no tool call in flight, so the grant's
// actor is remembered here per (canonical owner, file) and replayed onto the
// release row. The ledger is bounded; a lost entry only drops the join keys.

import type { HarnessEvent } from "./types.js";
import { canonicalAgent, type ReservationJoinFields } from "./reservations-state-machine.js";

export interface ReservationActor {
	session_id: string;
	subagent_id: string | null;
	tool_use_id: string | null;
	event_id: string | null;
}

export const RESERVATION_ACTOR_CEILING = 4096;

/** The identity of the call that requested a reservation. */
export function reservationActorOf(
	event: Pick<HarnessEvent, "session_id"> & Partial<Pick<HarnessEvent, "subagent_id" | "tool_use_id" | "event_id">>,
): ReservationActor {
	return {
		session_id: event.session_id,
		subagent_id: event.subagent_id ?? null,
		tool_use_id: event.tool_use_id ?? null,
		event_id: event.event_id ?? null,
	};
}

/** Grant / conflict rows: the requesting call. */
export function requesterJoinFields(actor: ReservationActor | undefined): ReservationJoinFields {
	if (!actor) return {};
	return {
		session_id: actor.session_id,
		subagent_id: actor.subagent_id,
		tool_use_id: actor.tool_use_id,
		event_id: actor.event_id,
	};
}

/** Release rows: the owner, plus the call that took the grant. */
export function ownerJoinFields(grant: ReservationActor | undefined): ReservationJoinFields {
	if (!grant) return {};
	return { session_id: grant.session_id, subagent_id: grant.subagent_id, grant_tool_use_id: grant.tool_use_id };
}

/** Conflict rows: the holder of the lease the requester ran into. */
export function holderJoinFields(grant: ReservationActor | undefined): ReservationJoinFields {
	if (!grant) return {};
	return {
		holder_session_id: grant.session_id,
		holder_subagent_id: grant.subagent_id,
		holder_tool_use_id: grant.tool_use_id,
	};
}

/** Grant-time actor per (canonical owner, file); insertion-order bounded. */
export class ReservationActorLedger {
	private readonly byKey = new Map<string, ReservationActor>();

	private key(owner: string, file: string): string {
		return `${canonicalAgent(owner)}\0${file}`;
	}

	remember(owner: string, file: string, actor: ReservationActor): void {
		const key = this.key(owner, file);
		this.byKey.delete(key);
		this.byKey.set(key, actor);
		while (this.byKey.size > RESERVATION_ACTOR_CEILING) {
			const oldest = this.byKey.keys().next().value;
			if (oldest === undefined) break;
			this.byKey.delete(oldest);
		}
	}

	get(owner: string, file: string): ReservationActor | undefined {
		return this.byKey.get(this.key(owner, file));
	}

	forget(owner: string, file: string): void {
		this.byKey.delete(this.key(owner, file));
	}
}
