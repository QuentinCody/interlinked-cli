// ===========================================
// Per-actor taint lineage (H3 option B3)
// ===========================================
// A subagent's tool calls arrive under the PARENT session id, so one
// session-wide sensitivity field made one worker's secret-shaped output block
// the network for every other actor (session c698b9a9: 41 actors). This module
// keeps one level per ACTOR (`session-state-mutators.ts::actorKeyOf`, the key
// the step budget already uses) and preserves the exfiltration property along
// every channel the harness observes between actors:
//
//   child → parent (result message): a ratchet raises the acting actor AND
//     every ancestor at once, up to the root (the session itself).
//   parent → child (spawn prompt): an actor inherits its parent's level at the
//     moment it is registered (SubagentStart, or the first event that carries
//     its `subagent_id` — then it inherits the root's CURRENT level).
//   actor → actor through files: taint-file-lineage.ts (B5).
//
// A sibling that was already running when another actor ratcheted keeps its
// own level. `session.sensitivity_level` stays the ROOT level, which is the
// max over every actor (every ratchet reaches the root), so display, the
// statusline and the step limit read it unchanged.
//
// Fail-safe defaults: an actor key with no entry (the parent's own events, a
// runner that sends no `subagent_id`, an evicted entry, a snapshot written
// before this module) reads the session level. A ratchet with no actor raises
// every actor. `parent_agent` is null in practice, so the tree is depth-1; a
// non-null parent is honored and its ancestors are walked.

import type { JsonObject } from "../lib/json-types.js";
import type { SensitivityLevel, SessionTrajectory } from "./types.js";

/** Numeric ordering for monotone sensitivity ratcheting (Bell-LaPadula MLS model).
 *  Re-exported by taint-tracker.ts, its historical home. */
export const SENSITIVITY_ORDER: Record<SensitivityLevel, number> = {
	Public: 0,
	Internal: 1,
	Confidential: 2,
	HighlyConfidential: 3,
};

/** Bound on registered subagents per session; the oldest is evicted first and
 *  then reads the session level (the max), never a lower one. */
export const MAX_LINEAGE_ACTORS = 2048;

/** Bound on the parent walk; a cycle in reported parents cannot loop. */
const MAX_ANCESTOR_DEPTH = 64;

export function isSensitivityLevel(v: unknown): v is SensitivityLevel {
	return typeof v === "string" && Object.hasOwn(SENSITIVITY_ORDER, v);
}

export function higherLevel(a: SensitivityLevel, b: SensitivityLevel): SensitivityLevel {
	return SENSITIVITY_ORDER[b] > SENSITIVITY_ORDER[a] ? b : a;
}

interface LineageActor {
	/** Parent actor key; the session id is the root. */
	parent: string;
	level: SensitivityLevel;
	/** `tool_call_count` when the actor was registered. */
	spawned_at: number;
}

const STORE = new WeakMap<Readonly<SessionTrajectory>, Map<string, LineageActor>>();

function actorsOf(session: Readonly<SessionTrajectory>): Map<string, LineageActor> {
	let actors = STORE.get(session);
	if (!actors) {
		actors = new Map();
		STORE.set(session, actors);
	}
	return actors;
}

/** True when `actor` is a registered subagent (not the root, not unknown). */
export function isSubagentActor(session: Readonly<SessionTrajectory>, actor: string | undefined): boolean {
	return actor !== undefined && STORE.get(session)?.has(actor) === true;
}

/** The acting actor's effective level. No actor, the root, or an unregistered
 *  key ⇒ the session (root) level. */
export function actorLevel(session: Readonly<SessionTrajectory>, actor?: string): SensitivityLevel {
	const entry = actor === undefined ? undefined : STORE.get(session)?.get(actor);
	return entry?.level ?? session.sensitivity_level;
}

/**
 * Register a subagent at spawn: it inherits its parent's CURRENT level (the
 * root's when no parent is named). Returns false for the root and for an
 * actor already registered — a later SubagentStart never resets a level.
 */
export function registerActor(session: SessionTrajectory, actor: string, parent?: string): boolean {
	if (actor === session.session_id) return false;
	const actors = actorsOf(session);
	if (actors.has(actor)) return false;
	const parentKey = parent && parent !== actor ? parent : session.session_id;
	actors.set(actor, {
		parent: parentKey,
		level: actorLevel(session, parentKey),
		spawned_at: session.tool_call_count,
	});
	if (actors.size > MAX_LINEAGE_ACTORS) {
		const oldest = actors.keys().next().value;
		if (oldest !== undefined) actors.delete(oldest);
	}
	return true;
}

/** The actor and every registered ancestor, nearest first. */
function chainOf(actors: ReadonlyMap<string, LineageActor>, actor: string): string[] {
	const chain: string[] = [];
	let current: string | undefined = actor;
	while (current !== undefined && actors.has(current) && !chain.includes(current)) {
		if (chain.length >= MAX_ANCESTOR_DEPTH) break;
		chain.push(current);
		current = actors.get(current)?.parent;
	}
	return chain;
}

export interface RaiseResult {
	/** The acting actor's effective level rose. */
	actorRose: boolean;
	/** The root (session) level rose. */
	sessionRose: boolean;
}

/**
 * Raise `actor` and all its ancestors to at least `level`. The root always
 * receives it. With no actor every registered actor is raised (fail safe for
 * a caller that cannot name one).
 */
export function raiseActorLevel(
	session: SessionTrajectory,
	actor: string | undefined,
	level: SensitivityLevel,
): RaiseResult {
	const before = actorLevel(session, actor);
	const actors = STORE.get(session);
	if (actors) {
		const targets = actor === undefined ? [...actors.keys()] : chainOf(actors, actor);
		for (const key of targets) {
			const entry = actors.get(key);
			if (entry) entry.level = higherLevel(entry.level, level);
		}
	}
	const sessionRose = SENSITIVITY_ORDER[level] > SENSITIVITY_ORDER[session.sensitivity_level];
	if (sessionRose) session.sensitivity_level = level;
	return { actorRose: SENSITIVITY_ORDER[level] > SENSITIVITY_ORDER[before], sessionRose };
}

/** Operator clear of every subagent level (the root is the session field,
 *  which the caller lowers). */
export function clearAllActorLevels(session: SessionTrajectory): void {
	for (const entry of STORE.get(session)?.values() ?? []) entry.level = "Public";
}

/** Operator clear of one subagent. Null when `actor` is not a registered
 *  subagent (the root is cleared only with every actor). */
export function clearOneActorLevel(session: SessionTrajectory, actor: string): SensitivityLevel | null {
	const entry = STORE.get(session)?.get(actor);
	if (!entry) return null;
	const previous = entry.level;
	entry.level = "Public";
	return previous;
}

export interface ActorLineageEntry {
	actor: string;
	/** Null for the root. */
	parent: string | null;
	level: SensitivityLevel;
	/** Null for the root. */
	spawned_at: number | null;
}

/** Root first (the session id at the session level), then every subagent in
 *  registration order. */
export function lineageEntries(session: Readonly<SessionTrajectory>): ActorLineageEntry[] {
	const root: ActorLineageEntry = {
		actor: session.session_id,
		parent: null,
		level: session.sensitivity_level,
		spawned_at: null,
	};
	const subagents = [...(STORE.get(session)?.entries() ?? [])].map(([actor, e]) => ({
		actor,
		parent: e.parent,
		level: e.level,
		spawned_at: e.spawned_at,
	}));
	return [root, ...subagents];
}

/** Snapshot form (`taint_actors`): subagents only — the root is the stored
 *  session level. */
export function serializeLineage(session: Readonly<SessionTrajectory>): JsonObject[] {
	return lineageEntries(session)
		.slice(1)
		.map((e) => ({ actor: e.actor, parent: e.parent, level: e.level, spawned_at: e.spawned_at }));
}

function readRow(v: unknown): ActorLineageEntry | null {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
	const o: Partial<Record<string, unknown>> = { ...v };
	if (typeof o.actor !== "string" || typeof o.parent !== "string" || !isSensitivityLevel(o.level)) return null;
	const spawned = typeof o.spawned_at === "number" && Number.isFinite(o.spawned_at) ? o.spawned_at : 0;
	return { actor: o.actor, parent: o.parent, level: o.level, spawned_at: spawned };
}

/** Parse snapshot rows, dropping every malformed one: an actor without a row
 *  re-registers on its next event at the root's level (fail safe). */
export function readLineageEntries(v: unknown): ActorLineageEntry[] {
	if (!Array.isArray(v)) return [];
	return v.map(readRow).filter((row): row is ActorLineageEntry => row !== null);
}

/** Hydrate: restore the rows a snapshot carried. An absent field (a snapshot
 *  from before this module) restores nothing, so every actor inherits the
 *  stored session level when it is next seen. Returns the rows kept. */
export function restoreLineage(session: SessionTrajectory, v: unknown): number {
	const actors = actorsOf(session);
	actors.clear();
	for (const row of readLineageEntries(v).slice(-MAX_LINEAGE_ACTORS)) {
		if (row.actor === session.session_id) continue;
		actors.set(row.actor, { parent: row.parent ?? session.session_id, level: row.level, spawned_at: row.spawned_at ?? 0 });
	}
	return actors.size;
}
