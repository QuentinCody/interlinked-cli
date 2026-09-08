import { describe, expect, it } from "vitest";
import { parseGitContext, parsePushResult } from "./git-response.js";
import { parseWatchAgents, parseWatchMessages, parseWatchTasks } from "./watch-response.js";

describe("server response boundaries", () => {
	it.each([
		["checkpoint entry", () => parseGitContext({ latest_checkpoint: [] })],
		["checkpoint id", () => parseGitContext({ latest_checkpoint: { id: "42", agent: "worker" } })],
		["bridge event", () => parseGitContext({ bridge_events: [null] })],
		["trailer entry", () => parsePushResult({ trailers: [17] })],
		["notes value", () => parsePushResult({ notes: [] })],
		["task entry", () => parseWatchTasks({ tasks: [null] })],
		["agent entry", () => parseWatchAgents({ agents: [false] })],
		["unread count", () => parseWatchMessages({ has_unread: true, unread_count: "2", oldest_unread_at: null })],
	] as const)("rejects a malformed %s before consumers use it", (_name, parse) => {
		expect(parse).toThrow(/Invalid .* response/);
	});

	it("preserves partial Git responses, nullable commit ids, and future metadata", () => {
		const context = { commit_sha: null, latest_checkpoint: { id: 42, agent: "worker" }, future_field: { enabled: true } };
		expect(parseGitContext(context)).toEqual(context);
		expect(parsePushResult({ trailers: ["Interlinked-Checkpoint: 42"] })).toEqual({ trailers: ["Interlinked-Checkpoint: 42"] });
		expect(parsePushResult({})).toEqual({});
		expect(parseGitContext(undefined)).toBeNull();
	});

	it("accepts nullable watch metadata and omitted feeds", () => {
		const agent = { name: "worker", role: null, status: "active", last_active_ts: null };
		const task = { id: 42, title: "Fix validation", status: "pending", priority: "normal", assignee_name: null };
		expect(parseWatchAgents({ agents: [agent] }).agents).toEqual([agent]);
		expect(parseWatchTasks({ tasks: [task] }).tasks).toEqual([task]);
		expect(parseWatchMessages({ has_unread: true, unread_count: 2, oldest_unread_at: null }).unread_count).toBe(2);
		expect(parseWatchTasks({})).toEqual({});
	});
});
