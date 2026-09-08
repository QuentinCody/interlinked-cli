import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import {
	wireAbsentOptional, wireArray, wireBoolean, wireLiteral, wireNullable, wireNumber,
	wireObject, wireString,
} from "../lib/value-validation.js";
import type { CoordinationResponse } from "./auto-coordinate.js";
import type { ServerReservation } from "./reservations.js";

const isReservationList = wireArray(wireObject<ServerReservation>({
	agent_name: wireString,
	path_pattern: wireString,
	expires_at: wireAbsentOptional(wireString),
}));

export function parseBridgeReservations(value: unknown): ServerReservation[] {
	if (!isReservationList(value)) return [];
	return value.map(({ agent_name, path_pattern, expires_at }) => ({
		agent_name, path_pattern,
		...(expires_at !== undefined ? { expires_at } : {}),
	}));
}

export function parseBridgeCallResponse(value: unknown): JsonObject {
	if (!isJsonObject(value)) throw new Error("Server API response must be an object");
	if (value.result) {
		if (!isJsonObject(value.result)) throw new Error("Server API result must be an object");
		return value.result;
	}
	if (value.error) {
		const message = isJsonObject(value.error) ? value.error.message || value.error : value.error;
		throw new Error(String(message));
	}
	return value;
}

const isCoordinationResponse = wireObject<CoordinationResponse>({
	heartbeat_recorded: wireBoolean,
	unread: wireObject<CoordinationResponse["unread"]>({
		total: wireNumber,
		urgent: wireArray(wireObject<CoordinationResponse["unread"]["urgent"][number]>({
			id: wireNumber, subject: wireString, importance: wireString,
			sender_name: wireString, preview: wireString,
		})),
	}),
	task_changes: wireArray(wireObject<CoordinationResponse["task_changes"][number]>({
		id: wireNumber, title: wireString, status: wireString,
		change_type: wireLiteral("reassigned", "cancelled", "blocked"),
		current_assignee: wireAbsentOptional(wireString),
	})),
	intent: wireAbsentOptional(wireNullable(wireObject<NonNullable<CoordinationResponse["intent"]>>({
		id: wireNumber, goal: wireString, status: wireString, constraints: wireString,
	}))),
	server_time: wireAbsentOptional(wireString),
});

export function parseBridgeCoordination(value: unknown): CoordinationResponse | null {
	return isCoordinationResponse(value) ? value : null;
}
