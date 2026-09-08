import { wireAbsentOptional, parseWire, wireArray, wireBoolean, wireNumber, wireObject, wireString, type WireValidator } from "../lib/value-validation.js";

export interface TaskSnapshot {
	id: number;
	title: string;
	status: string;
	priority: string;
	assignee_name: string | null;
}

export interface AgentSnapshot {
	name: string;
	role: string | null;
	status: string;
	last_active_ts: string | null;
}

export interface UnreadSnapshot {
	has_unread: boolean;
	unread_count: number;
	oldest_unread_at: string | null;
}

const nullableString: WireValidator<string | null> = (value) => value === null || typeof value === "string";
const isTask = wireObject<TaskSnapshot>({ id: wireNumber, title: wireString, status: wireString, priority: wireString, assignee_name: nullableString });
const isAgent = wireObject<AgentSnapshot>({ name: wireString, role: nullableString, status: wireString, last_active_ts: nullableString });
const isUnread = wireObject<UnreadSnapshot>({ has_unread: wireBoolean, unread_count: wireNumber, oldest_unread_at: nullableString });
const isTasks = wireObject<{ tasks?: TaskSnapshot[] }>({ tasks: wireAbsentOptional(wireArray(isTask)) });
const isAgents = wireObject<{ agents?: AgentSnapshot[] }>({ agents: wireAbsentOptional(wireArray(isAgent)) });

export function parseWatchMessages(value: unknown): UnreadSnapshot {
	return parseWire(value, isUnread, "has_unread_messages response");
}

export function parseWatchTasks(value: unknown): { tasks?: TaskSnapshot[] } {
	return parseWire(value, isTasks, "list_tasks response");
}

export function parseWatchAgents(value: unknown): { agents?: AgentSnapshot[] } {
	return parseWire(value, isAgents, "list_agents response");
}
