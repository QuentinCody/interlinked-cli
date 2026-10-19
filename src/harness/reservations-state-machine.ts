// interlinked-tdd: exempt
// ===========================================
// Reservation state machine + agent identity (single source of truth)
// ===========================================
// Pure, class-free building blocks for the reservation manager:
//   - Agent identity (`canonicalAgent` / `sameOwner`): collapses synthetic
//     per-source session-name variants so a session always owns its own
//     reservations.
//   - The cache state-machine: each transition is declared *once* in
//     `applyTransition`, so the live cache mutation and any event-log replay
//     run through the same dispatch and cannot drift. This is the Bitar
//     single-source-of-truth pattern adapted for TS.
//   - The server/event-sink interfaces the manager wires to.
//
// Everything here is a leaf the `ReservationManager` class depends on; none
// of it depends back on the class, so this module is import-safe.

import type { ReservationEntry } from "./types.js";

// ===========================================
// Agent identity — self-ownership across name variants
// ===========================================
// One local CLI session can surface under more than one synthetic agent
// name: a `session-<id>` from one hook path and a `session-<source>-<id>`
// from another (raw vs framed socket; `event.agent_name` vs the session
// fallback). With raw string equality those variants look like two
// different agents, so a session would block *itself* out of a file it had
// just reserved — and the local/remote cohort split would even label the
// holder "remote". That whole multi-identity model is a holdover from the
// mcp-agent-chat era, when every agent name was server-issued and globally
// unique. `canonicalAgent` collapses the variants so a session always owns
// its own reservations; non-`session-` names (explicit agent names,
// subagent ids, real remote agents) pass through untouched, so genuine
// cross-agent coordination is preserved.

/** Agent-source tokens that may appear as the `<source>` infix in a
 *  synthetic `session-<source>-<id>` agent name. */
const KNOWN_AGENT_SOURCES = ["claude", "codex", "gemini", "copilot", "cursor"] as const;

/** Canonical owner key for a reservation agent name: strips a known
 *  `session-<source>-` prefix down to `session-<id>`. Idempotent, and a
 *  no-op for any name that isn't a synthetic per-source session name. */
export function canonicalAgent(name: string): string {
	for (const source of KNOWN_AGENT_SOURCES) {
		const prefix = `session-${source}-`;
		if (name.startsWith(prefix)) return `session-${name.slice(prefix.length)}`;
	}
	return name;
}

/** True when two agent names denote the same reservation owner — an exact
 *  match, or the same session expressed under different synthetic-name
 *  variants. Used for every ownership decision in {@link ReservationManager}. */
export function sameOwner(a: string, b: string): boolean {
	return a === b || canonicalAgent(a) === canonicalAgent(b);
}

export interface ServerApiClient {
	reserveFile(filePath: string, agentName: string, ttlSeconds: number): Promise<void>;
	releaseFile(filePath: string, agentName: string): Promise<void>;
	listReservations(): Promise<ServerReservation[]>;
}

export interface ServerReservation {
	agent_name: string;
	path_pattern: string;
	expires_at?: string;
}

/** Per-event hook invoked on every grant / release / conflict. The hook
 *  is fire-and-forget — exceptions inside it must not break the lock
 *  primitive. Used to write reservation-events.jsonl from the harness. */
export type ReservationEventSink = (event: ReservationLogEvent) => void;

/** Join keys a reservation row carries so it joins to files-touched
 *  (`file-touch.v1`) rows, which identify the actor by session_id +
 *  subagent_id + tool_use_id — never by the reservation `agent_name`.
 *  Grant/conflict rows describe the REQUESTING call; release rows carry the
 *  owner's identity and the grant's call (`grant_tool_use_id`); conflict rows
 *  also carry the HOLDER's identity. Absent on rows written without an actor. */
export interface ReservationJoinFields {
	session_id?: string;
	subagent_id?: string | null;
	tool_use_id?: string | null;
	event_id?: string | null;
	grant_tool_use_id?: string | null;
	holder_session_id?: string;
	holder_subagent_id?: string | null;
	holder_tool_use_id?: string | null;
}

export interface ReservationLogEvent extends ReservationJoinFields {
	ts: string;
	action: "grant" | "release" | "conflict" | "release_all";
	file: string;
	agent_name: string;
	holder?: string;
	cohort?: "local" | "remote";
	expires_at?: string;
	/** Why a conflict fired — "preexisting" (cache hit on acquire) or
	 *  "server-rejected" (optimistic local grant was rolled back after the
	 *  server-side ack returned an error). */
	conflict_reason?: "preexisting" | "server-rejected";
}

// ===========================================
// Reservation state-machine (single source of truth)
// ===========================================
// Each transition is declared *once* below. Both the live cache mutation
// and any future event-log replay run through `applyTransition`, so the
// two directions cannot drift. Adding a new state change means adding one
// entry to TRANSITIONS — no parallel updates required.

/** Cache state — a Map of file_pattern → ReservationEntry. Equivalent to
 *  the field on ReservationManager; declared as a type alias so the
 *  pure transition functions can be exercised by property tests without
 *  instantiating the class (see `__tests__/reservations.test.ts`). */
export type ReservationCache = Map<string, ReservationEntry>;

/** All state-changing events the cache understands. Discriminated union so
 *  exhaustiveness is checked at compile time. */
export type ReservationTxn =
	| {
			kind: "grant_local";
			file: string;
			agent: string;
			reservedAt: string;
			expiresAt: string;
	  }
	| {
			kind: "grant_remote";
			file: string;
			agent: string;
			reservedAt: string;
			expiresAt: string;
	  }
	| { kind: "release"; file: string; agent: string }
	| { kind: "release_all"; agent: string }
	| { kind: "expire"; file: string }
	| { kind: "evict_remote"; file: string };

/**
 * Apply a single transition. Returns the next cache (functional) — caller
 * is free to mutate in place if it owns the cache (the class does), or to
 * discard the result and re-derive (property tests do).
 *
 * Each branch is the *one* place a given event-kind affects the state. If
 * a future change adds a new event-kind, TypeScript's exhaustiveness
 * checker fires on the `never` default — that's the structural guarantee
 * Bitar's framing buys us in TS without GADTs.
 */
export function applyTransition(state: ReservationCache, txn: ReservationTxn): ReservationCache {
	switch (txn.kind) {
		case "grant_local":
			state.set(txn.file, {
				file_pattern: txn.file,
				agent_name: txn.agent,
				cohort: "local",
				reserved_at: txn.reservedAt,
				expires_at: txn.expiresAt,
			});
			return state;
		case "grant_remote":
			state.set(txn.file, {
				file_pattern: txn.file,
				agent_name: txn.agent,
				cohort: "remote",
				reserved_at: txn.reservedAt,
				expires_at: txn.expiresAt,
			});
			return state;
		case "release": {
			const entry = state.get(txn.file);
			if (entry && entry.agent_name === txn.agent) state.delete(txn.file);
			return state;
		}
		case "release_all": {
			// Snapshot before mutating: deleting from a Map mid-iteration is
			// safe for visited keys, but the snapshot makes the intent explicit.
			for (const [file, entry] of [...state]) {
				if (entry.agent_name === txn.agent) state.delete(file);
			}
			return state;
		}
		case "expire":
			state.delete(txn.file);
			return state;
		case "evict_remote": {
			const entry = state.get(txn.file);
			if (entry && entry.cohort === "remote") state.delete(txn.file);
			return state;
		}
		default: {
			const _exhaustive: never = txn;
			void _exhaustive;
			return state;
		}
	}
}

/** Replay an event log against an empty cache. Used by property tests to
 *  assert that live execution and replay produce identical state. The
 *  function is pure (modulo the seeded `state` parameter being mutated). */
export function replayTransitions(events: readonly ReservationTxn[]): ReservationCache {
	const state: ReservationCache = new Map();
	for (const e of events) applyTransition(state, e);
	return state;
}
