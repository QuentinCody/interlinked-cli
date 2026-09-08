import { wireAbsentOptional, parseWire, wireArray, wireObject, wireOptional, wireRecord, wireString, wireUnknown } from "../../lib/value-validation.js";
// ===========================================
// CLI Activity + Workspace Regression Tests
// ===========================================

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCallTool = vi.fn();
const mockFetchWorkspaces = vi.fn();
const mockReadLocalActivity = vi.fn();
const mockMergeAndDedup = vi.fn();

vi.mock("../../lib/api-client.js", () => ({
	getClient: () => ({
		callTool: mockCallTool,
		fetchWorkspaces: mockFetchWorkspaces,
	}),
}));

vi.mock("../../lib/local-activity.js", () => ({
	readLocalActivity: (...args: unknown[]) => mockReadLocalActivity(...args),
	mergeAndDedup: (...args: unknown[]) => mockMergeAndDedup(...args),
}));

describe("Activity feed response contract regressions", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
		mockCallTool.mockReset();
		mockFetchWorkspaces.mockReset();
		mockReadLocalActivity.mockReset();
		mockMergeAndDedup.mockReset();
		mockMergeAndDedup.mockImplementation((local, server) => [...server, ...local]);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("activity command accepts query_activity_feed.activities", async () => {
		const now = new Date().toISOString();
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({
			activities: [
				{
					agent_name: "agent-a",
					event_type: "tool_use",
					tool_name: "Edit",
					tool_input_summary: "src/app.ts",
					occurred_at: now,
				},
			],
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { activityCommand } = await import("../activity.js");
		await activityCommand({ json: true, limit: "5" });

		const printed = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof printed).toBe("string");
		const payload = parseWire(JSON.parse(parseWire(printed, wireString, "test JSON value")), wireObject({ "source": wireString, "events": wireArray(wireRecord(wireUnknown)) }), "test JSON value");
		expect(payload.source).toBe("server");
		expect(payload.events).toHaveLength(1);
		expect(payload.events[0]).toMatchObject({
			agent_name: "agent-a",
			event_type: "tool_use",
			tool_name: "Edit",
		});
	});

	it("activity command preserves legacy query_activity_feed.events support", async () => {
		const now = new Date().toISOString();
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({
			events: [
				{
					agent_name: "agent-legacy",
					event_type: "tool_use",
					tool_name: "Read",
					tool_input_summary: "README.md",
					occurred_at: now,
				},
			],
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { activityCommand } = await import("../activity.js");
		await activityCommand({ json: true, limit: "5" });

		const printed = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof printed).toBe("string");
		const payload = parseWire(JSON.parse(parseWire(printed, wireString, "test JSON value")), wireObject({ "events": wireArray(wireRecord(wireUnknown)) }), "test JSON value");
		expect(payload.events).toHaveLength(1);
		expect(payload.events[0]).toMatchObject({
			agent_name: "agent-legacy",
			tool_name: "Read",
		});
	});

	it("explain command accepts query_activity_feed.activities", async () => {
		const now = new Date().toISOString();
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({
			activities: [
				{
					agent_name: "agent-b",
					event_type: "tool_use",
					tool_name: "Read",
					tool_input_summary: "src/index.ts",
					occurred_at: now,
				},
			],
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { explainCommand } = await import("../explain.js");
		await explainCommand({ json: true, since: "1h" });

		const printed = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof printed).toBe("string");
		const payload = parseWire(JSON.parse(parseWire(printed, wireString, "test JSON value")), wireObject({ "source": wireString, "timeline": wireArray(wireRecord(wireUnknown)) }), "test JSON value");
		expect(payload.source).toBe("merged");
		expect(payload.timeline).toHaveLength(1);
		expect(payload.timeline[0]).toMatchObject({
			agent: "agent-b",
			type: "activity",
		});
	});

	it("explain agent filter matches server-only agent_name fields", async () => {
		const now = new Date().toISOString();
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({
			activities: [
				{
					agent_name: "agent-server-only",
					event_type: "tool_use",
					tool_name: "Read",
					tool_input_summary: "src/server.ts",
					occurred_at: now,
				},
			],
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { explainCommand } = await import("../explain.js");
		await explainCommand({ json: true, since: "1h", agent: "agent-server-only" });

		const printed = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof printed).toBe("string");
		const payload = parseWire(JSON.parse(parseWire(printed, wireString, "test JSON value")), wireObject({ "timeline": wireArray(wireObject({ "agent": wireString })) }), "test JSON value");
		expect(payload.timeline).toHaveLength(1);
		expect(payload.timeline[0]?.agent).toBe("agent-server-only");
	});
});

describe("Workspace switch regressions", () => {
	let tempDirCounter = 0;
	const tempDirSuffix = (): string => `${process.pid}-${++tempDirCounter}`;
	// SPY, not process.chdir(): chdir THROWS in a worker thread
	// ("process.chdir() is not supported in workers"), and Stryker's vitest
	// runner pins its own pool, so a real chdir here fails the mutation dry
	// run for any file whose graph-selected test scope includes this one.
	// config.ts resolves paths via `cwd: string = process.cwd()` default
	// params, so the spy exercises the same path.
	let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

	afterEach(() => {
		cwdSpy?.mockRestore();
		vi.restoreAllMocks();
	});

	it("updates active server workspace_id when servers map exists", async () => {
		const tempDir = join(tmpdir(), `cli-workspace-switch-${tempDirSuffix()}`);
		mkdirSync(join(tempDir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tempDir, ".interlinked", "config.local.json"),
			`${JSON.stringify(
				{
					active_server: "production",
					workspace_id: "ws_old_top",
					servers: {
						production: {
							server_url: "https://prod.example.com",
							workspace_id: "ws_old_prod",
						},
						local: {
							server_url: "http://localhost:8787",
							workspace_id: "ws_local",
						},
					},
				},
				null,
				4,
			)}\n`,
		);
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
		mockFetchWorkspaces.mockResolvedValue([{ id: "ws_new" }, { id: "ws_local" }]);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { workspaceSwitchCommand } = await import("../workspace.js");
		await workspaceSwitchCommand("ws_new");

		const updated = parseWire(JSON.parse(
			readFileSync(join(tempDir, ".interlinked", "config.local.json"), "utf-8"),
		), wireObject({ "workspace_id": wireAbsentOptional(wireOptional(wireString)), "servers": wireAbsentOptional(wireOptional(wireRecord(wireObject({ "workspace_id": wireAbsentOptional(wireOptional(wireString)) })))) }), "test JSON value");
		expect(updated.workspace_id).toBe("ws_new");
		expect(updated.servers?.production?.workspace_id).toBe("ws_new");
		expect(updated.servers?.local?.workspace_id).toBe("ws_local");

		logSpy.mockRestore();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("falls back to top-level workspace_id when no servers map exists", async () => {
		const tempDir = join(tmpdir(), `cli-workspace-switch-${tempDirSuffix()}`);
		mkdirSync(join(tempDir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tempDir, ".interlinked", "config.local.json"),
			`${JSON.stringify({ workspace_id: "ws_old" }, null, 4)}\n`,
		);
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
		mockFetchWorkspaces.mockResolvedValue([{ id: "ws_newtop" }]);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { workspaceSwitchCommand } = await import("../workspace.js");
		await workspaceSwitchCommand("ws_newtop");

		const updated = parseWire(JSON.parse(
			readFileSync(join(tempDir, ".interlinked", "config.local.json"), "utf-8"),
		), wireObject({ "workspace_id": wireAbsentOptional(wireOptional(wireString)) }), "test JSON value");
		expect(updated.workspace_id).toBe("ws_newtop");

		logSpy.mockRestore();
		rmSync(tempDir, { recursive: true, force: true });
	});
});
