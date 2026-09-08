import { describe, expect, it } from "vitest";
import { parseBridgeCallResponse, parseBridgeCoordination, parseBridgeReservations } from "./server-bridge-responses.js";

describe("bridge response validation", () => {
	it("unwraps both object response formats", () => {
		expect(parseBridgeCallResponse({ result: { granted: true } })).toEqual({ granted: true });
		expect(parseBridgeCallResponse({ granted: true })).toEqual({ granted: true });
	});

	it.each([null, [], { result: "success" }])("rejects malformed response %j", (value) => {
		expect(() => parseBridgeCallResponse(value)).toThrow("must be an object");
	});

	it("retains the server's explicit error", () => {
		expect(() => parseBridgeCallResponse({ error: { message: "reservation denied" } })).toThrow("reservation denied");
	});

	it("retains valid reservations with omitted expiration", () => {
		expect(parseBridgeReservations([{ agent_name: "alice", path_pattern: "src/*.ts", extra: true }]))
			.toEqual([{ agent_name: "alice", path_pattern: "src/*.ts" }]);
	});

	it.each([[null], [{ agent_name: 42, path_pattern: "src/*.ts" }], [{ agent_name: "alice", path_pattern: "x", expires_at: 42 }]])
		("rejects malformed reservation rows %j", (row) => {
			expect(parseBridgeReservations([row])).toEqual([]);
		});

	const coordination = { heartbeat_recorded: true, unread: { total: 1, urgent: [
		{ id: 1, subject: "review", importance: "high", sender_name: "alice", preview: "ready" },
	] }, task_changes: [] };

	it("accepts coordination with omitted optional metadata", () => {
		expect(parseBridgeCoordination(coordination)).toEqual(coordination);
	});

	it.each([
		{ ...coordination, unread: { total: 1, urgent: [null] } },
		{ ...coordination, unread: { total: 1, urgent: [{ ...coordination.unread.urgent[0], importance: 42 }] } },
		{ ...coordination, task_changes: [{ id: 1, title: "task", status: "open", change_type: "unknown" }] },
		{ ...coordination, intent: { id: 1 } },
	])("rejects malformed nested coordination %j", (value) => {
		expect(parseBridgeCoordination(value)).toBeNull();
	});
});
