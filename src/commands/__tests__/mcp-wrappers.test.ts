import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================
// Response shape interface
// ===========================================

interface TaskCreateOutput {
	task?: { id?: number };
	created_by?: string;
}

// ===========================================
// Mocks — hoist mock fns so they're accessible below
// ===========================================

const { mockCallTool, mockIsAuthenticated, mockIsLocalDevServer, mockGetConfig } = vi.hoisted(
	() => ({
		mockCallTool: vi.fn(),
		mockIsAuthenticated: vi.fn().mockReturnValue(true),
		mockIsLocalDevServer: vi.fn().mockReturnValue(false),
		mockGetConfig: vi.fn().mockReturnValue({
			server_url: "https://test.example.com",
			agent_name: "agent-default",
		}),
	}),
);

// Mock api-client module
vi.mock("../../lib/api-client.js", () => ({
	getClient: () => ({
		callTool: mockCallTool,
		isAuthenticated: mockIsAuthenticated,
		isLocalDevServer: mockIsLocalDevServer,
		getConfig: mockGetConfig,
	}),
	InterlinkedClient: vi.fn(),
}));

beforeEach(() => {
	vi.clearAllMocks();
	mockIsAuthenticated.mockReturnValue(true);
	mockIsLocalDevServer.mockReturnValue(false);
	mockGetConfig.mockReturnValue({
		server_url: "https://test.example.com",
		agent_name: "agent-default",
	});
	// Suppress console output during tests
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Parse the last console.log call as JSON with runtime validation. */
function lastLogAsJson<T>(validate: (v: unknown) => v is T): T {
	const raw = vi.mocked(console.log).mock.calls.at(-1)?.[0];
	if (typeof raw !== "string") {
		throw new Error(`Expected last console.log arg to be a string, got ${typeof raw}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (_e) {
		throw new Error(`Failed to parse console.log output as JSON: ${raw}`);
	}
	if (!validate(parsed)) {
		throw new Error(`Parsed JSON did not match expected shape: ${raw}`);
	}
	return parsed;
}

function isTaskCreateOutput(v: unknown): v is TaskCreateOutput {
	return v !== null && typeof v === "object";
}

describe("inbox command", () => {
	it("calls fetch_inbox with correct args", async () => {
		mockCallTool.mockResolvedValue({ messages: [] });

		const { inboxCommand } = await import("../inbox.js");
		await inboxCommand({ json: true });

		expect(mockCallTool).toHaveBeenCalledWith("fetch_inbox", {
			agent_name: "agent-default",
			unread_only: true,
		});
	});

	it("passes --all as unread_only: false", async () => {
		mockCallTool.mockResolvedValue({ messages: [] });

		const { inboxCommand } = await import("../inbox.js");
		await inboxCommand({ all: true, json: true });

		expect(mockCallTool).toHaveBeenCalledWith(
			"fetch_inbox",
			expect.objectContaining({
				agent_name: "agent-default",
				unread_only: false,
			}),
		);
	});

	it("handles unauthenticated state", async () => {
		mockIsAuthenticated.mockReturnValue(false);

		const { inboxCommand } = await import("../inbox.js");
		await inboxCommand({ json: true });

		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("allows unauthenticated state on localhost dev server", async () => {
		mockIsAuthenticated.mockReturnValue(false);
		mockIsLocalDevServer.mockReturnValue(true);
		mockCallTool.mockResolvedValue({ messages: [] });

		const { inboxCommand } = await import("../inbox.js");
		await inboxCommand({ json: true });

		expect(mockCallTool).toHaveBeenCalledWith("fetch_inbox", {
			agent_name: "agent-default",
			unread_only: true,
		});
	});

	it("handles server error gracefully", async () => {
		mockCallTool.mockRejectedValue(new Error("Connection refused"));

		const { inboxCommand } = await import("../inbox.js");
		await inboxCommand({ json: true });

		expect(console.error).toHaveBeenCalledWith(
			JSON.stringify(
				{
					error: "Server error: Connection refused",
					details: { hint: "Is the Server reachable?" },
				},
				null,
				2,
			),
		);
	});

	it("fails fast when no agent identity is configured", async () => {
		mockGetConfig.mockReturnValue({ server_url: "https://test.example.com" });

		const { inboxCommand } = await import("../inbox.js");
		await inboxCommand({ json: true });

		expect(mockCallTool).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(
			JSON.stringify(
				{
					error:
						"Server error: agent_name is required. Set it with 'interlinked enable --agent <name>' or pass --agent.",
					details: { hint: "Is the Server reachable?" },
				},
				null,
				2,
			),
		);
	});
});

describe("send command", () => {
	it("calls send_message with correct args", async () => {
		mockCallTool.mockResolvedValue({ sent: true });

		const { sendCommand } = await import("../send.js");
		await sendCommand("agent-1", "Hello!", { json: true });

		expect(mockCallTool).toHaveBeenCalledWith("send_message", {
			sender_name: "agent-default",
			to: ["agent-1"],
			body_md: "Hello!",
			importance: "normal",
		});
	});

	it("rejects empty message body", async () => {
		const { sendCommand } = await import("../send.js");
		await sendCommand("agent-1", "", { json: true });

		expect(mockCallTool).not.toHaveBeenCalled();
	});
});

describe("tasks list command", () => {
	it("calls list_tasks", async () => {
		mockCallTool.mockResolvedValue({ tasks: [] });

		const { tasksListCommand } = await import("../tasks.js");
		await tasksListCommand({ json: true });

		expect(mockCallTool).toHaveBeenCalledWith("list_tasks", {});
	});

	it("passes status filter", async () => {
		mockCallTool.mockResolvedValue({ tasks: [] });

		const { tasksListCommand } = await import("../tasks.js");
		await tasksListCommand({ status: "pending", json: true });

		expect(mockCallTool).toHaveBeenCalledWith("list_tasks", { status: "pending" });
	});

	it("maps assignee and priority filters to MCP args", async () => {
		mockCallTool.mockResolvedValue({ tasks: [] });

		const { tasksListCommand } = await import("../tasks.js");
		await tasksListCommand({ assignee: "worker-1", priority: "high", json: true });

		expect(mockCallTool).toHaveBeenCalledWith("list_tasks", {
			assignee_name: "worker-1",
			priority: "high",
		});
	});

	it("allows localhost dev mode without auth token", async () => {
		mockIsAuthenticated.mockReturnValue(false);
		mockIsLocalDevServer.mockReturnValue(true);
		mockCallTool.mockResolvedValue({ tasks: [] });

		const { tasksListCommand } = await import("../tasks.js");
		await tasksListCommand({ json: true });

		expect(mockCallTool).toHaveBeenCalledWith("list_tasks", {});
	});
});

describe("tasks create command", () => {
	it("calls create_task with title", async () => {
		mockCallTool.mockResolvedValue({ task: { id: 1, title: "Test task" } });

		const { tasksCreateCommand } = await import("../tasks.js");
		await tasksCreateCommand("Test task", { json: true });

		expect(mockCallTool).toHaveBeenCalledWith("create_task", {
			title: "Test task",
			creator_name: "agent-default",
		});
	});

	it("preserves raw JSON response shape", async () => {
		mockCallTool.mockResolvedValue({
			task: { id: 1, title: "Test task" },
			created_by: "agent-default",
		});

		const { tasksCreateCommand } = await import("../tasks.js");
		await tasksCreateCommand("Test task", { json: true });

		const payload = lastLogAsJson(isTaskCreateOutput);
		expect(payload.task?.id).toBe(1);
		expect(payload.created_by).toBe("agent-default");
	});

	it("fails fast when creator agent identity is not configured", async () => {
		mockGetConfig.mockReturnValue({ server_url: "https://test.example.com" });

		const { tasksCreateCommand } = await import("../tasks.js");
		await tasksCreateCommand("Test task", { json: true });

		expect(mockCallTool).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(
			JSON.stringify(
				{
					error:
						"Server error: agent_name is required for task creation. Set it with 'interlinked enable --agent <name>'.",
				},
				null,
				2,
			),
		);
	});
});

describe("tasks show command", () => {
	it("calls get_task with id", async () => {
		mockCallTool.mockResolvedValue({ id: 42, title: "Test" });

		const { tasksShowCommand } = await import("../tasks.js");
		await tasksShowCommand("42", { json: true });

		expect(mockCallTool).toHaveBeenCalledWith("get_task", { task_id: 42 });
	});
});

describe("tasks claim command", () => {
	it("calls claim_task with id", async () => {
		mockCallTool.mockResolvedValue({ claimed: true });

		const { tasksClaimCommand } = await import("../tasks.js");
		await tasksClaimCommand("5", { json: true });

		expect(mockCallTool).toHaveBeenCalledWith("claim_task", {
			task_id: 5,
			agent_name: "agent-default",
		});
	});
});

describe("tasks complete command", () => {
	it("calls update_task_status with completed", async () => {
		mockCallTool.mockResolvedValue({ updated: true });

		const { tasksCompleteCommand } = await import("../tasks.js");
		await tasksCompleteCommand("5", { json: true });

		expect(mockCallTool).toHaveBeenCalledWith("update_task_status", {
			task_id: 5,
			agent_name: "agent-default",
			status: "completed",
		});
	});
});

describe("handoff command", () => {
	it("orchestrates context fetch + message send", async () => {
		mockCallTool
			.mockResolvedValueOnce({ tasks: [], messages: [] }) // get_work_context
			.mockResolvedValueOnce({ sent: true }); // send_message

		const { handoffCommand } = await import("../handoff.js");
		await handoffCommand("agent-1", "agent-2", { json: true });

		expect(mockCallTool).toHaveBeenCalledWith(
			"get_work_context",
			expect.objectContaining({ agent_name: "agent-1" }),
		);
		expect(mockCallTool).toHaveBeenCalledWith(
			"send_message",
			expect.objectContaining({
				to: ["agent-2"],
				importance: "urgent",
			}),
		);
	});

	it("handles unauthenticated state", async () => {
		mockIsAuthenticated.mockReturnValue(false);

		const { handoffCommand } = await import("../handoff.js");
		await handoffCommand("agent-1", "agent-2", { json: true });

		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("allows localhost dev mode without auth token", async () => {
		mockIsAuthenticated.mockReturnValue(false);
		mockIsLocalDevServer.mockReturnValue(true);
		mockCallTool
			.mockResolvedValueOnce({ tasks: [], messages: [] })
			.mockResolvedValueOnce({ sent: true });

		const { handoffCommand } = await import("../handoff.js");
		await handoffCommand("agent-1", "agent-2", { json: true });

		expect(mockCallTool).toHaveBeenCalledWith(
			"send_message",
			expect.objectContaining({ to: ["agent-2"] }),
		);
	});
});
