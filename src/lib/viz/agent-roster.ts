// ===========================================
// Agent Roster — who is working in this repo right now
// ===========================================
// Several agents commonly share one checkout: two Claude Code sessions, a Codex
// run, and any subagents they spawn. Every activity row already names its actor
// (`agent`, `session`, `subagent_id`, `model`), so presence is a FOLD over the
// same stream the dashboard already tails — no new producer, no daemon call.
//
// One actor = one lane in the dashboard's AGENTS lens. A spawned subagent gets
// its OWN lane keyed under its parent, because "the session wrote 40 files" and
// "a subagent it spawned wrote 40 files" are different facts.

import type { VizEvent } from "./event-stream.js";

/** A single actor's live presence: identity, colour, and what it has done. */
export interface AgentPresence {
	/** Stable key: the agent name, or `<agent>/<subagent_id>` for a spawned agent. */
	id: string;
	/** Display name, short enough for a lane header. */
	label: string;
	/** Runner family parsed from the agent name (for example claude, codex, opencode, or pi). */
	runner: string;
	/** Hue (0–359) derived from `id` — the actor's colour everywhere in the UI. */
	hue: number;
	session?: string;
	model?: string;
	/** True when this lane is a subagent spawned by `parent`. */
	isSubagent: boolean;
	parent?: string;
	firstSeen: string;
	lastSeen: string;
	events: number;
	edits: number;
	blocks: number;
	warns: number;
	/** Most recently touched files, newest first, capped for display. */
	files: string[];
	lastTool?: string;
	lastFile?: string;
	/** Distinct subagent ids this actor has spawned. */
	subagents: string[];
}

/** Actor key used when a row carries no agent identity at all. */
export const UNATTRIBUTED = "unattributed";

/** Recent-files ring size per actor — a lane shows a handful, not a history. */
const FILES_KEPT = 6;

/** Tools that mutate the tree. Counted separately: edits are the load-bearing act. */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);

/** Runner families recognized in an agent name (`session-<runner>-<id8>`). */
const RUNNERS = ["claude", "codex", "copilot", "gemini", "cursor", "opencode", "opencode2", "pi", "aider"];

/**
 * Stable hue for an actor id: the same FNV-1a → hue mapping the graph uses for
 * subsystem colours, so one hashing rule explains every colour on screen.
 */
export function hueForAgent(id: string): number {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h % 360;
}

/** Extract the runner family from an agent name, or "unknown". */
export function runnerOf(agent: string): string {
	const lower = agent.toLowerCase();
	return [...RUNNERS].sort((a, b) => b.length - a.length).find((r) => lower.includes(r)) ?? "unknown";
}

/** Compact lane label: runner plus the identifying tail of the agent name. */
export function labelFor(agent: string, subagentId?: string): string {
	const tail = agent.split("-").pop() ?? agent;
	const base = `${runnerOf(agent)}·${tail.slice(0, 8)}`;
	return subagentId ? `${base} ▸ sub·${subagentId.slice(0, 6)}` : base;
}

/** The actor key for an event: subagents get their own lane under their parent. */
export function actorKey(ev: VizEvent): string {
	const agent = ev.agent ?? UNATTRIBUTED;
	return ev.subagent_id ? `${agent}/${ev.subagent_id}` : agent;
}

/** Seed a fresh presence for an actor from the event that revealed it. */
function freshPresence(ev: VizEvent, id: string): AgentPresence {
	const agent = ev.agent ?? UNATTRIBUTED;
	const presence: AgentPresence = {
		id,
		label: labelFor(agent, ev.subagent_id),
		runner: runnerOf(agent),
		hue: hueForAgent(id),
		isSubagent: Boolean(ev.subagent_id),
		firstSeen: ev.ts,
		lastSeen: ev.ts,
		events: 0,
		edits: 0,
		blocks: 0,
		warns: 0,
		files: [],
		subagents: [],
	};
	if (ev.subagent_id) presence.parent = ev.parent_agent ?? agent;
	return presence;
}

/** Push a file onto the actor's recent ring, newest first, without duplicates. */
function rememberFile(presence: AgentPresence, file: string): void {
	const existing = presence.files.indexOf(file);
	if (existing >= 0) presence.files.splice(existing, 1);
	presence.files.unshift(file);
	if (presence.files.length > FILES_KEPT) presence.files.length = FILES_KEPT;
}

/** Fold one event's outcome (edit / block / warn) into the running counters. */
function countOutcome(presence: AgentPresence, ev: VizEvent): void {
	presence.events++;
	if (ev.tool && EDIT_TOOLS.has(ev.tool)) presence.edits++;
	if (ev.decision === "block") presence.blocks++;
	if (ev.severity === "warning" || ev.type === "guard_warn") presence.warns++;
}

/**
 * The live roster. `apply` folds one event and returns the actor's UPDATED
 * presence so a caller can broadcast just that lane — the dashboard re-renders
 * one row per event rather than the whole roster.
 */
export class AgentRoster {
	private readonly actors = new Map<string, AgentPresence>();

	/** Fold an event; returns the affected actor's presence. */
	apply(ev: VizEvent): AgentPresence {
		const id = actorKey(ev);
		let presence = this.actors.get(id);
		if (!presence) {
			presence = freshPresence(ev, id);
			this.actors.set(id, presence);
		}
		presence.lastSeen = ev.ts;
		if (ev.model) presence.model = ev.model;
		if (ev.session) presence.session = ev.session;
		if (ev.tool) presence.lastTool = ev.tool;
		if (ev.file) {
			presence.lastFile = ev.file;
			rememberFile(presence, ev.file);
		}
		countOutcome(presence, ev);
		this.linkSubagent(ev, presence);
		return presence;
	}

	/** Record a spawned subagent on its parent's lane, if the parent is known. */
	private linkSubagent(ev: VizEvent, child: AgentPresence): void {
		if (!ev.subagent_id) return;
		const identity = ev.parent_agent ?? ev.agent;
		if (!identity) return;
		const parent = this.actors.get(identity) ?? [...this.actors.values()].find(
			(actor) => !actor.isSubagent && actor.session === identity,
		);
		if (!parent) return;
		child.parent = parent.id;
		if (!parent.subagents.includes(ev.subagent_id)) parent.subagents.push(ev.subagent_id);
	}

	/** Every known actor, most recently active first. */
	list(): AgentPresence[] {
		return [...this.actors.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
	}

	/** Look up one actor's presence. */
	get(id: string): AgentPresence | undefined {
		return this.actors.get(id);
	}
}

/** Default idle threshold: an actor silent this long reads as idle, not gone. */
export const IDLE_AFTER_MS = 120_000;

/** True when the actor has acted within `idleAfterMs` of `nowMs`. */
export function isActive(presence: AgentPresence, nowMs: number, idleAfterMs = IDLE_AFTER_MS): boolean {
	const last = Date.parse(presence.lastSeen);
	if (!Number.isFinite(last)) return false;
	return nowMs - last <= idleAfterMs;
}
